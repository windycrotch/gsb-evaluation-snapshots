"""Per-chart history snapshots, used to derive previous ranks where a site gives none.

A snapshot is stored as ``data/history/<source>/<chart>/<period_key>.json``.  Ranks from
the latest snapshot strictly older than the current period are used for ``last_rank`` and
``is_new``.  When that snapshot is missing, unreadable, empty or the period key cannot be
trusted, both fields stay ``None``: "unknown" is honest, "everything is new" is not.
"""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

# Fields kept in a snapshot.  Extra per-row annotations (genres, links, BPM...) are
# deliberately dropped so the history files stay small and stable.
SNAPSHOT_FIELDS = ("rank", "title", "artist", "song_no", "song_url")

# Dates as the sites print them: 2026/10/26, 2026-10-26, 2026.10.26, 2026/10.
_DATE = re.compile(r"(?<!\d)(\d{4})\s*[/.\-]\s*(\d{1,2})(?:\s*[/.\-]\s*(\d{1,2}))?")
# A period key is one or two dates joined by an underscore: 2026-10-26_2026-11-01.
# Month-only keys (JOYSOUND's monthly chart gives "2026/10") are allowed too.
_KEY_SHAPE = re.compile(r"\d{4}-\d{2}(?:-\d{2})?(?:_\d{4}-\d{2}(?:-\d{2})?)?")
_DATE_PART = re.compile(r"(\d{4})-(\d{2})(?:-(\d{2}))?")


def _valid_date_part(year: str, month: str, day: str | None) -> bool:
    if not 1 <= int(month) <= 12:
        return False
    return day is None or 1 <= int(day) <= 31


def valid_key(key: str | None) -> bool:
    """True when `key` looks like a period key we can order lexicographically."""
    if not key or not _KEY_SHAPE.fullmatch(key):
        return False
    return all(_valid_date_part(year, month, day or None)
               for year, month, day in _DATE_PART.findall(key))


def period_key(period: str | None, fallback: str) -> str:
    """Turn '2026/10/26 ~ 2026/11/01' into '2026-10-26_2026-11-01' (sortable file name).

    Understands slashes, dashes and dots, full-width characters, and month-only periods.
    Falls back to `fallback` when the period is missing or has no usable date.
    """
    text = unicodedata.normalize("NFKC", "" if period is None else str(period))
    parts = []
    for year, month, day in _DATE.findall(text):
        if not _valid_date_part(year, month, day or None):
            continue
        key = f"{int(year):04d}-{int(month):02d}"
        if day:
            key += f"-{int(day):02d}"
        parts.append(key)
        if len(parts) == 2:  # a period is a start and an end, never more
            break
    return "_".join(parts) if parts else fallback


def normalize(text: str | None) -> str:
    """Case- and width-insensitive identity text: 'ＡＢＣ' == 'abc'."""
    text = unicodedata.normalize("NFKC", "" if text is None else str(text)).casefold()
    return re.sub(r"\s+", "", text)


def song_key(row: dict) -> str:
    """Stable identity for a song within one source.

    Prefers the site's own song number, then its URL, then title + artist.  Normalization
    folds full-width characters and case so the same song matches across snapshots.
    """
    number = normalize(row.get("song_no"))
    if number:
        return "no:" + number
    url = normalize(row.get("song_url"))
    if url:
        return "url:" + url
    title, artist = normalize(row.get("title")), normalize(row.get("artist"))
    if not title and not artist:
        return ""
    return "ta:" + title + "|" + artist


def _rank(value) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str) and value.strip().isdigit():
        number = int(value.strip())
        return number if number > 0 else None
    return None


def build_index(rows: list) -> tuple[dict[str, int], dict[str, int], dict[str, int]] | None:
    """Index a snapshot's rows by song number, URL and title+artist.

    A row can be found by any of the three, in that order, so a snapshot saved before a
    site started exposing (say) song numbers still matches today's rows by title/artist.
    Returns None when no row carries a usable rank.
    """
    by_no: dict[str, int] = {}
    by_url: dict[str, int] = {}
    by_title_artist: dict[str, int] = {}
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        rank = _rank(row.get("rank"))
        if rank is None:
            continue
        number = normalize(row.get("song_no"))
        url = normalize(row.get("song_url"))
        title, artist = normalize(row.get("title")), normalize(row.get("artist"))
        if number:
            by_no.setdefault(number, rank)
        if url:
            by_url.setdefault(url, rank)
        if title or artist:
            by_title_artist.setdefault(f"{title}|{artist}", rank)
    if not (by_no or by_url or by_title_artist):
        return None
    return by_no, by_url, by_title_artist


def lookup_rank(row: dict, index: tuple[dict[str, int], dict[str, int], dict[str, int]]) -> int | None:
    by_no, by_url, by_title_artist = index
    number = normalize(row.get("song_no"))
    if number and number in by_no:
        return by_no[number]
    url = normalize(row.get("song_url"))
    if url and url in by_url:
        return by_url[url]
    title, artist = normalize(row.get("title")), normalize(row.get("artist"))
    if title or artist:
        return by_title_artist.get(f"{title}|{artist}")
    return None


class History:
    def __init__(self, root: Path):
        self.root = root

    def _dir(self, source: str, chart: str) -> Path:
        return self.root / source / chart

    def save(self, source: str, chart: dict) -> None:
        """Write the snapshot for this period, or nothing if it could not be trusted."""
        key = chart.get("period_key")
        if not valid_key(key):
            return
        rows = [
            {k: r.get(k) for k in SNAPSHOT_FIELDS if r.get(k) is not None}
            for r in chart.get("rows") or []
            if isinstance(r, dict)
        ]
        if not rows:  # never let an empty chart become "last period had no songs"
            return
        d = self._dir(source, chart["id"])
        d.mkdir(parents=True, exist_ok=True)
        payload = {"period": chart.get("period"), "rows": rows}
        (d / f"{key}.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
        )

    def previous(self, source: str, chart_id: str, key: str) -> dict | None:
        """The latest snapshot strictly older than `key`, or None.

        Only that one file is considered.  If it is unreadable or has no rows, the answer is
        "unknown" rather than "look further back": a two-period-old rank would show a wrong
        movement, and an empty snapshot would mark the whole chart as new.
        """
        if not valid_key(key):
            return None
        d = self._dir(source, chart_id)
        if not d.is_dir():
            return None
        older = max((p for p in d.glob("*.json") if valid_key(p.stem) and p.stem < key),
                    key=lambda p: p.stem, default=None)
        if older is None:
            return None
        try:
            payload = json.loads(older.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list) or not payload["rows"]:
            return None
        return payload

    def fill_previous_ranks(self, source: str, chart: dict) -> None:
        """Set last_rank / is_new from the previous snapshot. Leaves None when there is none."""
        rows = chart.get("rows") or []
        prev = self.previous(source, chart["id"], chart.get("period_key"))
        index = build_index(prev["rows"]) if prev else None
        if index is None:
            for r in rows:
                r["last_rank"] = None
                r["is_new"] = None
            return
        for r in rows:
            last = lookup_rank(r, index)
            r["last_rank"] = last
            r["is_new"] = last is None
