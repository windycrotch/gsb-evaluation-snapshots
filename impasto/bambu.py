"""Loading Bambu Studio output: plain .gcode or sliced .gcode.3mf.

A job keeps the original G-code text untouched; everything we add is inserted
later as a separate block (see merge.py).
"""
from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from .i18n import t as T

PLATE_RE = re.compile(r"^Metadata/plate_(\d+)\.gcode$")


@dataclass
class Job:
    lines: list[str]                      # original G-code lines (without newline)
    config: dict[str, str]                # CONFIG_BLOCK key -> raw value
    header: dict[str, str]                # HEADER_BLOCK "key: value"
    source_kind: str                      # "gcode" | "3mf"
    plate: int = 1
    threemf_bytes: bytes | None = None    # original archive (for re-packaging)
    newline: str = "\n"
    exec_start: int = 0                   # index of "; EXECUTABLE_BLOCK_START"
    exec_end: int = 0                     # index of "; EXECUTABLE_BLOCK_END"
    end_gcode_start: int = 0              # index of "; MACHINE_END_GCODE_START" (or best guess)
    insert_at: int = 0                    # index where the non-planar block is inserted

    # ----- config helpers -------------------------------------------------
    def raw(self, key: str, default: str = "") -> str:
        return self.config.get(key, default)

    def strings(self, key: str) -> list[str]:
        v = self.config.get(key, "")
        if ";" in v:
            parts = v.split(";")
        else:
            parts = v.split(",")
        return [p.strip().strip('"') for p in parts]

    def floats(self, key: str, default: float = 0.0) -> list[float]:
        out = []
        for p in self.strings(key):
            p = p.rstrip("%")
            try:
                out.append(float(p))
            except ValueError:
                out.append(default)
        return out

    def float_at(self, key: str, idx: int, default: float = 0.0) -> float:
        vals = self.floats(key, default)
        if not vals:
            return default
        return vals[idx] if idx < len(vals) else vals[0]

    def template(self, key: str) -> str:
        """Multi-line custom G-code stored with literal \\n in the config block."""
        v = self.config.get(key, "")
        if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
            v = v[1:-1]
        return v.replace("\\n", "\n").replace('\\"', '"')

    @property
    def n_filaments(self) -> int:
        return len(self.strings("filament_colour"))


def list_plates(data: bytes) -> list[int]:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        plates = sorted(int(m.group(1)) for n in zf.namelist() if (m := PLATE_RE.match(n)))
    return plates


def load_bytes(data: bytes, filename: str, plate: int | None = None) -> Job:
    if data[:2] == b"PK":
        plates = list_plates(data)
        if not plates:
            raise ValueError(T("error.3mf_no_gcode"))
        if plate is None:
            plate = plates[0]
        if plate not in plates:
            raise ValueError(T("error.plate_missing", plate=plate, plates=plates))
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            text = zf.read(f"Metadata/plate_{plate}.gcode").decode("utf-8", errors="replace")
        job = _from_text(text, "3mf")
        job.plate = plate
        job.threemf_bytes = data
        return job
    text = data.decode("utf-8", errors="replace")
    return _from_text(text, "gcode")


def load_path(path: str | Path, plate: int | None = None) -> Job:
    p = Path(path)
    return load_bytes(p.read_bytes(), p.name, plate)


def _from_text(text: str, kind: str) -> Job:
    newline = "\r\n" if "\r\n" in text[:5000] else "\n"
    lines = text.split(newline)
    if lines and lines[-1] == "":
        lines.pop()
    config: dict[str, str] = {}
    header: dict[str, str] = {}
    exec_start = exec_end = end_start = -1
    in_cfg = in_hdr = False
    for i, ln in enumerate(lines):
        if not ln.startswith(";"):
            continue
        if ln.startswith("; HEADER_BLOCK_START"):
            in_hdr = True
            continue
        if ln.startswith("; HEADER_BLOCK_END"):
            in_hdr = False
            continue
        if ln.startswith("; CONFIG_BLOCK_START"):
            in_cfg = True
            continue
        if ln.startswith("; CONFIG_BLOCK_END"):
            in_cfg = False
            continue
        if ln.startswith("; EXECUTABLE_BLOCK_START"):
            exec_start = i
        elif ln.startswith("; EXECUTABLE_BLOCK_END"):
            exec_end = i
        elif ln.startswith("; MACHINE_END_GCODE_START"):
            end_start = i
        if in_cfg:
            body = ln[2:] if ln.startswith("; ") else ln[1:]
            k, sep, v = body.partition(" = ")
            if sep:
                config[k.strip()] = v
            elif body.endswith(" ="):
                config[body[:-2].strip()] = ""
        elif in_hdr:
            body = ln[2:]
            k, sep, v = body.partition(":")
            if sep:
                header[k.strip()] = v.strip()
    if exec_start < 0:
        exec_start = 0
    if exec_end < 0:
        exec_end = len(lines)
    if end_start < 0:
        end_start = _guess_end_start(lines, exec_end)
    job = Job(lines=lines, config=config, header=header, source_kind=kind, newline=newline,
              exec_start=exec_start, exec_end=exec_end, end_gcode_start=end_start)
    job.insert_at = _find_insert_point(lines, end_start)
    return job


def _guess_end_start(lines: list[str], exec_end: int) -> int:
    # Fallback for G-code without the Bambu marker: last "; CHANGE_LAYER" -> after last extrusion.
    last_ext = exec_end
    for i in range(exec_end - 1, 0, -1):
        ln = lines[i]
        if ln.startswith("G1") and " E" in ln and " X" in ln and " E-" not in ln:
            last_ext = i + 1
            break
    return last_ext


def _find_insert_point(lines: list[str], end_start: int) -> int:
    """Insert before Bambu's 'close powerlost recovery' / 'FEATURE: Custom' preamble of the end G-code,
    so power-loss recovery, spaghetti detection and fans are still active while we print."""
    i = end_start
    lo = max(0, end_start - 15)
    best = end_start
    for j in range(end_start - 1, lo, -1):
        s = lines[j].strip()
        if s.startswith("; close powerlost recovery"):
            best = j
            break
        if s.startswith("; FEATURE: Custom") and best == end_start:
            best = j
    return best if best <= i else i
