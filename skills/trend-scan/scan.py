#!/usr/bin/env python3
"""Executable trend-scan CLI.

Turns the rules in skills/trend-scan/SKILL.md into a reproducible pipeline:
resolve per-platform capabilities (recording no-tool skips), fetch pages
through a swappable adapter, honor cursors and page limits exactly, and emit
a Markdown report with an end-of-file coverage declaration.

Standard library only. Production data comes from the real ScrapeAtlas CLI via
adapters.ScrapeAtlasCLIAdapter; test fakes live under tests/ and are never
imported here.

Examples:
    python scan.py --query "home espresso" \
        --platforms tiktok,youtube,reddit,threads --window-days 7
    python scan.py --query "#espresso" --hashtag \
        --platforms tiktok,facebook --max-pages 3 --out report.md
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Allow running both as `python scan.py` from this directory and as
# `python skills/trend-scan/scan.py` from the repository root.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from adapters import ScrapeAtlasCLIAdapter  # noqa: E402
from models import HASHTAG, KEYWORD  # noqa: E402
from platforms import CAPABILITIES, describe_table, normalize_platform, resolve  # noqa: E402
from report import SAMPLE_DISCLAIMER, render_markdown  # noqa: E402
from scan_engine import run_scan  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="scan.py",
        description=(
            "Scan a keyword or hashtag across platforms via swappable data "
            "adapters and emit a coverage-aware Markdown report."
        ),
    )
    parser.add_argument("--query", help="keyword, phrase or #hashtag to search")
    parser.add_argument(
        "--hashtag",
        action="store_true",
        help="force hashtag tools instead of keyword tools",
    )
    parser.add_argument(
        "--platforms",
        help="comma-separated platform list, e.g. tiktok,youtube,reddit",
    )
    parser.add_argument(
        "--window-days",
        type=int,
        default=None,
        help="trailing time window in days; converted to since/until in UTC",
    )
    parser.add_argument("--since", default=None, help="ISO timestamp override")
    parser.add_argument("--until", default=None, help="ISO timestamp override")
    parser.add_argument(
        "--max-pages",
        type=int,
        default=1,
        help="maximum pages fetched per platform (default: 1)",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="write the Markdown report to this path (default: stdout)",
    )
    parser.add_argument(
        "--cli-binary",
        default="scrapeatlas",
        help="ScrapeAtlas CLI executable name or path (default: scrapeatlas)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=120,
        help="per-call CLI timeout in seconds (default: 120)",
    )
    parser.add_argument(
        "--list-platforms",
        action="store_true",
        help="print the platform capability table and exit",
    )
    return parser


def determine_query_kind(query: str, force_hashtag: bool) -> str:
    if force_hashtag:
        return HASHTAG
    return HASHTAG if query.lstrip().startswith("#") else KEYWORD


def strip_hashtag_prefix(query: str) -> str:
    # Most ScrapeAtlas hashtag tools accept either form; send the bare tag.
    stripped = query.strip()
    return stripped.lstrip("#").strip() if stripped.startswith("#") else stripped


def build_production_adapter(platforms: list[str], query_kind: str, args: argparse.Namespace):
    operations: dict[str, str] = {}
    for name in platforms:
        _, operation, skip_reason = resolve(name, query_kind)
        key = normalize_platform(name)
        if operation is not None:
            operations[key] = operation
        elif key not in CAPABILITIES:
            print(
                f"warning: {skip_reason}; it will be reported as a no-tool skip",
                file=sys.stderr,
            )
    return ScrapeAtlasCLIAdapter(
        operation_by_platform=operations,
        cli_binary=args.cli_binary,
        timeout_seconds=args.timeout,
    )


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.list_platforms:
        print(describe_table())
        return 0

    if not args.query:
        parser.error("--query is required (unless --list-platforms is used)")
    if not args.platforms:
        parser.error("--platforms is required (unless --list-platforms is used)")
    if args.max_pages < 1:
        parser.error("--max-pages must be >= 1")
    if args.window_days is not None and args.window_days < 1:
        parser.error("--window-days must be >= 1")

    requested = [p for p in (part.strip() for part in args.platforms.split(",")) if p]
    if not requested:
        parser.error("--platforms must contain at least one platform")

    query_kind = determine_query_kind(args.query, args.hashtag)
    query = strip_hashtag_prefix(args.query) if query_kind == HASHTAG else args.query.strip()

    adapter = build_production_adapter(requested, query_kind, args)
    result = run_scan(
        query=query,
        platforms=requested,
        adapter=adapter,
        query_kind=query_kind,
        max_pages=args.max_pages,
        window_days=args.window_days,
        since=args.since,
        until=args.until,
    )
    markdown = render_markdown(result)

    if args.out:
        Path(args.out).write_text(markdown, encoding="utf-8")
        print(
            f"report written to {args.out}; {result.total_calls} call(s), "
            f"{result.total_credits} credit(s) charged",
            file=sys.stderr,
        )
    else:
        sys.stdout.write(markdown)

    # The sample disclaimer must always travel with the numbers.
    if SAMPLE_DISCLAIMER not in markdown:  # pragma: no cover - defensive
        print(SAMPLE_DISCLAIMER, file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
