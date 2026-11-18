"""Merge the non-planar block into the original Bambu G-code and repackage (.gcode / .gcode.3mf)."""
from __future__ import annotations

import hashlib
import io
import json
import math
import re
import zipfile
from xml.etree import ElementTree as ET

from .bambu import Job
from .generate import Result

M73_RE = re.compile(r"^M73 P(\d+) R(\d+)\s*$")


def _fmt_time(sec: float) -> str:
    sec = int(round(sec))
    h, r = divmod(sec, 3600)
    m, s = divmod(r, 60)
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


def _parse_time(txt: str) -> float:
    tot = 0.0
    for v, u in re.findall(r"(\d+)\s*([dhms])", txt):
        tot += int(v) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[u]
    return tot


def usage(job: Job, res: Result) -> dict[int, dict]:
    dens = job.floats("filament_density")
    out = {}
    for slot, mm in res.stats["filament_mm"].items():
        vol = res.stats["volume_mm3"].get(slot, 0.0)
        d = dens[slot] if slot < len(dens) else 1.24
        out[int(slot)] = {"mm": mm, "cm3": vol / 1000.0, "g": vol / 1000.0 * d}
    return out


def merged_lines(job: Job, res: Result) -> list[str]:
    lines = list(job.lines)
    extra_s = float(res.stats.get("time_s", 0.0))
    extra_min = int(math.ceil(extra_s / 60.0))
    use = usage(job, res)

    # ---- header ------------------------------------------------------------
    for i in range(min(len(lines), job.exec_start if job.exec_start > 0 else 40)):
        ln = lines[i]
        if ln.startswith("; total layer number:"):
            n = int(re.findall(r"\d+", ln)[0])
            lines[i] = f"; total layer number: {n + 1}"
        elif ln.startswith("; max_z_height:"):
            try:
                z = float(ln.split(":")[1])
            except ValueError:
                z = 0
            lines[i] = f"; max_z_height: {max(z, res.max_z - 1.0):.2f}"
        elif ln.startswith("; model printing time:"):
            m = re.match(r"; model printing time: (.*); total estimated time: (.*)$", ln)
            if m:
                mt = _parse_time(m.group(1)) + extra_s
                tt = _parse_time(m.group(2)) + extra_s
                lines[i] = f"; model printing time: {_fmt_time(mt)}; total estimated time: {_fmt_time(tt)}"
    _patch_header_filaments(job, lines, use)

    # ---- progress M73 -------------------------------------------------------
    total = None
    for i in range(job.exec_start, job.insert_at):
        m = M73_RE.match(lines[i])
        if m:
            total = int(m.group(2)) if total is None else max(total, int(m.group(2)))
    if total is not None:
        new_total = total + extra_min
        for i in range(job.exec_start, job.insert_at):
            m = M73_RE.match(lines[i])
            if m:
                r = int(m.group(2))
                el = total - r
                lines[i] = f"M73 P{int(100 * el / max(new_total, 1))} R{r + extra_min}"

    # ---- end gcode: never come down onto the decoration --------------------
    safe = res.max_z + 0.4
    for i in range(job.insert_at, min(len(lines), job.insert_at + 60)):
        ln = lines[i]
        m = re.match(r"^G[01] Z([\d.]+)(.*)$", ln)
        if m and float(m.group(1)) < safe:
            lines[i] = f"G1 Z{safe:.2f}{m.group(2)} ; raised by Impasto"
        if re.match(r"^G[01] .*[XY]", ln):
            break

    block = res.gcode.rstrip("\n").split("\n")
    if total is not None:
        p = int(100 * total / max(total + extra_min, 1))
        block.insert(1, f"M73 P{p} R{extra_min}")
    return lines[:job.insert_at] + block + lines[job.insert_at:]


def _patch_header_filaments(job: Job, lines: list[str], use: dict[int, dict]):
    idx = {}
    for i in range(min(len(lines), 40)):
        ln = lines[i]
        for key in ("; filament:", "; total filament length [mm] :", "; total filament volume [cm^3] :",
                    "; total filament weight [g] :"):
            if ln.startswith(key):
                idx[key] = i
    if "; filament:" not in idx:
        return
    fl = [int(x) for x in lines[idx["; filament:"]].split(":")[1].split(",") if x.strip()]

    def vals(key):
        if key not in idx:
            return None
        return [float(x) for x in lines[idx[key]].split(":", 1)[1].split(",") if x.strip()]

    L = vals("; total filament length [mm] :")
    V = vals("; total filament volume [cm^3] :")
    G = vals("; total filament weight [g] :")
    table = {}
    for k, f1 in enumerate(fl):
        table[f1] = [L[k] if L and k < len(L) else 0, V[k] if V and k < len(V) else 0, G[k] if G and k < len(G) else 0]
    for slot, u in use.items():
        t = table.setdefault(slot + 1, [0, 0, 0])
        t[0] += u["mm"]
        t[1] += u["cm3"]
        t[2] += u["g"]
    keys = sorted(table)
    lines[idx["; filament:"]] = "; filament: " + ",".join(str(k) for k in keys)
    if L is not None:
        lines[idx["; total filament length [mm] :"]] = "; total filament length [mm] : " + ",".join(f"{table[k][0]:.2f}" for k in keys)
    if V is not None:
        lines[idx["; total filament volume [cm^3] :"]] = "; total filament volume [cm^3] : " + ",".join(f"{table[k][1]:.2f}" for k in keys)
    if G is not None:
        lines[idx["; total filament weight [g] :"]] = "; total filament weight [g] : " + ",".join(f"{table[k][2]:.2f}" for k in keys)


