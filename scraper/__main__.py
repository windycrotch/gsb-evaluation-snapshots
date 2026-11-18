"""Fetch every source and write site/data/<source>.json.

    python -m scraper                # all sources
    python -m scraper holiday dam    # only some

A job that fails keeps the charts it declares from the previous run (marked stale), so one
broken site never blanks the page.  A chart is never published with no rows: when there is
nothing to fall back to, the chart is left out and the failure is listed under the source's
``errors``.  Exit code is 1 only when every job of every source failed.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import traceback
from pathlib import Path

from . import enrich
from .history import History, period_key
from .sources import ALL

ROOT = Path(__file__).resolve().parent.parent
SITE_DATA = ROOT / "site" / "data"
HISTORY = ROOT / "data" / "history"
TZ = dt.timezone(dt.timedelta(hours=8))  # display times in Taiwan time


def now_iso() -> str:
    return dt.datetime.now(TZ).isoformat(timespec="seconds")


def load_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def stale_chart(chart: dict) -> dict:
    """A previous copy of a chart, marked as showing older data."""
    old = dict(chart)
    old["stale"] = True
    old["rows"] = list(chart.get("rows") or [])
    return old


def run_source(module, history: History) -> tuple[dict, int, int]:
    src = module.SOURCE
    label = src["name"]["zh"] if isinstance(src["name"], dict) else src["name"]
    out_path = SITE_DATA / f"{src['id']}.json"
    previous = {
        c["id"]: c
        for c in load_json(out_path).get("charts", [])
        if isinstance(c, dict) and c.get("id")
    }
    today = dt.datetime.now(TZ).date().isoformat()

    charts: list[dict] = []
    errors: list[str] = []
    ok_jobs = 0

    def keep_previous(chart_id: str) -> bool:
        """Republish the previous copy of `chart_id`; False when there is nothing to keep."""
        old = previous.get(chart_id)
        if old and old.get("rows"):
            charts.append(stale_chart(old))
            return True
        return False

    def fail(job: str, reason: str, declared: list[str]) -> None:
        """Record one failure, noting any chart that has no previous copy to fall back on."""
        missing = [cid for cid in declared if not keep_previous(cid)]
        msg = f"{job}: {reason}"
        if missing:
            msg += f"; no previous copy to keep for {', '.join(missing)}"
        errors.append(msg)

    for job in module.JOBS:
        declared = list(job["charts"])
        try:
            fresh = job["fetch"]()
        except Exception as exc:  # noqa: BLE001 - any failure falls back to old data
            print(f"::warning title={label} {job['name']} failed::{exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            fail(job["name"], str(exc), declared)
            continue

        fetched: dict[str, dict] = {}
        for chart in fresh or []:
            if isinstance(chart, dict) and chart.get("id") and chart.get("rows"):
                fetched.setdefault(chart["id"], chart)

        # A job can also come back with only some of the charts it declared.  Keep the
        # previous copy of the missing ones rather than letting them vanish from the page.
        undelivered = [cid for cid in declared if cid not in fetched]
        if undelivered:
            fail(job["name"], f"missing from the response: {', '.join(undelivered)}", undelivered)

        stamp = now_iso()
        for cid, chart in fetched.items():
            chart["period_key"] = period_key(chart.get("period"), today)
            chart["rank_change"] = chart.pop("prev_from", "site")  # "site" or "history"
            if chart["rank_change"] == "history":
                history.fill_previous_ranks(src["id"], chart)
            history.save(src["id"], chart)
            chart["fetched_at"] = stamp
            chart["stale"] = False
            charts.append(chart)
        if fetched:
            ok_jobs += 1  # a partial response still updated the charts it returned
        print(f"{label} {job['name']}: " + ", ".join(f"{c['id']}={len(c['rows'])}" for c in fetched.values()))

    # One chart per id: a chart fetched twice this run wins over a stale fallback copy.
    unique: dict[str, dict] = {}
    for chart in charts:
        kept = unique.get(chart["id"])
        if kept is None or not chart.get("stale"):
            unique[chart["id"]] = chart
    charts = list(unique.values())

    data = {
        "source": src["id"],
        "name": src["name"],
        "region": src["region"],
        "kind": src.get("kind", "ktv"),
        "site_url": src["site_url"],
        "checked_at": now_iso(),
        "errors": errors,
        "charts": charts,
    }
    # Never publish an empty ranking list: it would look like the source has no charts and
    # would replace a file that may still hold good data for undeclared charts.
    if charts:
        SITE_DATA.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    else:
        (data["errors"]).append(f"{label}: nothing could be published this run")
        print(f"::error title={label}::{label}: every chart failed and none had a previous copy", file=sys.stderr)
    return data, ok_jobs, len(module.JOBS)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m scraper")
    parser.add_argument("sources", nargs="*", help="source ids to run (default: all)")
    args = parser.parse_args(argv)
    modules = [m for m in ALL if not args.sources or m.SOURCE["id"] in args.sources]
    if not modules:
        parser.error(f"unknown source; choose from {[m.SOURCE['id'] for m in ALL]}")

    history = History(HISTORY)
    total_ok = total_jobs = 0
    for module in modules:
        _, ok, jobs = run_source(module, history)
        total_ok += ok
        total_jobs += jobs

    index = {
        "updated_at": now_iso(),
        "sources": [
            {**{k: m.SOURCE[k] for k in ("id", "name", "region", "site_url")}, "kind": m.SOURCE.get("kind", "ktv")}
            for m in ALL
        ],
    }
    SITE_DATA.mkdir(parents=True, exist_ok=True)
    (SITE_DATA / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    try:
        counts = enrich.apply_files(SITE_DATA)  # genres and links from caches; no network
        print("annotated rows: " + ", ".join(f"{k}={v}" for k, v in counts.items()))
    except Exception as exc:  # noqa: BLE001 - tags are optional; rankings must still publish
        print(f"::warning title=Genre tags skipped::{exc}", file=sys.stderr)
    print(f"done: {total_ok}/{total_jobs} jobs succeeded")
    return 0 if total_ok else 1


if __name__ == "__main__":
    sys.exit(main())
