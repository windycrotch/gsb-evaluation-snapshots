# This copyright notice applies to this file only
#
# SPDX-FileCopyrightText: Copyright (c) 2024 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: MIT
#
# Permission is hereby granted, free of charge, to any person obtaining a
# copy of this software and associated documentation files (the "Software"),
# to deal in the Software without restriction, including without limitation
# the rights to use, copy, modify, merge, publish, distribute, sublicense,
# and/or sell copies of the Software, and to permit persons to whom the
# Software is furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL
# THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
# FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
# DEALINGS IN THE SOFTWARE.

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

# Make ``common`` importable both when run as a script (from this directory)
# and when imported as a module (from the repository root).
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.append(str(_REPO_ROOT))

from transcode_video.hw_backend import get_backend  # noqa: E402


class _AtomicOutput:
    """Output file lifecycle with temp-file staging and atomic replacement.

    All encoded bytes are written to a unique temporary file in the destination
    directory.  The destination path is only touched via :func:`os.replace`
    once the transcode has fully succeeded, so:

    * a failure mid-stream never leaves a half-written file at the destination
      (the temp file is closed and deleted on rollback);
    * two concurrent jobs targeting the same path cannot interleave their
      bitstreams - each writes its own temp file and the final replacement is
      atomic, so one complete file wins while the other job either also
      replaces it or fails explicitly; it can never produce a spliced stream.
    """

    def __init__(self, out_file_path):
        self.destination = os.fspath(out_file_path)
        self._directory = os.path.dirname(os.path.abspath(self.destination))
        os.makedirs(self._directory, exist_ok=True)
        # pid + random suffix keeps names unique across processes and threads.
        fd, self.temp_path = tempfile.mkstemp(
            prefix=".transcode-%d-" % os.getpid(),
            suffix=".tmp",
            dir=self._directory)
        self._handle = os.fdopen(fd, "wb")
        self._closed = False
        self._committed = False

    def write(self, data):
        if self._closed:
            raise ValueError("Output file is already closed")
        self._handle.write(data)

    def commit(self):
        """Flush, close and atomically move the temp file into place."""
        if self._committed:
            return
        try:
            self._handle.flush()
            os.fsync(self._handle.fileno())
            self._handle.close()
            self._closed = True
            os.replace(self.temp_path, self.destination)
            self._committed = True
        except Exception:
            # A failed finalize must still clean up the staged bytes instead
            # of leaking an open temp file.
            self.rollback()
            raise

    def rollback(self):
        """Close and remove the staged file; the destination is untouched."""
        if not self._closed:
            try:
                self._handle.close()
            finally:
                self._closed = True
        if not self._committed and os.path.exists(self.temp_path):
            try:
                os.remove(self.temp_path)
            except OSError:
                # On Windows a stale handle can delay deletion; a leftover
                # temp file is still clearly distinguishable from a valid
                # output and never appears at the destination path.
                pass

    @property
    def committed(self):
        return self._committed

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self.commit()
        else:
            self.rollback()
        return False


def build_config(config_file="", codec=None, preset=None):
    """Merge JSON base options with explicit command-line overrides.

    Precedence (highest first):

    1. ``codec`` / ``preset`` explicitly supplied on the command line override
       the same-named JSON fields;
    2. every other field present in the JSON config is preserved unchanged;
    3. without a JSON config the result matches the historical CLI behaviour
       (``{"preset": <PRESET or "">, "codec": <codec>}``).

    Parameters use ``None`` to mean "not supplied on the command line", which is
    distinct from an empty string so callers can tell an explicit empty preset
    from an omitted one.
    """
    config = {}
    if config_file:
        with open(config_file, encoding="utf-8") as json_file:
            config = json.loads(json_file.read())
        if not isinstance(config, dict):
            raise ValueError("JSON config %s must contain an object"
                             % config_file)

    if codec is not None:
        config["codec"] = str(codec).lower()
    if preset is not None:
        config["preset"] = str(preset).upper()

    if not config_file:
        # Historical behaviour: the CLI always produced both keys, with an
        # empty/uppercase preset even when -p was omitted.
        config.setdefault("codec", codec.lower() if codec else "")
        config.setdefault("preset", (preset or "").upper()
                          if preset is not None else "")
    return config


