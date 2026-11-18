"""FastAPI backend of the Impasto web app."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import shutil
import struct
import threading
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np
from fastapi import Body, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__, bambu, collision, generate, merge, parse, printer, surface
from .i18n import LANG, language_from, t as T

from .paths import DATA, WEB

DATA.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Impasto", version=__version__)
app.add_middleware(GZipMiddleware, minimum_size=2048)


@app.middleware("http")
async def no_stale_assets(request, call_next):
    LANG.set(language_from(request.headers))
    resp = await call_next(request)
    p = request.url.path
    if not p.startswith("/api/") and not p.startswith("/vendor/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


class Session:
    def __init__(self, fid: str, plate: int):
        self.fid = fid
        self.plate = plate
        self.lock = threading.Lock()
        src = DATA / fid / "source.bin"
        meta = json.loads((DATA / fid / "meta.json").read_text())
        self.filename = meta["filename"]
        self.job = bambu.load_bytes(src.read_bytes(), self.filename, plate if meta["kind"] == "3mf" else None)
        self.tp = parse.parse(self.job.lines, self.job.exec_start, self.job.insert_at)
        self.grid = surface.heightmap(self.tp)
        surface.analyze(self.grid)
        self.result: generate.Result | None = None
        self.result_params: dict | None = None


_sessions: "OrderedDict[tuple[str, int], Session]" = OrderedDict()
_slock = threading.Lock()


def get_session(fid: str, plate: int) -> Session:
    if not re.fullmatch(r"[0-9a-f]{12}", fid) or not (DATA / fid / "meta.json").exists():
        raise HTTPException(404, T("error.file_not_found"))
    key = (fid, plate)
    with _slock:
        s = _sessions.get(key)
        if s is not None:
            _sessions.move_to_end(key)
            return s
    try:
        s = Session(fid, plate)
    except ValueError as ex:
        raise HTTPException(400, str(ex))
    with _slock:
        _sessions[key] = s
        while len(_sessions) > 3:
            _sessions.popitem(last=False)
    return s


# ---------------------------------------------------------------------------- files

@app.get("/api/version")
def version():
    return {"version": __version__}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        raise HTTPException(400, T("error.empty_file"))
    fid = hashlib.sha1(data).hexdigest()[:12]
    d = DATA / fid
    d.mkdir(exist_ok=True)
    kind = "3mf" if data[:2] == b"PK" else "gcode"
    plates = [1]
    if kind == "3mf":
        try:
            plates = bambu.list_plates(data)
        except Exception:
            raise HTTPException(400, T("error.bad_3mf"))
        if not plates:
            raise HTTPException(400, T("error.3mf_no_gcode"))
    else:
        head = data[:200000].decode("utf-8", errors="replace")
        if "G1" not in head and "G0" not in head:
            raise HTTPException(400, T("error.not_gcode"))
    (d / "source.bin").write_bytes(data)
    meta = {"id": fid, "filename": file.filename or "upload.gcode", "kind": kind, "plates": plates,
            "size": len(data), "uploaded": time.time()}
    (d / "meta.json").write_text(json.dumps(meta))
    return meta


@app.get("/api/files")
def files():
    out = []
    for m in DATA.glob("*/meta.json"):
        try:
            meta = json.loads(m.read_text())
        except Exception:
            continue
        meta["designs"] = sorted(p.stem.replace("design_", "") for p in m.parent.glob("design_*.json"))
        out.append(meta)
    out.sort(key=lambda x: -x.get("uploaded", 0))
    return out


@app.delete("/api/files/{fid}")
def delete_file(fid: str):
    if not re.fullmatch(r"[0-9a-f]{12}", fid):
        raise HTTPException(404)
    d = DATA / fid
    if d.exists():
        shutil.rmtree(d)
    with _slock:
        for k in [k for k in _sessions if k[0] == fid]:
            _sessions.pop(k)
    return {"ok": True}


# ---------------------------------------------------------------------------- job

@app.get("/api/job/{fid}")
def job_info(fid: str, plate: int = 1):
    s = get_session(fid, plate)
    j, tp, g = s.job, s.tp, s.grid
    colors = j.strings("filament_colour")
    types = j.strings("filament_type")
    names = j.strings("filament_settings_id")
    temps = j.floats("nozzle_temperature")
    used = sorted(set(int(x) for x in np.unique(tp.fil[tp.fil >= 0])))
    fil = [{"slot": i, "color": colors[i] if i < len(colors) else "#888888",
            "type": types[i] if i < len(types) else "",
            "name": names[i] if i < len(names) else "",
            "temp": temps[i] if i < len(temps) else 0, "used": i in used} for i in range(j.n_filaments)]
    feats = tp.features
    return {
        "id": fid, "plate": plate, "filename": s.filename,
        "printer": j.raw("printer_model"), "nozzle": j.float_at("nozzle_diameter", 0, 0.4),
        "grid": g.meta(), "filaments": fil, "last_filament": tp.last_filament,
        "max_z": tp.max_z, "layers": len(tp.layer_z), "layer_z": tp.layer_z[-5:],
        "features": feats, "insert_line": j.insert_at + 1, "total_lines": len(j.lines),
        "bed": _bed(j), "defaults": generate.Params().__dict__,
        "retraction_length": j.float_at("retraction_length", 0, 0.8),
        "header": {k: v for k, v in j.header.items() if not k.startswith("Legal")},
    }


def _bed(j):
    pts = []
    for p in j.strings("printable_area"):
        if "x" in p:
            a, b = p.split("x")
            pts.append([float(a), float(b)])
    return pts or [[0, 0], [180, 0], [180, 180], [0, 180]]


@app.get("/api/job/{fid}/grid")
def job_grid(fid: str, plate: int = 1, sigma: float = 0.6, tip: float = 0.3):
    s = get_session(fid, plate)
    with s.lock:
        g = s.grid
        sigma = float(np.clip(sigma, 0.1, 5.0))
        tip = float(np.clip(tip, 0.0, 2.0))
        if abs(g.sigma - sigma) > 1e-6 or abs(g.tip_r - tip) > 1e-6:
            surface.analyze(g, sigma, tip)
            s.result = None
        H = np.nan_to_num(g.H, nan=-1.0).astype(np.float32)
        ZN = np.nan_to_num(g.ZN, nan=-1.0).astype(np.float32)
        S = np.clip(np.rint(g.S * 2), 0, 180).astype(np.uint8)   # half degrees
        head = json.dumps(g.meta()).encode()
        pad = (-len(head)) % 4
        buf = struct.pack("<I", len(head) + pad) + head + b" " * pad + H.tobytes() + ZN.tobytes() + S.tobytes()
    return Response(buf, media_type="application/octet-stream")


@app.get("/api/job/{fid}/toolpaths")
def job_toolpaths(fid: str, plate: int = 1, zmin: float = -1.0, zmax: float = 1e9, all_features: bool = False):
    s = get_session(fid, plate)
    tp = s.tp
    z = tp.seg[:, 4]
    sel = (z >= zmin) & (z <= zmax)
    if not all_features:
        sel &= tp.object_mask
    seg = tp.seg[sel].astype(np.float32)
    fil = tp.fil[sel].astype(np.int8)
    feat = tp.feat[sel].astype(np.uint8)
    lay = tp.layer[sel].astype(np.int16)
    head = json.dumps({"n": int(len(seg)), "features": tp.features}).encode()
    pad = (-len(head)) % 4
    body = seg.tobytes() + lay.tobytes() + fil.tobytes() + feat.tobytes()
    return Response(struct.pack("<I", len(head) + pad) + head + b" " * pad + body,
                    media_type="application/octet-stream")


@app.post("/api/job/{fid}/generate")
def job_generate(fid: str, plate: int = 1, body: dict = Body(...)):
    s = get_session(fid, plate)
    params = generate.Params.from_dict(body.get("params"))
    paths = body.get("paths") or []
    if not paths:
        raise HTTPException(400, T("error.no_paths"))
    try:                                   # last request, for diagnosis
        (DATA / fid / f"last_generate_{plate}.json").write_text(json.dumps(body))
    except Exception:
        pass
    with s.lock:
        t0 = time.time()
        try:
            res = generate.generate(s.job, s.tp, s.grid, paths, params)
        except Exception as ex:  # surface template errors to the UI
            raise HTTPException(500, T("error.generate_failed", ex=ex))
        s.result = res
        s.result_params = params.__dict__
    stats = _jsonable(res.stats)
    stats["gen_ms"] = int((time.time() - t0) * 1000)
    stats["usage"] = _jsonable(merge.usage(s.job, res))
    coll = None
    head_id = body.get("head")
    if head_id:
        t1 = time.time()
        try:
            coll = collision.check(s.grid, res.moves, collision.load_head(head_id),
                                   tip_tol=max(0.0, -float(params.z_offset)) + 0.1)
        except KeyError:
            raise HTTPException(404, T("error.head_unknown", head=head_id))
        stats["collisions"] = coll["count"]
        stats["coll_ms"] = int((time.time() - t1) * 1000)
    return {
        "stats": stats,
        "collisions": coll,
        "gcode": res.gcode if len(res.gcode) < 3_000_000 else res.gcode[:3_000_000] + "\n; ... truncated",
        "moves": base64.b64encode(res.moves.astype(np.float32).tobytes()).decode(),
        "flags": base64.b64encode((res.flags if res.flags is not None
                                   else np.zeros(len(res.moves), np.uint8)).astype(np.uint8).tobytes()).decode(),
        "retracts": np.round(res.retracts, 3).tolist() if res.retracts is not None else [],
        "touches": np.round(res.touches, 3).tolist() if res.touches is not None else [],
        "lines": res.gcode.count("\n"),
    }


@app.get("/api/heads")
def heads_list():
    return [{k: h[k] for k in ("id", "name", "boxes", "tip_flat_radius")} for h in collision.head_index()]


@app.get("/api/heads/{head_id}")
def heads_get(head_id: str):
    try:
        return Response(collision._load(head_id), media_type="application/json")
    except KeyError:
        raise HTTPException(404, T("error.head_unknown_short"))


def _jsonable(o):
    if isinstance(o, dict):
        return {str(k): _jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_jsonable(v) for v in o]
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    return o


@app.get("/api/job/{fid}/export")
def job_export(fid: str, plate: int = 1, fmt: str = "3mf"):
    s = get_session(fid, plate)
    if s.result is None:
        raise HTTPException(409, T("error.no_result"))
    with s.lock:
        text = merge.merged_text(s.job, s.result)
        base = re.sub(r"(\.gcode)?(\.3mf)?$", "", s.filename, flags=re.I)
        if s.job.source_kind == "3mf":
            base = f"{base}_plate{s.plate}"
        if fmt == "gcode":
            data = text.encode()
            name = f"{base}_nonplanar.gcode"
            mt = "text/x.gcode"
        else:
            data = merge.build_3mf(s.job, s.result, text)
            name = f"{base}_nonplanar.gcode.3mf"
            mt = "application/octet-stream"
    _log_export(fid, s, name, fmt)
    return Response(data, media_type=mt, headers={"Content-Disposition": f'attachment; filename="{name}"'})


EXPORT_KEYS = ("toolchanges", "purge_mm3", "time_s", "max_z", "stacked_mm", "elements", "travel_mm",
               "retracts", "short_travels", "wipe_mm", "coast_mm", "self_lift_mm", "slowed_mm",
               "batches", "precedences", "touches", "touch_skipped", "length_mm", "filament_mm", "volume_mm3")


def export_record(s, name: str, kind: str) -> dict:
    st = s.result.stats
    rec = {"time": time.strftime("%Y-%m-%d %H:%M:%S"), "kind": kind, "name": name, "plate": s.plate,
           "source": s.filename, "stats": _jsonable({k: st.get(k) for k in EXPORT_KEYS if k in st}),
           "dir": _jsonable(st.get("dir", {})), "params": _jsonable(s.result_params or {})}
    d = rec["dir"]
    up, dn = d.get("up_mm", 0) or 0, d.get("down_mm", 0) or 0
    rec["uphill_pct"] = round(100 * up / max(up + dn, 1e-9), 1)
    return rec


def _log_export(fid: str, s, name: str, kind: str):
    """every export / send leaves its key figures behind (data/<fid>/exports.jsonl),
    so a print result can later be matched with the numbers that produced it"""
    try:
        rec = export_record(s, name, kind)
        with open(DATA / fid / "exports.jsonl", "a") as fh:
            fh.write(json.dumps(rec) + "\n")
    except Exception as ex:          # never let the log break an export
        print(f"[export-log] {ex}", flush=True)


@app.get("/api/job/{fid}/exports")
def job_exports(fid: str, plate: int | None = None, limit: int = 50):
    f = DATA / fid / "exports.jsonl"
    if not f.exists():
        return []
    out = []
    for ln in f.read_text().splitlines():
        try:
            r = json.loads(ln)
        except ValueError:
            continue
        if plate is None or r.get("plate") == plate:
            out.append(r)
    return out[-max(1, min(limit, 500)):][::-1]


# ---------------------------------------------------------------------------- printer

@app.get("/api/printer")
def printer_get():
    return printer.public_settings()


@app.put("/api/printer")
def printer_put(body: dict = Body(...)):
    printer.save_settings(ip=body.get("ip"), serial=body.get("serial"), code=body.get("code"),
                          start_after_send=body.get("start_after_send"))
    return printer.public_settings()


@app.get("/api/printer/discover")
def printer_discover():
    return {"found": printer.discover()}


@app.post("/api/printer/test")
def printer_test(body: dict = Body(default={})):
    d = printer.load_settings()
    ip = (body.get("ip") or d.get("ip") or "").strip()
    code = (body.get("code") or d.get("code") or "").strip()
    if not ip or not code:
        raise HTTPException(400, T("error.ip_code_required"))
    try:
        res = printer.test(ip, code)
    except Exception as ex:
        msg = str(ex).strip()
        if msg.startswith("530"):
            raise HTTPException(400, T("error.access_rejected"))
        raise HTTPException(400, T("error.ftps", msg=msg))
    printer.save_settings(ip=ip, code=code)      # only after a successful login
    serial = d.get("serial", "") or printer.cert_serial(ip)
    if serial and serial != d.get("serial"):
        printer.save_settings(serial=serial)
    st = {}
    if serial:
        try:
            st = printer.status(ip, code, serial)
        except Exception:
            pass
    return {**res, "serial": serial, "printer": st}


@app.get("/api/printer/status")
def printer_status():
    try:
        st = printer.status()
        if st.get("connected"):
            d = printer.load_settings()
            st["trays"] = printer.trays(d.get("ip", ""), d.get("code", ""), d.get("serial", ""))
        return st
    except Exception as ex:
        return {"connected": False, "error": str(ex)}


@app.post("/api/job/{fid}/send")
def job_send(fid: str, plate: int = 1, body: dict = Body(default={})):
    s = get_session(fid, plate)
    d = printer.load_settings()
    ip = (body.get("ip") or d.get("ip") or "").strip()
    code = (body.get("code") or d.get("code") or "").strip()
    serial = (body.get("serial") or d.get("serial") or "").strip()
    if not ip or not code:
        raise HTTPException(400, T("error.printer_not_configured"))
    if s.result is None:
        raise HTTPException(409, T("error.no_result"))
    do_start = bool(body.get("start"))
    mapping, notes, ams = None, [], []
    if do_start:
        # Resolve the AMS mapping before the upload: the printer treats a -1 entry as
        # "external spool" and stops for a manual feed, so a job that cannot be fed from
        # the AMS must never be started.
        if not serial:
            serial = printer.cert_serial(ip)
            if serial:
                printer.save_settings(serial=serial)
        if not serial:
            raise HTTPException(400, T("error.serial_unknown"))
        used = set(int(x) for x in np.unique(s.tp.fil[s.tp.fil >= 0]))
        used |= {int(k) for k in (s.result.stats.get("filament_mm") or {})}   # non-planar colours too
        colors = s.job.strings("filament_colour")
        types = s.job.strings("filament_type")
        try:
            ams = printer.trays(ip, code, serial)
        except Exception as ex:
            raise HTTPException(400, T("error.ams_unreadable", ex=ex))
        mm = printer.match_mapping(colors, types, sorted(used), ams)
        if not mm["ok"]:
            raise HTTPException(400, mm["error"])
        mapping, notes = mm["mapping"], mm["notes"]
    with s.lock:
        text = merge.merged_text(s.job, s.result)
        data = merge.build_3mf(s.job, s.result, text)
    base = re.sub(r"(\.gcode)?(\.3mf)?$", "", s.filename, flags=re.I)
    base = re.sub(r"[^A-Za-z0-9_.-]+", "_", base)[:60]
    name = f"{base}_plate{plate}_nonplanar.gcode.3mf"
    try:
        up = printer.upload(ip, code, name, data)
    except Exception as ex:
        raise HTTPException(400, T("error.upload_failed", ex=ex))
    _log_export(fid, s, name, "send+start" if do_start else "send")
    out = {"upload": up, "name": name, "started": False}
    if do_start:
        out["mapping"] = mapping
        out["mapping_notes"] = notes
        out["ams"] = ams
        try:
            st = printer.status()
            if st.get("state") in ("FAILED", "FINISH"):
                printer._printer.stop(ip, code, serial, wait=2.0)
        except Exception:
            pass
        md5 = ""      # Bambu accepts an empty md5; a wrong one can make the job fail
        try:
            res = printer._printer.start(
                ip, code, serial, url=f"ftp:///{name}", plate=plate, name=name,
                md5=md5, mapping=mapping, use_ams=True)
            out["started"] = bool(res.get("sent"))
            out["start_result"] = res
            print(f"[send] start {name}: {res}", flush=True)
        except Exception as ex:
            out["warning"] = f"Start fehlgeschlagen: {ex}"
    return out


# ---------------------------------------------------------------------------- designs

def _design_path(fid: str, plate: int) -> Path:
    if not re.fullmatch(r"[0-9a-f]{12}", fid):
        raise HTTPException(404)
    return DATA / fid / f"design_{plate}.json"


@app.get("/api/job/{fid}/design")
def get_design(fid: str, plate: int = 1):
    p = _design_path(fid, plate)
    if not p.exists():
        return JSONResponse(None)
    return JSONResponse(json.loads(p.read_text()))


@app.put("/api/job/{fid}/design")
def put_design(fid: str, plate: int = 1, body: dict = Body(...)):
    p = _design_path(fid, plate)
    if not p.parent.exists():
        raise HTTPException(404)
    p.write_text(json.dumps(body))
    return {"ok": True, "bytes": p.stat().st_size}


# ---------------------------------------------------------------------------- variants
# Named design snapshots per file + plate: DATA/<fid>/variants_<plate>/<slug>.json

def _variant_dir(fid: str, plate: int) -> Path:
    d = _design_path(fid, plate).parent
    if not d.exists():
        raise HTTPException(404)
    return d / f"variants_{int(plate)}"


def _slug(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9ÄÖÜäöüß_. -]+", "_", (name or "").strip())[:80].strip(" .")
    if not s:
        raise HTTPException(400, T("error.name_missing"))
    return s


@app.get("/api/job/{fid}/variants")
def list_variants(fid: str, plate: int = 1):
    d = _variant_dir(fid, plate)
    out = []
    for p in d.glob("*.json") if d.exists() else []:
        try:
            body = json.loads(p.read_text())
        except Exception:
            continue
        out.append({"name": body.get("name") or p.stem, "saved": body.get("saved", p.stat().st_mtime),
                    "elements": len(body.get("design", {}).get("elements") or [])})
    out.sort(key=lambda v: -v["saved"])
    return out


@app.get("/api/job/{fid}/variants/{name}")
def get_variant(fid: str, name: str, plate: int = 1):
    p = _variant_dir(fid, plate) / f"{_slug(name)}.json"
    if not p.exists():
        raise HTTPException(404, T("error.variant_not_found"))
    return JSONResponse(json.loads(p.read_text()))


@app.put("/api/job/{fid}/variants/{name}")
def put_variant(fid: str, name: str, plate: int = 1, body: dict = Body(...)):
    d = _variant_dir(fid, plate)
    d.mkdir(exist_ok=True)
    p = d / f"{_slug(name)}.json"
    p.write_text(json.dumps({"name": name.strip(), "saved": time.time(), "design": body}))
    return {"ok": True, "name": name.strip()}


@app.delete("/api/job/{fid}/variants/{name}")
def delete_variant(fid: str, name: str, plate: int = 1):
    p = _variant_dir(fid, plate) / f"{_slug(name)}.json"
    if p.exists():
        p.unlink()
    return {"ok": True}


# ---------------------------------------------------------------------------- static

@app.get("/")
def index():
    return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-cache"})


app.mount("/", StaticFiles(directory=WEB), name="web")


def main():
    import uvicorn
    uvicorn.run(
        app,
        host=os.environ.get("IMPASTO_HOST") or os.environ.get("NPG_HOST") or "0.0.0.0",
        port=int(os.environ.get("IMPASTO_PORT") or os.environ.get("NPG_PORT") or "6868"),
    )


if __name__ == "__main__":
    main()
