"""Bambu Lab printer access over LAN: FTPS upload, MQTT start/status, discovery.

Protocol (see OpenBambuAPI):
  FTPS  implicit TLS, port 990, user "bblp", password = LAN access code
  MQTT  TLS, port 8883, user "bblp", topics device/<serial>/request|report
The access code is stored encrypted (Fernet) with a key file next to the data.
"""
from __future__ import annotations

import ftplib
import json
import socket
import ssl
import threading
import time
from pathlib import Path

from .i18n import t as T
from .paths import DATA  # noqa: F401

CONNECT_TIMEOUT = 12.0
COMMAND_TIMEOUT = 25.0
DATA_TIMEOUT = 90.0

# ------------------------------------------------------------------ settings

def _paths() -> tuple[Path, Path]:
    return DATA / "printer.json", DATA / ".printer.key"


def _fernet():
    from cryptography.fernet import Fernet
    _, keyf = _paths()
    if keyf.exists():
        key = keyf.read_bytes().strip()
    else:
        key = Fernet.generate_key()
        keyf.write_bytes(key)
        keyf.chmod(0o600)
    return Fernet(key)


def load_settings() -> dict:
    f, _ = _paths()
    if not f.exists():
        return {}
    try:
        d = json.loads(f.read_text())
    except Exception:
        return {}
    if d.get("code"):
        try:
            d["code"] = _fernet().decrypt(d["code"].encode()).decode()
        except Exception:
            d["code"] = ""
    return d


def save_settings(ip: str | None = None, serial: str | None = None, code: str | None = None,
                  start_after_send: bool | None = None) -> dict:
    f, _ = _paths()
    d = load_settings()
    if ip is not None:
        d["ip"] = ip.strip()
    if serial is not None:
        d["serial"] = serial.strip().upper()
    if code:                       # empty = keep the stored code
        d["code"] = code.strip()
    if start_after_send is not None:
        d["start_after_send"] = bool(start_after_send)
    out = dict(d)
    if out.get("code"):
        out["code"] = _fernet().encrypt(out["code"].encode()).decode()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(out))
    f.chmod(0o600)
    return d


def public_settings() -> dict:
    d = load_settings()
    return {"ip": d.get("ip", ""), "serial": d.get("serial", ""), "has_code": bool(d.get("code")),
            "start_after_send": bool(d.get("start_after_send", False))}


# ------------------------------------------------------------------ discovery

def _banner(host: str, timeout: float = 3.0) -> str:
    """TLS handshake + FTP greeting. The printer is slow (~0.7 s), so use a generous timeout."""
    try:
        raw = socket.create_connection((host, 990), timeout=timeout)
    except Exception:
        return ""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        raw.settimeout(timeout)
        with ctx.wrap_socket(raw, server_hostname=host) as t:
            t.settimeout(timeout)
            return t.recv(120).decode("latin-1", "replace").strip()
    except Exception:
        return ""


def discover(connect_timeout: float = 0.35, verify_timeout: float = 3.0) -> list[dict]:
    """Find Bambu printers: fast TCP scan for port 990, then confirm the FTP banner."""
    seen: list[str] = []
    lock = threading.Lock()

    def tcp(host: str):
        try:
            with socket.create_connection((host, 990), timeout=connect_timeout):
                pass
        except Exception:
            return
        with lock:
            seen.append(host)

    threads: list[threading.Thread] = []
    for base in _local_ips():
        for i in range(1, 255):
            t = threading.Thread(target=tcp, args=(f"{base}.{i}",), daemon=True)
            t.start()
            threads.append(t)
            if len(threads) >= 128:
                for x in threads:
                    x.join()
                threads = []
    for t in threads:
        t.join()

    found = []
    for host in sorted(set(seen), key=lambda h: tuple(int(p) for p in h.split(".")))[:8]:
        banner = _banner(host, verify_timeout)
        if banner and ("BBL" in banner or "FTP" in banner):
            found.append({"ip": host, "banner": banner})
    return found


def _local_ips() -> list[str]:
    bases = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.168.33.1", 1))
            bases.add(".".join(s.getsockname()[0].split(".")[:3]))
    except Exception:
        pass
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if not ip.startswith("127.") and not ip.startswith("100."):
                bases.add(".".join(ip.split(".")[:3]))
    except Exception:
        pass
    return sorted(b for b in bases if b)


# ------------------------------------------------------------------ FTPS