def transcode(gpu_id, in_file_path, out_file_path, config_params, backend=None):
    """Transcode an input video stream into an elementary bitstream file.

    The input is demuxed and decoded frame by frame; decoded frames are handed
    to the hardware encoder and the resulting bitstream is staged in a unique
    temporary file and atomically moved to ``out_file_path`` on success.

    Parameters:
        - gpu_id (int): Ordinal of GPU to use [parameter not in use]
        - in_file_path (str): path to the file to be decoded
        - out_file_path (str): path of the output elementary bitstream
        - config_params (dict): fine-grained encoder options
        - backend: optional hardware backend (allows offline stub injection);
          defaults to the backend selected by ``TRANSCODE_BACKEND``.

    Returns:
        int: number of frames encoded.  An input that yields no decodable
        frames completes normally with a return value of 0 and leaves a valid
        empty output file instead of crashing.

    Raises:
        Any exception raised while demuxing, decoding, encoding or writing is
        propagated after the staged output has been closed and removed, so no
        half-written result is ever left at ``out_file_path``.
    """
    backend = backend if backend is not None else get_backend()
    config_params = dict(config_params or {})

    # Created before the output file: a demuxer/decoder failure must not leave
    # any artifact at the destination path.
    nv_dmx = backend.create_demuxer(in_file_path)
    nv_dec = backend.create_decoder(gpu_id, nv_dmx.GetNvCodecId(), nv_dmx)

    width = 0
    height = 0
    nv12_frame_size = 0
    input_frame_list = []
    nvenc = None
    frame_cnt = 0

    with _AtomicOutput(out_file_path) as output:
        for packet in nv_dmx:
            for decoded_frame in nv_dec.Decode(packet):
                if nvenc is None:
                    # The encoder is created lazily on the first frame, which
                    # keeps empty/decode-less inputs from ever needing one.
                    width = nv_dec.GetWidth()
                    height = nv_dec.GetHeight()
                    print("width=", width)
                    print("height=", height)
                    nv12_frame_size = nv_dec.GetFrameSize()
                    input_frame_list = [backend.alloc_frame(width, height,
                                                            "NV12")
                                        for _ in range(0, 5)]
                    nvenc = backend.create_encoder(width, height, "NV12",
                                                   config_params)

                luma_base_addr = decoded_frame.GetPtrToPlane(0)
                slot = input_frame_list[frame_cnt % 5]
                backend.memcpy_dtod(slot.gpuAlloc, luma_base_addr,
                                    nv12_frame_size)
                bitstream = bytearray(nvenc.Encode(slot))
                output.write(bitstream)
                frame_cnt += 1

        if nvenc is not None:
            # The flush tail packets are part of the valid output and must be
            # written before the file is closed/replaced.
            bitstream = bytearray(nvenc.EndEncode())
            output.write(bitstream)
        # Normal exit of the with-block commits (flush, fsync, atomic replace).
    print("frame count : ", frame_cnt)
    return frame_cnt


def parse_args(argv=None):
    """Build the CLI argument parser and parse ``argv`` (or ``sys.argv``)."""
    parser = argparse.ArgumentParser(
        "This sample application demonstrates transcoding of an input video "
        "stream."
    )
    parser.add_argument(
        "-g", "--gpu_id", type=int, help="GPU id, check nvidia-smi. Do not use")
    parser.add_argument(
        "-i", "--in_file_path", required=True, type=Path,
        help="Encoded video file (read from)")
    parser.add_argument(
        "-c", "--codec", type=str, required=True,
        help="h264, hevc, av1")
    parser.add_argument(
        "-p", "--preset", type=str, default=None,
        help="P1,P2,P3,P4,P5,P6,P7")
    parser.add_argument(
        "-o", "--out_file_path", required=True, type=Path,
        help="Encoded video file (write to)")
    parser.add_argument(
        "-json", "--config_file", type=str, default='',
        help="path of json config file")
    return parser.parse_args(argv)


def main(argv=None):
    """CLI entry point. Returns a process exit code (0 on success)."""
    args = parse_args(argv)
    # None means the flag was omitted; build_config applies the documented
    # JSON-base / CLI-override precedence.
    config = build_config(args.config_file,
                          codec=args.codec,
                          preset=args.preset)
    try:
        transcode(args.gpu_id,
                  args.in_file_path.as_posix(),
                  args.out_file_path.as_posix(),
                  config)
    except Exception as exc:
        # The output lifecycle has already cleaned up the staged file; surface
        # the failure explicitly instead of pretending success.
        print("transcode failed: %s" % exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
