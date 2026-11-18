"""End-to-end: generate a layer, then send it to a (faked) printer."""
import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from impasto import printer, server

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "Brille_RIG_MKV_2026_Master_plate_2.gcode.3mf"

pytestmark = pytest.mark.skipif(not SAMPLE.exists(), reason="sample missing")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA", tmp_path)
    monkeypatch.setattr(printer, "DATA", tmp_path)
    with TestClient(server.app) as c:
        yield c


def test_send_flow(client, monkeypatch):
    data = SAMPLE.read_bytes()
    r = client.post("/api/upload", files={"file": ("plate.gcode.3mf", data, "application/octet-stream")})
    assert r.status_code == 200, r.text
    fid = r.json()["id"]

    body = {"params": {"z_offset": 0.15, "line_width": 0.45},
            "paths": [{"slot": 1, "pts": [[60, 56], [120, 56]]}]}
    r = client.post(f"/api/job/{fid}/generate?plate=2", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["stats"]["toolchanges"] == 1

    sent = {}

    def fake_upload(ip, code, name, blob, folder="", port=990):
        sent["name"], sent["size"] = name, len(blob)
        sent["zip"] = zipfile.ZipFile(io.BytesIO(blob)).namelist()
        return {"ok": True, "path": "/" + name, "size": len(blob)}

    def fake_start(ip, code, serial, **kw):
        sent["start"] = kw
        return {"sent": True, "ack": {"result": "success"}}

    monkeypatch.setattr(printer, "upload", fake_upload)
    monkeypatch.setattr(printer, "trays", lambda ip, code, serial: [
        {"slot": 0, "type": "PHA", "color": "#FFFFFF", "remain": 100},
        {"slot": 1, "type": "PLA", "color": "#FFF144", "remain": 100},
        {"slot": 2, "type": "PHA", "color": "#161616", "remain": 100},
        {"slot": 3, "type": "PHA", "color": "#FCECD6", "remain": 100},
    ])
    monkeypatch.setattr(printer._printer, "start", fake_start)
    client.put("/api/printer", json={"ip": "10.0.0.9", "code": "ABCD1234", "serial": "01P00A000000001"})

    r = client.post(f"/api/job/{fid}/send?plate=2", json={"start": True})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["started"] is True
    assert out["name"].endswith("_plate2_nonplanar.gcode.3mf")
    assert "Metadata/plate_2.gcode" in sent["zip"]
    assert sent["start"]["url"] == f"ftp:///{out['name']}"
    assert sent["start"]["plate"] == 2
    assert sent["start"]["mapping"] == [0, 1, 2, -1]      # white -> AMS 1, yellow -> AMS 2, black -> AMS 3
    assert all(v >= 0 for i, v in enumerate(sent["start"]["mapping"]) if i < 3)   # never the external spool
    assert out["mapping_notes"][0].startswith("Filament 1")
    assert sent["start"]["use_ams"] is True


def test_generate_returns_flags_and_export_is_logged(client):
    import base64
    data = SAMPLE.read_bytes()
    fid = client.post("/api/upload", files={"file": ("plate.gcode.3mf", data, "application/octet-stream")}).json()["id"]
    body = {"params": {"z_offset": 0.15}, "paths": [{"slot": 0, "pts": [[60, 56], [90, 56]]},
                                                     {"slot": 0, "pts": [[60, 54.5], [90, 54.5]]}]}
    r = client.post(f"/api/job/{fid}/generate?plate=2", json=body).json()
    n = len(base64.b64decode(r["moves"])) // (9 * 4)
    assert len(base64.b64decode(r["flags"])) == n
    assert len(r["retracts"]) == r["stats"]["retracts"] >= 1
    assert client.get(f"/api/job/{fid}/exports").json() == []
    assert client.get(f"/api/job/{fid}/export?plate=2&fmt=gcode").status_code == 200
    log = client.get(f"/api/job/{fid}/exports?plate=2").json()
    assert len(log) == 1 and log[0]["kind"] == "gcode"
    assert log[0]["stats"]["retracts"] == r["stats"]["retracts"]
    assert "uphill_pct" in log[0] and log[0]["params"]["z_offset"] == 0.15