def cert_serial(ip: str, port: int = 990, timeout: float = 8.0) -> str:
    """The printer's TLS certificate CN is its serial number."""
    try:
        from cryptography import x509
        raw = socket.create_connection((ip, port), timeout=timeout)
        sctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        sctx.check_hostname = False
        sctx.verify_mode = ssl.CERT_NONE
        raw.settimeout(timeout)
        with sctx.wrap_socket(raw, server_hostname=ip) as t:
            der = t.getpeercert(binary_form=True)
        cert = x509.load_der_x509_certificate(der)
        for attr in cert.subject:
            if attr.oid == x509.oid.NameOID.COMMON_NAME:
                return str(attr.value).strip().upper()
    except Exception:
        pass
    return ""


def _ftps(ip: str, code: str, port: int = 990) -> ftplib.FTP_TLS:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    last = None
    for _ in range(2):
        try:
            raw = socket.create_connection((ip, port), timeout=CONNECT_TIMEOUT)
            raw.settimeout(COMMAND_TIMEOUT)
            sock = ctx.wrap_socket(raw, server_hostname=ip)
            sock.settimeout(COMMAND_TIMEOUT)
            break
        except Exception as ex:
            last = ex
            time.sleep(1.5)
    else:
        raise last
    ftp = ftplib.FTP_TLS(context=ctx)
    ftp.host, ftp.port = ip, port
    ftp.sock = sock
    ftp.af = sock.family
    ftp.file = sock.makefile("r", encoding=ftp.encoding)
    ftp.welcome = ftp.getresp()
    ftplib.FTP.login(ftp, "bblp", code)     # plain login: TLS is already up
    ftp.prot_p()
    ftp.set_pasv(True)
    return ftp


def _force_close(ftp) -> None:
    """Hard close: the printer keeps a single FTP session, a leaked socket blocks everything."""
    sock = getattr(ftp, "sock", None)
    if sock is not None:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass
        try:
            sock.close()
        except Exception:
            pass
    try:
        if getattr(ftp, "file", None):
            ftp.file.close()
    except Exception:
        pass
    try:
        ftp.sock = None
        ftp.file = None
    except Exception:
        pass


def _close_ftp(ftp) -> None:
    """Try a graceful QUIT with a short deadline, then force-close."""
    try:
        if getattr(ftp, "sock", None) is not None:
            ftp.sock.settimeout(4.0)
            ftp.quit()
    except Exception:
        pass
    _force_close(ftp)


def _stor(ftp, cmd: str, data: bytes) -> None:
    """Like FTP.storbinary, but tolerant: Bambu's data channel may close without TLS close_notify."""
    ftp.voidcmd("TYPE I")
    conn = ftp.transfercmd(cmd)
    try:
        conn.settimeout(DATA_TIMEOUT)
        view = memoryview(data)
        for i in range(0, len(view), 256 * 1024):
            conn.sendall(view[i:i + 256 * 1024])
        try:                      # polite TLS shutdown, but the printer never answers it
            conn.settimeout(2.0)
            conn.unwrap()
        except Exception:
            pass
    finally:
        try:
            conn.close()
        except Exception:
            pass
    ftp.voidresp()


def upload(ip: str, code: str, name: str, data: bytes, folder: str = "", port: int = 990) -> dict:
    return _with_ftp(lambda: _upload(ip, code, name, data, folder, port))


def _upload(ip: str, code: str, name: str, data: bytes, folder: str = "", port: int = 990) -> dict:
    ftp = _ftps(ip, code, port)
    try:
        ftp.voidcmd("TYPE I")
        if folder:
            try:
                ftp.cwd(folder)
            except ftplib.error_perm:
                pass
        _stor(ftp, f"STOR {name}", data)
        where = ftp.pwd()
        size = ftp.size(name)
    finally:
        _close_ftp(ftp)
    return {"ok": True, "path": f"{where.rstrip('/')}/{name}", "size": size}


def test(ip: str, code: str, port: int = 990) -> dict:
    return _with_ftp(lambda: _test(ip, code, port))


def _test(ip: str, code: str, port: int = 990) -> dict:
    t0 = time.time()
    ftp = _ftps(ip, code, port)
    try:
        pwd = ftp.pwd()
        files = []
        try:
            files = ftp.nlst()[:15]
        except Exception:
            pass
    finally:
        _close_ftp(ftp)
    return {"ok": True, "pwd": pwd, "files": files, "ms": int((time.time() - t0) * 1000)}


