#!/usr/bin/env python
"""Offline stand-in for FFmpeg used by the export tests.

It implements only the two call shapes exporter.py uses:

1) video recording:  -f rawvideo ... -s WxH -r FPS -i - ... tmp_video.mp4
   Reads the raw RGB frames from stdin and writes a JSON report to the
   (temporary) video path instead of a real mp4.

2) muxing:           -i video -i audio... -i chapters -map ... final.mp4
   Reads the video report, the chapter metadata and the audio inputs and
   writes a JSON report to the final path.

Every detail the tests assert on (frame count, chapter timing, which audio
files were actually concatenated) is therefore observable without a real
encoder.
"""
import json
import os
import sys


def _parse(argv):
    out = {"inputs": [], "output": None}
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "-i":
            i += 1
            out["inputs"].append({"path": argv[i], "format": out.get("format"),
                                  "duration": out.get("duration")})
            out["format"] = out["duration"] = None
        elif arg == "-f":
            i += 1
            out["format"] = argv[i]
        elif arg == "-t":
            i += 1
            out["duration"] = float(argv[i])
        elif arg in ("-s", "-r"):
            key = "size" if arg == "-s" else "fps"
            i += 1
            out[key] = argv[i]
        elif arg in ("-map", "-map_metadata", "-map_chapters", "-c:v", "-c:a",
                     "-b:a", "-vf", "-preset", "-crf", "-pix_fmt",
                     "-filter_complex", "-movflags", "-loglevel"):
            i += 1  # option value, not an input
        elif arg.startswith("-") or arg.startswith("["):
            pass
        else:
            out["output"] = arg
        i += 1
    return out


def _read_stdin_frames(width, height, chunk=1 << 20):
    frame_bytes = width * height * 3
    total = 0
    stdin = sys.stdin.buffer
    while True:
        data = stdin.read(chunk)
        if not data:
            break
        total += len(data)
    if frame_bytes and total % frame_bytes:
        raise SystemExit(f"partial frame written: {total} bytes")
    return total // frame_bytes if frame_bytes else 0


def _record(opts):
    width, height = (int(v) for v in opts["size"].split("x"))
    frames = _read_stdin_frames(width, height)
    report = {
        "mode": "video",
        "frames": frames,
        "fps": int(opts["fps"]),
        "size": [width, height],
    }
    with open(opts["output"], "w", encoding="utf-8") as f:
        json.dump(report, f)
    return 0


def _parse_meta(path):
    chapters, current, header = [], None, False
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if line.startswith(";"):
                header = header or line.startswith(";FFMETADATA1")
                continue
            if line == "[CHAPTER]":
                current = {}
                chapters.append(current)
                continue
            if current is not None and "=" in line:
                key, value = line.split("=", 1)
                if key in ("START", "END"):
                    current[key] = int(value)
                elif key == "title":
                    current[key] = value
    if not header:
        raise SystemExit("missing FFMETADATA1 header")
    return [
        {"start_ms": c.get("START"), "end_ms": c.get("END"),
         "title": c.get("title", "")}
        for c in chapters
    ]


def _mux(opts):
    video_report, audio_inputs, meta = None, [], None
    for entry in opts["inputs"]:
        path = entry["path"]
        if path == "-":
            continue
        if path.startswith("anullsrc="):
            audio_inputs.append({"kind": "silence",
                                 "duration": entry.get("duration"),
                                 "exists": True})
            continue
        if not os.path.isfile(path):
            raise SystemExit(f"input file missing: {path}")
        with open(path, encoding="utf-8", errors="replace") as f:
            head = f.read(64)
        if head.startswith(";FFMETADATA1"):
            meta = _parse_meta(path)
            continue
        if path.endswith(".json") or head.startswith("{"):
            with open(path, encoding="utf-8") as f:
                video_report = json.load(f)
            continue
        audio_inputs.append({"kind": "file", "path": os.path.abspath(path),
                             "size": os.path.getsize(path), "exists": True})

    if video_report is None:
        raise SystemExit("video input missing")
    if meta is None:
        raise SystemExit("chapter metadata missing")
    if not audio_inputs:
        raise SystemExit("no audio inputs")

    report = {
        "mode": "mux",
        "video_frames": video_report["frames"],
        "fps": video_report["fps"],
        "audio_inputs": audio_inputs,
        "chapters": meta,
        "output": opts["output"],
    }
    with open(opts["output"], "w", encoding="utf-8") as f:
        json.dump(report, f)
    return 0


def main(argv):
    opts = _parse(argv)
    if opts["output"] is None:
        print("fake ffmpeg: no output", file=sys.stderr)
        return 2
    if any(entry["path"] == "-" for entry in opts["inputs"]):
        return _record(opts)
    return _mux(opts)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
