"""
Resincroniza la fuente de descarga de una consola contra un item nuevo de
archive.org, cuando el item viejo murio y el nuevo tiene una estructura de
carpetas/nombres distinta.

No alcanza con comparar nombres de archivo (la nomenclatura puede diferir
entre colecciones) ni con el MD5 que expone la metadata de archive.org (es
el hash del .zip, no el de la ROM que RetroAchievements espera). Por eso
este script descarga cada candidato, lo descomprime, calcula el hash al
estilo RetroAchievements sobre la ROM de adentro, y matchea contra los
hashes que ya tenemos en Data/TamperMonkeyRetroachievements.json. Lo que no
matchea queda listado aparte para resolver a mano.

El job puede tardar bastante (un archivo por request a archive.org) y
cortarse a mitad de camino, asi que el cache de progreso se persiste en
disco despues de CADA candidato procesado, con estado "ok" (hash calculado)
o "failed" (descarga/descompresion fallida, con el motivo). Al reiniciar se
saltean los "ok" y se reintentan los "failed". Los fallos no abortan la
ronda: se anotan y se reportan juntos al final en
Data/<label>_failed_candidates.txt.
"""

import hashlib
import io
import json
import os
import sys
import time
import zipfile
from typing import Dict, List, Tuple

import requests

import config

from .rom_info import extract_game_name, get_console_from_rom_path

MAX_ATTEMPTS = 3  # shortcut: reintentos fijos sin backoff, igual que el resto de los sync scripts
REQUEST_TIMEOUT = 30

# Estados posibles de un candidato en el cache en disco.
CACHE_STATUS_OK = "ok"
CACHE_STATUS_FAILED = "failed"


def _safe_console_text(text: str) -> str:
    try:
        encoding = sys.stdout.encoding or "utf-8"
        return text.encode(encoding, errors="replace").decode(encoding)
    except Exception:
        return text


def _ra_hash(data: bytes, header_modulus: int = 8192) -> str:
    """Hash estilo RetroAchievements: MD5, salvo que el tamano sea 512 bytes
    mas que un multiplo de `header_modulus` (header de copiadora), en cuyo
    caso se ignoran los primeros 512 bytes. La regla (confirmada en
    docs.retroachievements.org) es igual en espiritu para varias consolas
    pero el modulo cambia: SNES/Super Famicom usa 8KB (8192), PC Engine/
    TurboGrafx-16/SuperGrafx (cartucho) usa 128KB (131072)."""
    if len(data) % header_modulus == 512:
        data = data[512:]
    return hashlib.md5(data).hexdigest()


def _get_with_retries(url: str, **kwargs) -> requests.Response:
    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            response = requests.get(url, timeout=REQUEST_TIMEOUT, **kwargs)
            if response.status_code == 200:
                return response
            last_error = f"status {response.status_code}"
        except requests.RequestException as e:
            last_error = f"error de red ({e})"
        if attempt < MAX_ATTEMPTS:
            time.sleep(1)
    raise RuntimeError(f"{url}: {last_error} (despues de {MAX_ATTEMPTS} intentos)")