# ------------------------------------------------------------------ MQTT

def _merge_by_id(old: list, new: list) -> list:
    """Merge two lists of dicts keyed by ``id`` (AMS units / trays)."""
    if not isinstance(old, list) or not all(isinstance(x, dict) for x in new):
        return new
    out = [dict(x) if isinstance(x, dict) else x for x in old]
    for item in new:
        k = str(item.get("id", ""))
        for i, o in enumerate(out):
            if isinstance(o, dict) and str(o.get("id", "")) == k:
                out[i] = _merge_dict(o, item)
                break
        else:
            out.append(item)
    return out


def _merge_dict(old: dict, new: dict) -> dict:
    out = dict(old)
    for k, v in new.items():
        if k in ("ams", "tray") and isinstance(v, list):
            out[k] = _merge_by_id(out.get(k), v)
        elif isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge_dict(out[k], v)
        else:
            out[k] = v
    return out


def merge_report(report: dict, p: dict) -> None:
    """Apply an incremental ``push_status`` to the stored report.

    Bambu printers send the full state once (pushall) and afterwards only changed fields –
    an ``ams`` block may then carry just ``tray_now`` or a single tray. A flat update would
    replace the whole tray list with that fragment, so the AMS block is merged deeply
    (units and trays by ``id``). An emptied tray arrives as a tray with empty ``tray_type``
    and therefore still overwrites the old entry.
    """
    for k, v in p.items():
        if k == "ams" and isinstance(v, dict) and isinstance(report.get("ams"), dict):
            report["ams"] = _merge_dict(report["ams"], v)
        else:
            report[k] = v


