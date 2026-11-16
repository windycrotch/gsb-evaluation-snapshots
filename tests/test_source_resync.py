"""
Tests sobre src/core/source_resync.py, armados con datos locales falsos
(metadata de item, archivos candidatos y hashes locales pre-cargados) -- no
pegan contra la red: se monkeypatchea _get_with_retries para servir bytes
en memoria y _fetch_item_files para devolver la lista de candidatos.

Cubre el contrato del resync interrumpible:
- corte a mitad de camino + reinicio sin reprocesar lo ya hasheado
- fallos de descarga/descompresion registrados con motivo y reintentados
- numeros del reporte autoconsistentes cuando todo sale bien
- cache vacio o todo-fallido => la lista de faltantes tiene TODOS los hashes
"""

import hashlib
import io
import json
import zipfile
from collections import Counter

import pytest

import config
from src.core import source_resync
from src.core.source_resync import SourceResync, _ra_hash


def make_zip(member_name: str, data: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(member_name, data)
    return buf.getvalue()


class FakeResponse:
    def __init__(self, content: bytes):
        self.content = content


# ROMs "crudas" de mentira y sus hashes estilo RA (modulo 8192, sin header).
ROM_A = b"A" * 8192
ROM_B = b"B" * 8192
ROM_C = b"C" * 8192
HASH_A = _ra_hash(ROM_A).upper()
HASH_B = _ra_hash(ROM_B).upper()
HASH_C = _ra_hash(ROM_C).upper()
# Hash local que no aparece en ningun candidato del item nuevo.
HASH_HUERFANO = hashlib.md5(b"huerfano").hexdigest().upper()

ROM_PATHS = {
    HASH_A: "SNES-Super Famicom/Juego A (U).sfc",
    HASH_B: "SNES-Super Famicom/Juego B (U).sfc",
    HASH_C: "SNES-Super Famicom/Juego C (J).sfc",
    HASH_HUERFANO: "SNES-Super Famicom/Juego Huerfano (E).sfc",
}

# Candidatos del item nuevo: nombre -> bytes servidos, o Exception para
# simular un fallo de descarga.
GOOD_CANDIDATES = {
    "Juego A (USA).zip": make_zip("Juego A (USA).sfc", ROM_A),
    "Juego B (USA).zip": make_zip("Juego B (USA).sfc", ROM_B),
    "Juego C (Japan).zip": make_zip("Juego C (Japan).sfc", ROM_C),
}


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Entorno aislado: hashes locales en tmp, salidas en tmp, red falsa."""
    hashes_file = tmp_path / "hashes.json"
    local_data = {
        f"game-{i}": [{h: p}] for i, (h, p) in enumerate(ROM_PATHS.items())
    }
    hashes_file.write_text(json.dumps(local_data), encoding="utf-8")
    monkeypatch.setattr(config, "JSON_FILE_PATH", str(hashes_file))

    calls = Counter()
    state = {"candidates": dict(GOOD_CANDIDATES), "fail_after": None}

    def fake_get(url, **kwargs):
        filename = url.rsplit("/", 1)[-1]
        from urllib.parse import unquote

        filename = unquote(filename)
        if state["fail_after"] is not None and len(calls) >= state["fail_after"]:
            raise KeyboardInterrupt  # simula corte del job a mitad de camino
        calls[filename] += 1
        content = state["candidates"][filename]
        if isinstance(content, Exception):
            raise content
        return FakeResponse(content)

    monkeypatch.setattr(source_resync, "_get_with_retries", fake_get)
    monkeypatch.setattr(
        SourceResync,
        "_fetch_item_files",
        lambda self: [(name, len(content) if isinstance(content, bytes) else 0)
                      for name, content in state["candidates"].items()],
    )

    def make_resync():
        r = SourceResync(console="SNES", item="fake-item")
        r.override_file = str(tmp_path / "override.json")
        r.missing_file = str(tmp_path / "missing.txt")
        r.failed_file = str(tmp_path / "failed.txt")
        r.cache_file = str(tmp_path / ".cache.json")
        return r

    return {
        "tmp_path": tmp_path,
        "calls": calls,
        "state": state,
        "make_resync": make_resync,
    }


def read_json(path):
    return json.loads((path).read_text(encoding="utf-8"))


def test_interrupcion_y_reinicio_no_reprocesa_lo_terminado(env):
    # Primera corrida: se corta (KeyboardInterrupt) despues de 2 candidatos.
    env["state"]["fail_after"] = 2
    with pytest.raises(KeyboardInterrupt):
        env["make_resync"]().run()

    cache = read_json(env["tmp_path"] / ".cache.json")
    assert len(cache) == 2
    assert all(e["status"] == "ok" for e in cache.values())

    # Segunda corrida: instancia nueva (como un proceso nuevo), sin corte.
    env["state"]["fail_after"] = None
    env["calls"].clear()
    summary = env["make_resync"]().run()

    # Solo se descargaron los 2 candidatos que faltaban; los 2 primeros
    # salieron del cache sin tocar la red.
    assert sum(env["calls"].values()) == 1
    assert set(env["calls"]) == (set(GOOD_CANDIDATES) - set(cache))
    assert summary["matched"] == 3
    assert summary["partial"] is False


def test_fallo_se_registra_y_se_reintenta_en_la_proxima_corrida(env):
    # "Juego B" falla la descarga; el resto sale bien.
    env["state"]["candidates"]["Juego B (USA).zip"] = RuntimeError("status 404 (despues de 3 intentos)")
    summary = env["make_resync"]().run()

    assert summary["failed"] == 1
    assert summary["matched"] == 2  # A y C matchearon; B y el huerfano no

    failed_txt = (env["tmp_path"] / "failed.txt").read_text(encoding="utf-8")
    assert "1 candidatos fallidos" in failed_txt
    assert "Juego B (USA).zip" in failed_txt
    assert "status 404" in failed_txt

    cache = read_json(env["tmp_path"] / ".cache.json")
    assert cache["Juego B (USA).zip"]["status"] == "failed"

    # El fallo no aborto la ronda: Juego C (que viene despues) se proceso.
    assert cache["Juego C (Japan).zip"]["status"] == "ok"

    # Segunda corrida con la descarga "arreglada": se reintenta solo B.
    env["state"]["candidates"]["Juego B (USA).zip"] = GOOD_CANDIDATES["Juego B (USA).zip"]
    env["calls"].clear()
    summary = env["make_resync"]().run()

    assert env["calls"] == {"Juego B (USA).zip": 1}
    assert summary["failed"] == 0
    assert summary["matched"] == 3
    failed_txt = (env["tmp_path"] / "failed.txt").read_text(encoding="utf-8")
    assert "# 0 candidatos fallidos" in failed_txt


def test_todo_ok_reporta_numeros_autoconsistentes(env, capsys):
    summary = env["make_resync"]().run()

    assert summary == {"total": 4, "matched": 3, "unmatched": 1, "failed": 0, "partial": False}
    assert summary["matched"] + summary["unmatched"] == summary["total"]

    override = read_json(env["tmp_path"] / "override.json")
    assert override == {
        ROM_PATHS[HASH_A]: "Juego A (USA).zip",
        ROM_PATHS[HASH_B]: "Juego B (USA).zip",
        ROM_PATHS[HASH_C]: "Juego C (Japan).zip",
    }

    missing_txt = (env["tmp_path"] / "missing.txt").read_text(encoding="utf-8")
    assert HASH_HUERFANO in missing_txt
    assert ROM_PATHS[HASH_HUERFANO] in missing_txt
    assert HASH_A not in missing_txt

    out = capsys.readouterr().out
    assert "[final]" in out
    assert "4 totales, 3 con match, 1 sin match" in out
    assert "Candidatos fallidos: 0" in out


def test_cache_vacio_parcial_marca_todo_como_faltante(env, capsys):
    resync = env["make_resync"]()
    summary = resync.write_outputs({}, partial=True)

    assert summary["unmatched"] == summary["total"] == len(ROM_PATHS)
    assert summary["matched"] == 0
    assert summary["partial"] is True

    missing_txt = (env["tmp_path"] / "missing.txt").read_text(encoding="utf-8")
    for h in ROM_PATHS:
        assert h in missing_txt

    out = capsys.readouterr().out
    assert "PARCIAL" in out


def test_todo_fallido_deja_override_vacio_y_faltantes_completos(env):
    for name in env["state"]["candidates"]:
        env["state"]["candidates"][name] = RuntimeError("error de red (simulado)")
    summary = env["make_resync"]().run()

    assert summary["matched"] == 0
    assert summary["unmatched"] == summary["total"] == len(ROM_PATHS)
    assert summary["failed"] == len(GOOD_CANDIDATES)

    assert read_json(env["tmp_path"] / "override.json") == {}
    missing_txt = (env["tmp_path"] / "missing.txt").read_text(encoding="utf-8")
    for h in ROM_PATHS:
        assert h in missing_txt
    failed_txt = (env["tmp_path"] / "failed.txt").read_text(encoding="utf-8")
    assert f"# {len(GOOD_CANDIDATES)} candidatos fallidos" in failed_txt


def test_corrida_repetida_es_idempotente(env):
    env["make_resync"]().run()
    first = {
        name: (env["tmp_path"] / name).read_bytes()
        for name in ("override.json", "missing.txt", "failed.txt")
    }
    env["make_resync"]().run()
    for name, content in first.items():
        assert (env["tmp_path"] / name).read_bytes() == content


def test_cache_viejo_en_formato_string_se_migra(env):
    # Cache del formato anterior: filename -> hash (o "" si fallo).
    legacy = {"Juego A (USA).zip": _ra_hash(ROM_A), "Juego B (USA).zip": ""}
    (env["tmp_path"] / ".cache.json").write_text(json.dumps(legacy), encoding="utf-8")

    env["calls"].clear()
    summary = env["make_resync"]().run()

    # A salio del cache migrado sin descargarse; B (fallo viejo) se reintento.
    assert "Juego A (USA).zip" not in env["calls"]
    assert env["calls"]["Juego B (USA).zip"] == 1
    assert summary["matched"] == 3
