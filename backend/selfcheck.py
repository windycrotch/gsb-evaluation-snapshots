import shutil

import essentia  # noqa: F401
import fastapi  # noqa: F401
import librosa  # noqa: F401
import soundfile  # noqa: F401
import torch


def main() -> None:
    print("backend imports ok")
    print(f"torch {torch.__version__}")
    print(f"ffmpeg {shutil.which('ffmpeg') or 'missing'}")
    print(f"rubberband {shutil.which('rubberband') or 'missing'}")
    print(f"aubiotrack {shutil.which('aubiotrack') or 'missing'}")

    try:
        import demucs  # noqa: F401

        print(f"demucs {demucs.__version__} (vocal-stem analysis available)")
    except Exception as exc:
        print(f"demucs missing: {exc}")


if __name__ == "__main__":
    main()