class Printer:
    """One MQTT connection, keeps the last report."""
    def __init__(self):
        self.client = None
        self.serial: str | None = None
        self.report: dict = {}
        self.error: tuple[str, dict] | None = None
        self.lock = threading.Lock()
        # last complete AMS block (survives reconnects, which wipe ``report``)
        self.ams_good: tuple[float, dict] | None = None

    def _connect(self, ip: str, code: str, serial: str | None):
        import paho.mqtt.client as mqtt
        with self.lock:
            if self.client is not None:
                try:
                    self.client.loop_stop()
                    self.client.disconnect()
                except Exception:
                    pass
                self.client = None
            self.report = {}
            self.error = None
            c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"impasto{int(time.time()) % 100000}",
                            protocol=mqtt.MQTTv311)
            c.tls_set(cert_reqs=ssl.CERT_NONE)
            c.tls_insecure_set(True)
            c.username_pw_set("bblp", code)
            topic = f"device/{serial}/report" if serial else "device/+/report"

            def on_connect(cl, u, flags, rc, props=None):
                try:
                    failed = bool(getattr(rc, "is_failure", False)) or getattr(rc, "value", rc) != 0
                except Exception:
                    failed = False
                if failed:
                    self.error = ("error.login_rejected", {"rc": str(rc)})
                    return
                self.error = None
                cl.subscribe(topic)
                cl.publish(topic.replace("/report", "/request") if serial else "device/+/request",
                           json.dumps({"pushing": {"sequence_id": "1", "command": "pushall",
                                                   "version": 1, "push_target": 1}}))

            def on_message(cl, u, msg):
                try:
                    d = json.loads(msg.payload.decode())
                except Exception:
                    return
                with self.lock:
                    if not self.serial:
                        self.serial = msg.topic.split("/")[1]
                    p = d.get("print")
                    if isinstance(p, dict):
                        merge_report(self.report, p)
                        units = (self.report.get("ams") or {}).get("ams")
                        if units:
                            self.ams_good = (time.time(), json.loads(json.dumps(self.report["ams"])))
                    elif "pushing" in d:
                        self.report.setdefault("_commands", []).append(d["pushing"].get("command"))

            def on_disconnect(cl, u, *a):
                self.error = ("error.mqtt_disconnected", {})

            c.on_connect = on_connect
            c.on_message = on_message
            c.on_disconnect = on_disconnect
            c.connect_async(ip, 8883, keepalive=30)
            c.loop_start()
            self.client = c

    def wait(self, seconds: float, key: str | None = None):
        t = time.time()
        while time.time() - t < seconds:
            with self.lock:
                if key is None and self.report:
                    return True
                if key and key in self.report:
                    return True
            time.sleep(0.1)
        return False

    def status(self, ip: str, code: str, serial: str | None, fresh: float = 2.0) -> dict:
        with self.lock:
            alive = self.client is not None and self.client.is_connected()
        if not alive:
            self._connect(ip, code, serial)
            self.wait(fresh)
        else:
            self.wait(0.05)
        with self.lock:
            r = dict(self.report)
            serial = self.serial or serial
        out = {
            "connected": bool(r),
            "hint": "" if r else T("error.no_answer"),
            "serial": serial or "",
            "state": r.get("gcode_state", ""),
            "percent": r.get("mc_percent"),
            "remaining_min": r.get("mc_remaining_time"),
            "file": r.get("subtask_name", ""),
            "layer": r.get("layer_num"),
            "layers": r.get("total_layer_num"),
            "nozzle": r.get("nozzle_temper"),
            "bed": r.get("bed_temper"),
            "print_error": r.get("print_error"),
            "stage": r.get("mc_print_stage"),
            "error": T(self.error[0], **self.error[1]) if self.error else None,
        }
        return out

    def stop(self, ip: str, code: str, serial: str, wait: float = 2.0) -> dict:
        """Clear a failed/finished job so the printer accepts a new project_file."""
        self.status(ip, code, serial, fresh=1.0)
        with self.lock:
            c = self.client
        if c is None:
            return {"ok": False}
        seq = str(int(time.time()) % 100000)
        c.publish(f"device/{serial}/request", json.dumps({"print": {"sequence_id": seq, "command": "stop"}}))
        time.sleep(wait)
        return {"ok": True}

    def start(self, ip: str, code: str, serial: str, *, url: str, plate: int, name: str,
              md5: str = "", mapping: list[int] | None = None, use_ams: bool = True) -> dict:
        import paho.mqtt.client as mqtt
        seq = str(int(time.time()) % 100000)
        payload = {"print": {
            "sequence_id": seq,
            "command": "project_file",
            "param": f"Metadata/plate_{plate}.gcode",
            "project_id": "0", "profile_id": "0", "task_id": "0", "subtask_id": "0",
            "subtask_name": name,
            "file": name, "url": url, "md5": md5,
            "timelapse": False,
            "bed_type": "auto",
            "bed_levelling": True, "bed_leveling": True,
            "flow_cali": False, "vibration_cali": False, "layer_inspect": False,
            "use_ams": use_ams,
            "ams_mapping": mapping if mapping is not None else [],
        }}
        res = {"sent": False, "ack": None}
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        done = threading.Event()

        def on_connect(cl, u, flags, rc, props=None):
            cl.subscribe(f"device/{serial}/report")
            cl.publish(f"device/{serial}/request", json.dumps(payload))

        def on_message(cl, u, msg):
            try:
                d = json.loads(msg.payload.decode())
            except Exception:
                return
            p = d.get("print")
            if isinstance(p, dict) and p.get("command") == "project_file":
                res["ack"] = {k: p.get(k) for k in ("result", "reason", "sequence_id")}
                done.set()

        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"impastostart{int(time.time()) % 100000}",
                        protocol=mqtt.MQTTv311)
        c.tls_set(cert_reqs=ssl.CERT_NONE)
        c.tls_insecure_set(True)
        c.username_pw_set("bblp", code)
        c.on_connect = on_connect
        c.on_message = on_message
        c.connect(ip, 8883, keepalive=20)
        c.loop_start()
        try:
            res["sent"] = True
            done.wait(8.0)
        finally:
            c.loop_stop()
            c.disconnect()
        return res


def trays(ip: str, code: str, serial: str, fresh: float = 3.0) -> list[dict]:
    """AMS trays from the printer report: [{slot, type, color, remain}].

    ``slot`` is the global tray index (ams_id * 4 + id). The report is read live: a stale
    or empty report must never be mistaken for "no AMS", otherwise the start command would
    fall back to the external spool and ask for a manual feed.
    """
    _printer.status(ip, code, serial, fresh=1.0)

    def current():
        with _printer.lock:
            units = (_printer.report.get("ams") or {}).get("ams") or []
            good = getattr(_printer, "ams_good", None)
        if not units and good and time.time() - good[0] < 1800:
            units = good[1].get("ams") or []     # reconnect wiped the report: last full AMS
        return units

    units = current()
    if not units:                                # nothing known -> pushall delivers the AMS block
        _printer._connect(ip, code, serial)
        _printer.wait(6.0, "ams")
        units = current()
    multi = len(units) > 1
    out = []
    for unit in units:
        try:
            base = int(unit.get("id", 0)) * 4 if multi else 0
        except Exception:
            base = 0
        for t in unit.get("tray") or []:
            if not t.get("tray_type"):
                continue
            out.append({"slot": base + int(t.get("id", 0) or 0), "type": t.get("tray_type", ""),
                        "color": "#" + str(t.get("tray_color", ""))[:6], "remain": t.get("remain")})
    out.sort(key=lambda t: t["slot"])
    return out


