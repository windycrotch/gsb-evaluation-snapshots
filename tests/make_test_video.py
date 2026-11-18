"""Deterministic test clip generation for the TkinterVideo tests.

The clip is generated locally with PyAV so the tests do not depend on any
downloaded media. Each second of the clip is a solid, distinct colour, which
lets the tests verify *which* frame is on screen without any pixel guessing:

    second 0 -> red, second 1 -> green, second 2 -> blue, second 3 -> yellow

Usage::

    python tests/make_test_video.py [output.mp4] [--seconds 4] [--fps 10]
"""

import argparse
import os

import av
from PIL import Image

# One colour per second, in R, G, B, Y order.
SECOND_COLORS = [
    (220, 40, 40),    # 0s red
    (40, 200, 60),    # 1s green
    (40, 60, 220),    # 2s blue
    (225, 215, 40),   # 3s yellow
    (200, 60, 200),   # 4s magenta
    (40, 200, 200),   # 5s cyan
]

DEFAULT_SIZE = (64, 48)


def generate_video(path, seconds=4, fps=10, size=DEFAULT_SIZE):
    """Writes a silent H.264-like MP4 where every second has a unique colour.

    Returns the path of the generated file.
    """

    if seconds > len(SECOND_COLORS):
        raise ValueError("increase SECOND_COLORS to generate a longer clip")

    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)

    # The mpeg4 encoder ships with the ffmpeg wheels that PyAV depends on, so
    # it is the most portable choice for a locally generated fixture.
    with av.open(path, mode="w") as container:
        stream = container.add_stream("mpeg4", rate=fps)
        stream.width, stream.height = size
        stream.pix_fmt = "yuv420p"

        total_frames = seconds * fps
        for index in range(total_frames):
            second = min(index // fps, len(SECOND_COLORS) - 1)
            image = Image.new("RGB", size, SECOND_COLORS[second])
            frame = av.VideoFrame.from_image(image)
            frame.pts = index
            for packet in stream.encode(frame):
                container.mux(packet)

        for packet in stream.encode():
            container.mux(packet)

    return path


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", nargs="?", default=os.path.join(os.path.dirname(__file__), "test_video.mp4"))
    parser.add_argument("--seconds", type=int, default=4)
    parser.add_argument("--fps", type=int, default=10)
    args = parser.parse_args(argv)

    path = generate_video(args.output, seconds=args.seconds, fps=args.fps)
    print(f"wrote {path} ({args.seconds}s @ {args.fps}fps)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