def merged_text(job: Job, res: Result) -> str:
    return job.newline.join(merged_lines(job, res)) + job.newline


def build_3mf(job: Job, res: Result, gcode_text: str) -> bytes:
    data = gcode_text.encode("utf-8")
    md5 = hashlib.md5(data).hexdigest().upper()
    plate = job.plate
    use = usage(job, res)
    extra_s = float(res.stats.get("time_s", 0.0))
    colors = job.strings("filament_colour")
    types = job.strings("filament_type")
    ids = job.strings("filament_ids")

    if job.threemf_bytes is None:
        return _minimal_3mf(job, data, md5)

    src = zipfile.ZipFile(io.BytesIO(job.threemf_bytes))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for info in src.infolist():
            name = info.filename
            raw = src.read(name)
            if name == f"Metadata/plate_{plate}.gcode":
                raw = data
            elif name == f"Metadata/plate_{plate}.gcode.md5":
                raw = md5.encode()
            elif name == "Metadata/slice_info.config":
                raw = _patch_slice_info(raw, plate, use, extra_s, colors, types, ids)
            elif name == f"Metadata/plate_{plate}.json":
                raw = _patch_plate_json(raw, use, colors)
            zi = zipfile.ZipInfo(name, date_time=info.date_time)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = info.external_attr
            dst.writestr(zi, raw)
    return out.getvalue()


def _patch_slice_info(raw: bytes, plate: int, use, extra_s, colors, types, ids) -> bytes:
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return raw
    for pl in root.findall("plate"):
        idx = None
        for md in pl.findall("metadata"):
            if md.get("key") == "index":
                idx = int(md.get("value"))
        if idx != plate:
            continue
        add_g = sum(u["g"] for u in use.values())
        for md in pl.findall("metadata"):
            k = md.get("key")
            if k == "prediction":
                md.set("value", str(int(float(md.get("value")) + extra_s)))
            elif k == "weight":
                md.set("value", f"{float(md.get('value')) + add_g:.2f}")
        fils = {int(f.get("id")): f for f in pl.findall("filament")}
        for slot, u in use.items():
            fid = slot + 1
            f = fils.get(fid)
            if f is None:
                f = ET.Element("filament")
                f.set("id", str(fid))
                f.set("tray_info_idx", ids[slot] if slot < len(ids) else "")
                f.set("type", types[slot] if slot < len(types) else "PLA")
                f.set("color", colors[slot] if slot < len(colors) else "#FFFFFF")
                f.set("used_m", "0.00")
                f.set("used_g", "0.00")
                f.set("used_for_object", "true")
                f.set("used_for_support", "false")
                f.set("group_id", "0")
                f.set("nozzle_diameter", "0.40")
                f.set("volume_type", "Standard")
                f.set("directly_used", "true")
                # insert after the last filament element
                children = list(pl)
                last = max([children.index(x) for x in pl.findall("filament")] or [len(children) - 1])
                pl.insert(last + 1, f)
                fils[fid] = f
            f.set("used_m", f"{float(f.get('used_m', '0')) + u['mm'] / 1000:.2f}")
            f.set("used_g", f"{float(f.get('used_g', '0')) + u['g']:.2f}")
        # keep filaments sorted by id
        fl = sorted(pl.findall("filament"), key=lambda e: int(e.get("id")))
        first_idx = min(list(pl).index(e) for e in fl)
        for e in fl:
            pl.remove(e)
        for k, e in enumerate(fl):
            pl.insert(first_idx + k, e)
        lfl = pl.find("layer_filament_lists")
        if lfl is not None and use:
            mx = -1
            for e in lfl.findall("layer_filament_list"):
                nums = [int(x) for x in e.get("layer_ranges", "").split()]
                if nums:
                    mx = max(mx, max(nums))
            e = ET.SubElement(lfl, "layer_filament_list")
            e.set("filament_list", " ".join(str(s) for s in sorted(use)))
            e.set("layer_ranges", f"{mx + 1} {mx + 1}")
    ET.indent(root, space="  ")
    return b'<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="utf-8")


def _patch_plate_json(raw: bytes, use, colors) -> bytes:
    try:
        j = json.loads(raw)
    except Exception:
        return raw
    ids = list(j.get("filament_ids", []))
    for slot in use:
        if slot not in ids:
            ids.append(slot)
    ids.sort()
    j["filament_ids"] = ids
    j["filament_colors"] = [colors[i] if i < len(colors) else "#FFFFFF" for i in ids]
    return json.dumps(j, separators=(",", ":")).encode()


def _minimal_3mf(job: Job, data: bytes, md5: str) -> bytes:
    """Plain .gcode input: wrap into a minimal Bambu-style gcode.3mf."""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="gcode" ContentType="text/x.gcode"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
        z.writestr("3D/3dmodel.model", '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources/><build/></model>')
        z.writestr("Metadata/plate_1.gcode", data)
        z.writestr("Metadata/plate_1.gcode.md5", md5)
        z.writestr("Metadata/_rels/model_settings.config.rels", '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/Metadata/plate_1.gcode" Id="rel-1" Type="http://schemas.bambulab.com/package/2021/gcode"/></Relationships>')
    return out.getvalue()
