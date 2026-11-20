"""Fake ffmpeg used by test/test_video_export_session.py.

Behavior is controlled by an env var FFMPEG_FAKE_MODE set by the test harness:
  success:<seconds>   sleep, then copy the last argv entry (the output file path)
                      from the input file (found via the -i argument) and exit 0.
  fail:<seconds>      sleep, then exit with a non-zero code.
  hang:<seconds>      write a partial output and block until the process is killed.

The compiled shim (shim.c) invokes this script; both live next to the generated
ffmpeg.exe in the external testwork/fakebin directory at test time.
"""
import os
import sys
import time
import shutil


def main() -> int:
    mode = os.environ.get("FFMPEG_FAKE_MODE", "success:0")
    kind, _, param = mode.partition(":")
    delay = float(param or 0)

    argv = sys.argv[1:]
    output = argv[-1] if argv else ""

    try:
        inputIdx = argv.index("-i")
        inputFile = argv[inputIdx + 1]
    except (ValueError, IndexError):
        inputFile = ""

    if kind == "fail":
        time.sleep(delay)
        sys.stderr.write("fake ffmpeg: simulated failure\n")
        return 2

    if kind == "hang":
        # Touch the output so a partial file exists, then block until terminated.
        if output:
            with open(output, "wb") as fh:
                fh.write(b"partial")
        while True:
            time.sleep(1)

    # success
    time.sleep(delay)
    if inputFile and os.path.exists(inputFile):
        shutil.copyfile(inputFile, output)
    else:
        with open(output, "wb") as fh:
            fh.write(b"fake output")
    return 0


if __name__ == "__main__":
    sys.exit(main())
