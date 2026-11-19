"""Staging, commit and the workspace lock for a layer export (docs/decisions.md ADR-35).

`options.layer_export` (ADR-30) is one directory of layer files plus `manifest.json`. Writing those straight into the
target directory made a failed element leave half-written files beside a manifest describing other ones. This module
gives the export one lifecycle instead:

- every run writes its layers and its manifest into a hidden staging directory *inside* the target directory
  (`<directory>/.motion-graphics-layers-<token>.tmp/`), so the previous complete result (manifest included) stays in
  place, unchanged, while the new one is rendered;
- `commit()` moves the previous result's files into a hidden backup, moves the staged files into place and writes the
  manifest **last** (a single rename: the commit point), verifies every final file's size and sha256 against the
  manifest, and only then deletes the backup. A failure at any point rolls the backup back, so the target is the
  previous complete result again;
- `abort()` deletes this run's staging and backup directories, used when an element fails (or anything else does)
  before the commit point. The previous result is untouched: the target is never written to before commit;
- `sweep()` removes staging/backup directories a crashed run left behind. It is only called while the workspace lock
  is held (see `WorkspaceLock`), so no live exporter can own them; a backup holding the only manifest is restored
  first, so a crash mid-commit does not lose the previous complete result.

The workspace lock is one lock file per workspace, held from before the overwrite checks until the export has
finished. Two exports in the same workspace therefore never stage into each other's directories or interleave
manifests: the later one fails with `OUTPUT_ERROR`, `details.reason` `layer_export_busy`, `retryable: true` (callers
may retry once the first one is done). `fcntl` is used on POSIX and `msvcrt` on Windows; an in-process registry makes
threads of one process conflict too, where an OS byte-range lock might not.

This module does file-system work only; the request option and the manifest shape stay in `layerexport.py`.
"""
from __future__ import annotations

import json
import os
import shutil
import threading
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

try:  # POSIX
    import fcntl as _fcntl
except ImportError:  # pragma: no cover - Windows
    _fcntl = None  # type: ignore[assignment]
try:  # Windows
    import msvcrt as _msvcrt
except ImportError:  # pragma: no cover - POSIX
    _msvcrt = None  # type: ignore[assignment]

from .canonical import sha256_file, sha256_text
from .errors import MotionGraphicsError

STAGING_PREFIX = ".motion-graphics-layers-"
BACKUP_PREFIX = ".motion-graphics-backup-"
STAGING_SUFFIX = ".tmp"
LAYER_LOCK_NAME = "layer-export.lock"

# Threads of one process: flock() is per open file description and msvcrt byte locks are per process, so neither is a
# reliable test of "this workspace already has an export running" between two Python threads. This registry is.
_PROCESS_LOCKS: set = set()
_PROCESS_GUARD = threading.Lock()


def new_token() -> str:
    """A per-run name fragment for the staging and backup directories (never part of an identity)."""
    return os.urandom(8).hex()


def _safe_owned_name(name: Any) -> Optional[str]:
    """A file name taken from a previous manifest, only when it is a plain name in the target directory (never a path)."""
    if not isinstance(name, str) or not name or name in (".", ".."):
        return None
    if os.path.basename(name) != name or "/" in name or "\\" in name or "\x00" in name:
        return None
    if name.startswith(STAGING_PREFIX) or name.startswith(BACKUP_PREFIX):
        return None
    return name


