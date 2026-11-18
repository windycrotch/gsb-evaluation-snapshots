"""Variants (named design snapshots) and the head/collision API."""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from impasto import server

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "Brille_RIG_MKV_2026_Master_plate_2.gcode.3mf"
FID = "0123456789ab"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA", tmp_path)
    (tmp_path / FID).mkdir()
    with TestClient(server.app) as c:
        yield c


def test_variant_roundtrip(client):
    base = f"/api/job/{FID}/variants"
    assert client.get(base).json() == []
    d1 = {"version": 1, "elements": [{"id": 1}, {"id": 2}]}
    assert client.put(f"{base}/Muster A?plate=1", json=d1).json()["ok"]
    assert client.put(f"{base}/Schrift Ü", json={"elements": []}).status_code == 200
    lst = client.get(base).json()
    assert {v["name"] for v in lst} == {"Muster A", "Schrift Ü"}
    assert next(v for v in lst if v["name"] == "Muster A")["elements"] == 2
    assert lst[0]["name"] == "Schrift Ü"                     # newest first
    assert client.get(f"{base}/Muster A").json()["design"] == d1
    # other plate is separate
    assert client.get(f"{base}?plate=2").json() == []
    # overwrite keeps one entry
    client.put(f"{base}/Muster A", json={"elements": []})
    assert len(client.get(base).json()) == 2
    assert client.delete(f"{base}/Muster A").json()["ok"]
    assert client.get(f"{base}/Muster A").status_code == 404
    assert [v["name"] for v in client.get(base).json()] == ["Schrift Ü"]


def test_variant_bad_input(client):
    assert client.get("/api/job/nothex/variants").status_code == 404
    assert client.get("/api/job/ffffffffffff/variants").status_code == 404   # unknown job
    assert client.put(f"/api/job/{FID}/variants/%20..%20", json={}).status_code == 400
    # path tricks end up inside the variant dir
    r = client.put(f"/api/job/{FID}/variants/..%2F..%2Fx", json={})
    assert r.status_code in (200, 404, 405)
    assert not [p for p in server.DATA.rglob("x.json") if p.parent.name != "variants_1"]


def test_heads_api(client):
    heads = client.get("/api/heads").json()
    assert len(heads) >= 50 and {"id", "name", "boxes"} <= set(heads[0])
    h = client.get("/api/heads/bambu-a1-mini").json()
    assert len(h["boxes"]) > 100
    assert client.get("/api/heads/../../etc/passwd").status_code == 404


@pytest.mark.skipif(not SAMPLE.exists(), reason="sample missing")
def test_generate_with_head(client):
    r = client.post("/api/upload", files={"file": ("p.gcode.3mf", SAMPLE.read_bytes(), "application/octet-stream")})
    fid = r.json()["id"]
    body = {"params": {"z_offset": 0.15}, "head": "bambu-a1-mini",
            "paths": [{"slot": 0, "pts": [[70, 58], [110, 58]]}]}
    r = client.post(f"/api/job/{fid}/generate?plate=2", json=body)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["collisions"] is not None and j["stats"]["collisions"] == j["collisions"]["count"]
    body["head"] = "nope"
    assert client.post(f"/api/job/{fid}/generate?plate=2", json=body).status_code == 404