def _norm_color(c) -> str:
    return str(c or "").upper().lstrip("#")[:6]


def match_mapping(fil_colors: list[str], fil_types: list[str], used: list[int], ams: list[dict]) -> dict:
    """Map every used filament to one AMS tray. Returns {ok, mapping, notes, error}.

    Only the AMS is used: an entry of -1 means "external spool" to the printer, which then
    stops and asks for a manual feed. So every used filament gets a tray – colour and type
    only decide *which* one, a filament that matches nothing still takes a free tray. If
    there are fewer trays than used filaments the start is refused instead.
    """
    used = sorted({int(f) for f in used if int(f) >= 0})
    n = max(4, len(fil_colors), (used[-1] + 1) if used else 0)
    mapping = [-1] * n
    notes: list[str] = []
    trays_ = [t for t in ams if t.get("type")]
    if not used:
        return {"ok": True, "mapping": mapping, "notes": notes, "error": ""}
    have = ", ".join(f"{int(t['slot']) + 1}:{t['type']} {t['color']}" for t in trays_) or T("common.none")
    if not trays_:
        return {"ok": False, "mapping": mapping, "notes": notes,
                "error": T("error.ams_not_read")}
    if len(trays_) < len(used):
        return {"ok": False, "mapping": mapping, "notes": notes,
                "error": T("error.ams_fewer", used=len(used), trays=len(trays_), have=have)}

    def score(f: int, t: dict) -> int:
        col = _norm_color(fil_colors[f] if f < len(fil_colors) else "")
        typ = str(fil_types[f] if f < len(fil_types) else "").upper()
        c, ty = _norm_color(t.get("color")), str(t.get("type") or "").upper()
        s = 0 if (c == col and ty == typ) else (1 if c == col else (2 if ty == typ else 3))
        try:
            rem = float(t.get("remain"))
        except (TypeError, ValueError):
            rem = -1.0
        if rem == 0:
            s += 10                       # empty tray: only when nothing else is left
        return s

    import itertools
    best = min(itertools.permutations(range(len(trays_)), len(used)),
               key=lambda combo: sum(score(f, trays_[j]) for f, j in zip(used, combo)))
    for f, j in zip(used, best):
        t = trays_[j]
        mapping[f] = int(t["slot"])
        col = _norm_color(fil_colors[f] if f < len(fil_colors) else "")
        typ = str(fil_types[f] if f < len(fil_types) else "").upper()
        c, ty = _norm_color(t.get("color")), str(t.get("type") or "").upper()
        if c == col and ty == typ:
            extra = ""
        elif c == col:
            extra = T("note.ams_material", type=ty, want=typ)
        elif ty == typ:
            extra = T("note.ams_color", color=t.get("color"), want=fil_colors[f] if f < len(fil_colors) else "?")
        else:
            extra = T("note.ams_both", type=ty, color=t.get("color"))
        notes.append(T("note.ams", f=f + 1, slot=int(t["slot"]) + 1, type=t.get("type"), color=t.get("color"), extra=extra))
    return {"ok": True, "mapping": mapping, "notes": notes, "error": ""}


_ftp_lock = threading.Lock()


def _with_ftp(fn):
    with _ftp_lock:
        return fn()


_printer = Printer()


def status(ip: str | None = None, code: str | None = None, serial: str | None = None) -> dict:
    d = load_settings()
    ip = ip or d.get("ip", "")
    code = code or d.get("code", "")
    serial = serial or d.get("serial", "")
    if not ip or not code:
        return {"connected": False, "error": T("error.printer_not_set_up")}
    return _printer.status(ip, code, serial or None)


def detect_serial(ip: str, code: str) -> str:
    """Connect with a wildcard subscription and read the device id from the topic."""
    _printer._connect(ip, code, None)
    _printer.wait(4.0)
    with _printer.lock:
        return _printer.serial or ""