class WorkspaceLock:
    """A non-blocking exclusive lock on one lock file, released by the OS even if the process dies."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.key = os.path.normcase(os.path.abspath(str(self.path)))
        self._fd: Optional[int] = None

    @property
    def held(self) -> bool:
        return self._fd is not None

    def acquire(self) -> bool:
        with _PROCESS_GUARD:
            if self.key in _PROCESS_LOCKS:
                return False
            try:
                fd = os.open(str(self.path), os.O_RDWR | os.O_CREAT, 0o644)
            except OSError:
                return False
            try:
                if os.fstat(fd).st_size == 0:
                    os.write(fd, b"\0")  # a byte for msvcrt to lock
                if not self._os_try_lock(fd):
                    os.close(fd)
                    return False
            except OSError:
                os.close(fd)
                return False
            _PROCESS_LOCKS.add(self.key)
            self._fd = fd
            return True

    def release(self) -> None:
        if self._fd is None:
            return
        fd, self._fd = self._fd, None
        with _PROCESS_GUARD:
            _PROCESS_LOCKS.discard(self.key)
        try:
            self._os_unlock(fd)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass

    @staticmethod
    def _os_try_lock(fd: int) -> bool:
        if _fcntl is not None:
            _fcntl.flock(fd, _fcntl.LOCK_EX | _fcntl.LOCK_NB)
            return True
        if _msvcrt is not None:  # pragma: no cover - exercised on Windows
            os.lseek(fd, 0, os.SEEK_SET)
            _msvcrt.locking(fd, _msvcrt.LK_NBLCK, 1)
            return True
        return False

    @staticmethod
    def _os_unlock(fd: int) -> None:
        if _fcntl is not None:
            _fcntl.flock(fd, _fcntl.LOCK_UN)
        elif _msvcrt is not None:  # pragma: no cover - exercised on Windows
            os.lseek(fd, 0, os.SEEK_SET)
            _msvcrt.locking(fd, _msvcrt.LK_UNLCK, 1)


def sweep(directory: Path, manifest_name: str) -> None:
    """Clean up what a crashed run left in `directory`, while the workspace lock is held.

    A staging directory is always this export's own work and is deleted. A backup directory holds the previous
    result's files and a journal of what the crashed commit was doing: if the target has no manifest (the crash
    happened between moving the old manifest out and writing the new one), the old files are restored and the new ones
    the journal names are removed, so the target is the previous complete result again -- exactly one manifest and its
    files. If the target has a manifest, the commit point was reached and the backup is only stale files.
    """
    if not directory.is_dir():
        return
    try:
        entries = sorted(directory.iterdir(), key=lambda p: p.name)
    except OSError:
        return
    for entry in entries:
        if entry.name.startswith(BACKUP_PREFIX) and entry.is_dir():
            journal = _read_journal(entry)
            if not (directory / manifest_name).exists():
                fresh = journal.get("new") or []
                for name in fresh:
                    if _safe_owned_name(name) == name and name != manifest_name:
                        try:
                            (directory / name).unlink()
                        except OSError:
                            pass
                try:
                    for f in sorted(entry.iterdir(), key=lambda p: p.name):
                        if f.is_file() and f.name != JOURNAL_NAME:
                            os.replace(str(f), str(directory / f.name))
                except OSError:
                    pass
            shutil.rmtree(entry, ignore_errors=True)
        elif entry.name.startswith(STAGING_PREFIX) and entry.is_dir():
            shutil.rmtree(entry, ignore_errors=True)


JOURNAL_NAME = ".commit-journal.json"


def _read_journal(backup: Path) -> Dict[str, Any]:
    try:
        data = json.loads((backup / JOURNAL_NAME).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


class LayerStaging:
    """One export run's staging directory and the commit/rollback protocol for the target directory."""

    def __init__(self, directory: Path, token: Optional[str] = None):
        self.directory = Path(directory)
        self.token = token or new_token()
        self.staging = self.directory / f"{STAGING_PREFIX}{self.token}{STAGING_SUFFIX}"
        self.backup = self.directory / f"{BACKUP_PREFIX}{self.token}{STAGING_SUFFIX}"
        self.committed = False
        self.opened = False
        self.created_directory = False

    # ---- staging
    def prepare(self, manifest_name: str) -> "LayerStaging":
        """Create the target and this run's staging directory; remove a crashed run's leftovers (lock held)."""
        self.created_directory = not self.directory.exists()
        self.directory.mkdir(parents=True, exist_ok=True)
        sweep(self.directory, manifest_name)
        self.staging.mkdir()
        self.opened = True
        return self

    def path(self, file_name: str) -> Path:
        return self.staging / file_name

    def write_manifest(self, text: str, manifest_name: str) -> None:
        # bytes, not write_text: the committed sha256 is the hash of exactly these bytes on every platform (no CRLF translation)
        self.path(manifest_name).write_bytes(text.encode("utf-8"))

    # ---- commit
    def commit(self, layer_files: Sequence[str], manifest_name: str, manifest_text: str,
               expected: Dict[str, Tuple[int, str]]) -> str:
        """Replace the target's files with this run's, manifest last; return the committed manifest's sha256.

        The previous result's files (the ones this export owns: the manifest, the old manifest's files, and any of the
        new names) go into a backup directory first, so the target never holds a manifest that does not describe its
        files. Every moved layer file is checked (size, sha256) before the manifest commit point; any failure restores
        the backup and leaves the previous complete result in place.
        """
        target = self.directory
        manifest_path = target / manifest_name
        old = self._owned_existing(layer_files, manifest_name)
        moved_old: List[str] = []
        moved_new: List[str] = []
        try:
            if old:
                self.backup.mkdir()
                # the journal names what the commit is about to do, so a run that dies here can be undone by the next one:
                # its new files removed, the old ones moved back, exactly one manifest left in the target
                (self.backup / JOURNAL_NAME).write_text(json.dumps({"new": list(layer_files) + [manifest_name], "old": old}), encoding="utf-8")
                for name in old:
                    os.replace(str(target / name), str(self.backup / name))
                    moved_old.append(name)
            for name in layer_files:
                os.replace(str(self.staging / name), str(target / name))
                moved_new.append(name)
            self._verify(target, layer_files, expected)
            os.replace(str(self.staging / manifest_name), str(manifest_path))
            moved_new.append(manifest_name)
            if sha256_file(str(manifest_path)) != sha256_text(manifest_text):
                raise MotionGraphicsError("OUTPUT_ERROR", "the layer manifest changed while it was committed",
                                          {"reason": "layer_export_verification_failed", "path": str(manifest_path)}, retryable=True)
        except MotionGraphicsError as e:
            problems = self._rollback(moved_new, moved_old, manifest_name)
            e.details["rollback_ok"] = not problems
            if problems:
                e.details["rollback_problems"] = problems
            raise
        except OSError as e:
            problems = self._rollback(moved_new, moved_old, manifest_name)
            raise MotionGraphicsError("OUTPUT_ERROR", f"the layer export could not be committed: {e}",
                                      {"reason": "layer_export_commit_failed", "directory": str(target), "rollback_ok": not problems,
                                       "rollback_problems": problems}, retryable=True)
        self.committed = True
        self._cleanup()
        return sha256_text(manifest_text)

    def _owned_existing(self, layer_files: Sequence[str], manifest_name: str) -> List[str]:
        """This export's files already in the target: its manifest, the files that manifest lists, and the new names."""
        target = self.directory
        names: List[str] = [manifest_name]
        if (target / manifest_name).is_file():
            try:
                old_doc = json.loads((target / manifest_name).read_text(encoding="utf-8"))
                for layer in old_doc.get("layers") or []:
                    if isinstance(layer, dict):
                        name = _safe_owned_name(layer.get("file"))
                        if name is not None:
                            names.append(name)
            except (OSError, ValueError, AttributeError):
                pass  # an unreadable manifest is replaced as a whole; its stray files are handled by sweep()
        names.extend(_safe_owned_name(n) or n for n in layer_files)
        present = [n for n in dict.fromkeys(names) if n and (target / n).is_file()]
        present.sort(key=lambda n: (n != manifest_name, n))  # the manifest goes first: no stale authority while committing
        return present

    @staticmethod
    def _verify(target: Path, layer_files: Sequence[str], expected: Dict[str, Tuple[int, str]]) -> None:
        for name in layer_files:
            path = target / name
            size, sha = expected[name]
            if not path.is_file() or path.stat().st_size != size or sha256_file(str(path)) != sha:
                raise MotionGraphicsError("OUTPUT_ERROR", f"the committed layer {name!r} does not match the manifest's size and sha256",
                                          {"reason": "layer_export_verification_failed", "file": name, "path": str(path)}, retryable=True)

    def _rollback(self, moved_new: Sequence[str], moved_old: Sequence[str], manifest_name: str) -> List[str]:
        problems: List[str] = []
        target = self.directory
        for name in reversed(list(moved_new)):
            try:
                (target / name).unlink()
            except FileNotFoundError:
                pass
            except OSError as e:
                problems.append(f"{name}: {e}")
        for name in reversed(list(moved_old)):  # the manifest was moved out first, so it is restored last
            try:
                os.replace(str(self.backup / name), str(target / name))
            except OSError as e:
                problems.append(f"{name}: {e}")
        if not problems:
            try:
                (self.backup / JOURNAL_NAME).unlink()  # the commit is undone: there is nothing left for sweep() to recover
            except OSError:
                pass
        return problems

    # ---- cleanup
    def abort(self) -> None:
        """Delete this run's staging and backup directories; never raises. The target itself is not touched here (except for
        removing the directory itself when this run created it and nothing was committed into it)."""
        self._cleanup()

    def _cleanup(self) -> None:
        for path in (self.staging, self.backup):
            shutil.rmtree(path, ignore_errors=True)
        if not self.committed and self.created_directory:
            try:
                self.directory.rmdir()  # only when this run left it empty: a failed export leaves no directory behind either
            except OSError:
                pass