class SourceResync:
    """Orquesta el resync de la fuente de descarga de una consola."""

    def __init__(self, console: str, item: str, label: str = None, header_modulus: int = 8192):
        # `console` puede ser una sola consola o varias separadas por coma
        # (ej: "TurboGrafx-16,PC Engine" -- dos valores distintos de
        # get_console_from_rom_path que en la practica son la misma
        # plataforma, por un merge viejo de datos con folders distintos).
        self.consoles = [c.strip() for c in console.split(",")]
        self.item = item
        self.base_url = f"https://archive.org/download/{item}/"
        file_label = (label or self.consoles[0]).lower().replace(" ", "_")
        self.override_file = f"Data/{file_label}_source_override.json"
        self.missing_file = f"Data/{file_label}_missing_sources.txt"
        # Candidatos del item nuevo que no se pudieron descargar/descomprimir
        # (nombre + motivo), para distinguirlos de los hashes sin match.
        self.failed_file = f"Data/{file_label}_failed_candidates.txt"
        # Cache de progreso por candidato: {filename: {"status": "ok",
        # "hash": ...} | {"status": "failed", "error": ...}}. Se reescribe
        # despues de procesar cada archivo, asi un corte a mitad de camino
        # no pierde nada de lo ya hecho.
        self.cache_file = f"Data/.{file_label}_hash_cache.json"
        self.header_modulus = header_modulus

    # Extensiones de ROM cruda que se hashean directo, sin descomprimir.
    RAW_EXTENSIONS = (".pce", ".sgx", ".sfc", ".smc", ".nes", ".bin", ".gb", ".gbc", ".gba")

    def _fetch_item_files(self) -> List[Tuple[str, int]]:
        """Devuelve [(nombre, tamano)] de los archivos descargables del item
        nuevo (.zip, o ROMs crudas sin comprimir)."""
        response = _get_with_retries(f"https://archive.org/metadata/{self.item}")
        data = response.json()
        return [
            (f["name"], int(f.get("size", 0)))
            for f in data.get("files", [])
            if f.get("name", "").lower().endswith((".zip",) + self.RAW_EXTENSIONS)
        ]

    def _hash_candidate(self, filename: str) -> str:
        """Descarga un archivo del item nuevo y devuelve el hash estilo RA
        de la ROM. Si es .zip, extrae el archivo mas grande de adentro;
        si no, hashea el archivo tal cual (ya es la ROM cruda). Levanta
        RuntimeError con el motivo si algo sale mal (red, zip corrupto,
        zip vacio) -- el caller lo anota en el cache y sigue con el proximo."""
        url = self.base_url + requests.utils.quote(filename, safe="")
        try:
            content = _get_with_retries(url).content
            if filename.lower().endswith(".zip"):
                with zipfile.ZipFile(io.BytesIO(content)) as zf:
                    infos = [i for i in zf.infolist() if not i.is_dir()]
                    if not infos:
                        raise RuntimeError("zip vacio (sin archivos adentro)")
                    largest = max(infos, key=lambda i: i.file_size)
                    rom_bytes = zf.read(largest)
            else:
                rom_bytes = content
        except zipfile.BadZipFile as e:
            raise RuntimeError(f"zip corrupto ({e})") from e
        return _ra_hash(rom_bytes, self.header_modulus)

    def _load_our_hashes(self) -> Dict[str, str]:
        """{hash: rom_path} de todas las entradas de las consolas pedidas en
        Data/TamperMonkeyRetroachievements.json."""
        with open(config.JSON_FILE_PATH, encoding="utf-8") as f:
            data = json.load(f)
        ours: Dict[str, str] = {}
        for game_id, versions in data.items():
            for item in versions:
                for hash_value, rom_path in item.items():
                    if get_console_from_rom_path(rom_path) in self.consoles:
                        ours[hash_value.upper()] = rom_path
        return ours

    @staticmethod
    def _normalize_cache_entry(value) -> dict:
        """Normaliza una entrada de cache al formato {status, hash|error}.
        Acepta el formato viejo (filename -> hash en string, "" si fallo)
        para no tirar el progreso de corridas anteriores al cambio."""
        if isinstance(value, dict) and value.get("status") in (CACHE_STATUS_OK, CACHE_STATUS_FAILED):
            return value
        if isinstance(value, str):
            if value:
                return {"status": CACHE_STATUS_OK, "hash": value}
            return {"status": CACHE_STATUS_FAILED, "error": "fallo registrado por un cache viejo (sin detalle)"}
        return {"status": CACHE_STATUS_FAILED, "error": f"entrada de cache invalida: {value!r}"}

    def _load_cache(self) -> Dict[str, dict]:
        if not os.path.exists(self.cache_file):
            return {}
        with open(self.cache_file, encoding="utf-8") as f:
            raw = json.load(f)
        return {name: self._normalize_cache_entry(value) for name, value in raw.items()}

    def _save_cache(self, cache: Dict[str, dict]):
        """Persiste el cache de forma atomica (tmp + replace) para que un
        corte durante la escritura no deje un JSON corrupto."""
        directory = os.path.dirname(self.cache_file)
        if directory:
            os.makedirs(directory, exist_ok=True)
        tmp_file = self.cache_file + ".tmp"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=1, sort_keys=True)
        os.replace(tmp_file, self.cache_file)

    def run(self) -> dict:
        consoles_label = ", ".join(self.consoles)
        print(f"Resync de {consoles_label} contra el item '{self.item}' de archive.org...")

        our_hashes = self._load_our_hashes()
        print(f"{len(our_hashes)} hashes de {consoles_label} en nuestra base.")

        files = self._fetch_item_files()
        print(f"{len(files)} archivos en el item nuevo. Descargando y hasheando...")

        cache = self._load_cache()
        if cache:
            done = sum(1 for e in cache.values() if e["status"] == CACHE_STATUS_OK)
            failed = len(cache) - done
            print(f"Retomando desde cache: {done} hasheados, {failed} fallidos (se reintentan).")

        for i, (filename, _size) in enumerate(files, start=1):
            entry = cache.get(filename)
            if entry and entry["status"] == CACHE_STATUS_OK:
                continue  # ya procesado bien: no volver a descargar
            # Los "failed" (y los que nunca se tocaron) se (re)intentan.
            print(f"[{i}/{len(files)}] {_safe_console_text(filename)}")
            try:
                h = self._hash_candidate(filename)
            except Exception as e:
                # Un candidato roto no aborta la ronda: se anota con motivo
                # y se sigue. Queda "failed" en el cache, asi que la proxima
                # corrida lo reintenta.
                cache[filename] = {"status": CACHE_STATUS_FAILED, "error": str(e)}
                print(f"  [!] {_safe_console_text(filename)}: {e}")
            else:
                cache[filename] = {"status": CACHE_STATUS_OK, "hash": h}
            # Persistir despues de CADA candidato: si el job se corta aca,
            # el proximo run retoma exactamente desde este punto.
            self._save_cache(cache)

        return self.write_outputs(cache, our_hashes, partial=False)

    def write_outputs(self, cache: Dict[str, dict], our_hashes: Dict[str, str] = None, partial: bool = True) -> dict:
        """Arma override_file/missing_file/failed_file a partir de lo que
        haya en el cache en este momento. Se puede llamar con un cache a
        medio terminar (partial=True) para tener un preview mientras el
        resync completo sigue corriendo -- se reescribe igual al final con
        el cache completo. Devuelve el resumen de numeros del reporte."""
        if our_hashes is None:
            our_hashes = self._load_our_hashes()

        cache = {name: self._normalize_cache_entry(value) for name, value in cache.items()}

        new_hash_to_filename: Dict[str, str] = {}
        failures: List[Tuple[str, str]] = []  # (filename, motivo)
        for filename, entry in cache.items():
            if entry["status"] == CACHE_STATUS_OK and entry.get("hash"):
                new_hash_to_filename[entry["hash"].upper()] = filename
            elif entry["status"] == CACHE_STATUS_FAILED:
                failures.append((filename, entry.get("error", "error desconocido")))

        override: Dict[str, str] = {}
        missing: List[Tuple[str, str, str]] = []  # (nombre, rom_path, hash)
        for hash_value, rom_path in our_hashes.items():
            filename = new_hash_to_filename.get(hash_value)
            if filename:
                override[rom_path] = filename
            else:
                missing.append((extract_game_name(rom_path), rom_path, hash_value))

        self._write_text_outputs(override, missing, failures)

        total = len(our_hashes)
        matched = len(override)
        unmatched = len(missing)
        pct = (matched / total * 100) if total else 0
        label = "PARCIAL -- resync todavia corriendo, numeros incompletos" if partial else "final"
        print(f"\n[{label}] Hashes de {', '.join(self.consoles)}: {total} totales, "
              f"{matched} con match, {unmatched} sin match ({pct:.1f}% de cobertura).")
        print(f"Candidatos fallidos: {len(failures)} (detalle en {self.failed_file}).")
        print(f"Override: {self.override_file}")
        partial_note = " -- incluye lo todavia no hasheado" if partial else ""
        print(f"Faltantes: {self.missing_file} ({len(missing)}{partial_note})")

        return {
            "total": total,
            "matched": matched,
            "unmatched": unmatched,
            "failed": len(failures),
            "partial": partial,
        }

    def _write_text_outputs(self, override: Dict[str, str], missing: List[Tuple[str, str, str]],
                            failures: List[Tuple[str, str]]):
        for path in (self.override_file, self.missing_file, self.failed_file):
            directory = os.path.dirname(path)
            if directory:
                os.makedirs(directory, exist_ok=True)

        with open(self.override_file, "w", encoding="utf-8") as f:
            json.dump(override, f, ensure_ascii=False, indent=2, sort_keys=True)

        missing.sort(key=lambda x: x[0].lower())
        with open(self.missing_file, "w", encoding="utf-8") as f:
            for name, rom_path, hash_value in missing:
                f.write(f"{name}\t{rom_path}\t{hash_value}\n")

        failures.sort(key=lambda x: x[0].lower())
        with open(self.failed_file, "w", encoding="utf-8") as f:
            f.write(f"# {len(failures)} candidatos fallidos (descarga o descompresion)\n")
            for filename, reason in failures:
                f.write(f"{filename}\t{reason}\n")


if __name__ == "__main__":
    assert _ra_hash(b"x" * 8192) == hashlib.md5(b"x" * 8192).hexdigest()
    headered = b"h" * 512 + b"x" * 8192
    assert _ra_hash(headered) == hashlib.md5(b"x" * 8192).hexdigest()
    print("source_resync smoke check: OK")
