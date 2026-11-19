import struct
import sys
import wave
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def write_wav(path, seconds, freq=440, rate=8000):
    """Small real WAV file so the fake FFmpeg can check readability."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = max(1, int(seconds * rate))
    data = bytearray()
    for i in range(frames):
        # cheap square-ish tone; content is irrelevant for the export timeline
        value = 12000 if (i // 40) % 2 else -12000
        data += struct.pack("<h", value)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(data))
    return path
