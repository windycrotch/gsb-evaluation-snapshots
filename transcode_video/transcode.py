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
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
# THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
# FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
# DEALINGS IN THE SOFTWARE.

import sys
import json
import argparse
from pathlib import Path

# Make the repository root importable regardless of the current working
# directory, so `common` is always found.
sys.path.append(str(Path(__file__).resolve().parent.parent))

from common.nvcodec_utils import (  # noqa: E402
    merge_encoder_config,
    validate_encoder_config,
    nvVideoEncoder,
)

DEFAULT_FPS = 30
FRAME_POOL_SIZE = 5


def transcode(gpu_id, in_file_path, out_file_path, config_params,
              *, demuxer_factory=None, decoder_factory=None,
              encoder_factory=None, container_factory=None,
              packet_factory=None, frame_pool_factory=None,
              frame_copier=None):
    """
                    This function demonstrates transcoding of an input video stream.

                    Parameters:
                        - gpu_id (int): Ordinal of GPU to use [Parameter not in use]
                        - in_file_path (str): Path to
                    file to be decoded
                        - out_file_path (str): Path to output file into which the
                    encoded stream is stored
                        - config_params(key value pairs) : key value pairs providing
                    fine-grained control on encoding. Must contain a valid "codec"
                    and "preset" (see merge_encoder_config/validate_encoder_config);
                    all remaining keys are forwarded to the encoder.
                        - demuxer_factory / decoder_factory / encoder_factory /
                    container_factory / packet_factory / frame_pool_factory /
                    frame_copier: optional callables used to inject fakes in
                    tests. When omitted, the real PyNvVideoCodec/pycuda
                    implementations are used.

                    Returns: - Number of decoded frames that were encoded.

                    Example:
                    >>> transcode(0, "path/to/input/video/file",
                    ...           "path/to/output/video/file",
                    ...           {"codec": "h264", "preset": "P4"})
    """
    # Validate the fully merged configuration up front: an unsupported codec
    # or preset must fail before the output file is ever opened, so a bad
    # configuration never produces an empty output file.
    config = dict(config_params) if config_params else {}
    config.setdefault("preset", "P4")
    config = validate_encoder_config(merge_encoder_config(config))

    # The real hardware dependencies are imported lazily so this module stays
    # importable on machines without a GPU (e.g. offline test hosts).
    if (demuxer_factory is None or decoder_factory is None
            or frame_pool_factory is None or frame_copier is None):
        import pycuda.driver as cuda
        import PyNvVideoCodec as nvc
        from common.nvc_utils import AppFrame

        if demuxer_factory is None:
            demuxer_factory = lambda filename: nvc.CreateDemuxer(filename=filename)  # noqa: E731
        if decoder_factory is None:
            decoder_factory = lambda **kwargs: nvc.CreateDecoder(**kwargs)  # noqa: E731
        if frame_pool_factory is None:
            frame_pool_factory = lambda w, h, fmt, n: [  # noqa: E731
                AppFrame(w, h, fmt) for _ in range(n)
            ]
        if frame_copier is None:
            frame_copier = lambda dst, src, size: cuda.memcpy_dtod(dst, src, size)  # noqa: E731

    nv_dmx = demuxer_factory(in_file_path)
    nv_dec = decoder_factory(gpuid=gpu_id or 0,
                             codec=nv_dmx.GetNvCodecId(),
                             cudacontext=0,
                             cudastream=0,
                             usedevicememory=True)

    fps = DEFAULT_FPS
    get_fps = getattr(nv_dmx, "FrameRate", None)
    if callable(get_fps):
        try:
            fps = get_fps() or DEFAULT_FPS
        except Exception:
            fps = DEFAULT_FPS

    # A fresh encoder (with fresh timestamps) is created for every transcode
    # call, so repeated transcoding of the same input in one process never
    # reuses state from a previous run.
    encoder = None
    frame_cnt = 0
    try:
        for packet in nv_dmx:
            for decoded_frame in nv_dec.Decode(packet):
                if encoder is None:
                    width = nv_dec.GetWidth()
                    height = nv_dec.GetHeight()
                    print("width=", width)
                    print("height=", height)
                    nv12_frame_size = nv_dec.GetFrameSize()
                    frame_pool = frame_pool_factory(width, height, "NV12",
                                                    FRAME_POOL_SIZE)
                    encoder = nvVideoEncoder(
                        gpu_id or 0,
                        width,
                        height,
                        fps,
                        out_file_path,
                        cuda_ctx=None,
                        cuda_stream=None,
                        format="NV12",
                        encoder_config=config,
                        encoder_factory=encoder_factory,
                        container_factory=container_factory,
                        packet_factory=packet_factory,
                    )
                slot = frame_cnt % len(frame_pool)
                luma_base_addr = decoded_frame.GetPtrToPlane(0)
                frame_copier(frame_pool[slot].gpuAlloc, luma_base_addr,
                             nv12_frame_size)
                encoder.encode_from_tensor(frame_pool[slot])
                frame_cnt = frame_cnt + 1

        if encoder is None:
            raise RuntimeError(
                "No frames were decoded from %r; nothing to transcode."
                % (in_file_path,)
            )
        # Flush the encoder so the trailing frames are written to the same
        # output stream before the container is closed.
        encoder.flush()
    except Exception:
        # On any failure (decode, encode or mux), release the encoder and
        # remove the half-written output, then re-raise the original error.
        if encoder is not None:
            encoder.abort()
        raise

    print("frame count : ", frame_cnt)
    return frame_cnt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        'This sample application demonstrates transcoding of an input video stream.'
    )
    parser.add_argument(
        "-g", "--gpu_id", type=int, help="GPU id, check nvidia-smi. Do not use", )
    parser.add_argument(
        "-i", "--in_file_path", required=True, type=Path, help="Encoded video file (read from)", )
    parser.add_argument(
        "-c", "--codec", type=str, required=True, help="h264, hevc, av1")
    parser.add_argument(
        "-p", "--preset", type=str, default='', help="P1,P2,P3,P4,P5,P6,P7")
    parser.add_argument(
        "-o", "--out_file_path", required=True, type=Path, help="Encoded video file (write to)", )
    parser.add_argument(
        "-json", "--config_file", type=str, default='', help="path of json config file", )

    args = parser.parse_args()
    json_config = {}
    if len(args.config_file):
        with open(args.config_file) as jsonFile:
            json_content = jsonFile.read()
        json_config = json.loads(json_content)

    # Explicit command-line codec/preset win over the same-named JSON keys;
    # every other JSON key (bitrate, tuning, ...) is preserved and forwarded
    # to the encoder. Validation happens inside transcode(), before the
    # output file is opened.
    config = merge_encoder_config(json_config,
                                  codec=args.codec,
                                  preset=args.preset or None)

    transcode(args.gpu_id,
              args.in_file_path.as_posix(),
              args.out_file_path.as_posix(),
              config)
