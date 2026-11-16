"""Scan orchestration: platform skips, failures, pagination and coverage.

The engine is backend-agnostic — it only talks to :class:`adapters.SearchAdapter`
— so it runs unchanged against the real ScrapeAtlas CLI and the test fake.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional

from adapters import SearchAdapter
from models import HASHTAG, KEYWORD, PageRequest, PageResult, Post
from platforms import resolve

# Metric ranking order: reach first, then engagement, then discussion.
METRIC_PRIORITY: tuple[str, ...] = (
    "views", "likes", "favorites", "reposts", "shares", "saves",
    "comments", "upvotes", "score",
)

#: pagination stopped because the last page carried no cursor
STOP_CURSOR_MISSING = "cursor_missing"
#: pagination stopped because the per-platform page cap was reached
STOP_PAGE_LIMIT = "page_limit_reached"
#: pagination stopped because a call failed
STOP_FAILED = "failed"
#: pagination stopped because a call returned partial/incomplete data
STOP_INCOMPLETE = "incomplete"
#: the platform was not called at all (no matching search tool)
STOP_NO_TOOL = "no_tool"

#: platform outcome statuses
OUTCOME_COMPLETE = "complete"
OUTCOME_INCOMPLETE = "incomplete"
OUTCOME_FAILED = "failed"
OUTCOME_NO_TOOL = "no_tool"


@dataclass
class PageCall:
    page: int
    result: PageResult


@dataclass
class PlatformOutcome:
    platform: str
    query_kind: str
    status: str
    operation: Optional[str] = None
    calls: list[PageCall] = field(default_factory=list)
    posts: list[Post] = field(default_factory=list)
    pages_covered: int = 0
    stop_reason: Optional[str] = None
    stop_detail: str = ""
    skip_reason: Optional[str] = None
    credits: int = 0

    @property
    def failure_codes(self) -> list[str]:
        return [
            call.result.failure_code
            for call in self.calls
            if call.result.failure_code
        ]

    @property
    def warnings(self) -> list[str]:
        collected: list[str] = []
        for call in self.calls:
            collected.extend(call.result.warnings)
        return collected


@dataclass
class ScanResult:
    query: str
    query_kind: str
    platforms: list[PlatformOutcome]
    since: Optional[str]
    until: Optional[str]
    max_pages: int
    adapter_source: str
    total_calls: int
    total_credits: int

    def outcome(self, platform: str) -> Optional[PlatformOutcome]:
        for outcome in self.platforms:
            if outcome.platform == platform:
                return outcome
        return None


def default_window(window_days: Optional[int]) -> tuple[Optional[str], Optional[str]]:
    """Return ISO ``since``/``until`` values for a trailing window."""
    if not window_days:
        return None, None
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=window_days)
    return (
        since.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    )


def rank_posts(posts: list[Post]) -> list[Post]:
    """Rank by the best available engagement metric; None metrics sort last."""
    def key(post: Post) -> tuple[int, int]:
        value = post.metric_value(METRIC_PRIORITY)
        return (1 if value is not None else 0, value if value is not None else -1)

    return sorted(posts, key=key, reverse=True)


def date_range(posts: list[Post]) -> tuple[Optional[str], Optional[str]]:
    """Actual date range covered by the returned posts (ISO strings compare)."""
    dates = sorted(
        post.published_at for post in posts if post.published_at
    )
    if not dates:
        return None, None
    return dates[0], dates[-1]


def scan_platform(
    platform: str,
    query: str,
    query_kind: str,
    adapter: SearchAdapter,
    max_pages: int,
    since: Optional[str],
    until: Optional[str],
) -> PlatformOutcome:
    """Run the full pagination loop for one platform."""
    cap, operation, skip_reason = resolve(platform, query_kind)
    platform_key = cap.platform if cap is not None else platform.strip().lower()

    if operation is None:
        # Explicit, visible skip — never a silent drop.
        return PlatformOutcome(
            platform=platform_key,
            query_kind=query_kind,
            status=OUTCOME_NO_TOOL,
            stop_reason=STOP_NO_TOOL,
            stop_detail=skip_reason,
            skip_reason=skip_reason,
        )

    outcome = PlatformOutcome(
        platform=platform_key,
        query_kind=query_kind,
        status=OUTCOME_COMPLETE,
        operation=operation,
    )
    cursor: object = None
    cursor_field: Optional[str] = None

    for page in range(1, max_pages + 1):
        request = PageRequest(
            platform=platform_key,
            query=query,
            query_kind=query_kind,
            since=since,
            until=until,
            max_pages_hint=max_pages,
            page=page,
            cursor=cursor,
            cursor_field=cursor_field,
        )
        result = adapter.fetch_page(request)
        outcome.calls.append(PageCall(page=page, result=result))
        outcome.pages_covered = page
        outcome.credits += result.credits_charged
        # Keep whatever data came back, even on failure/partial.
        outcome.posts.extend(result.posts)

        if result.status == "failed":
            outcome.status = OUTCOME_FAILED
            outcome.stop_reason = STOP_FAILED
            outcome.stop_detail = (
                f"stopped at page {page}: failure code "
                f"'{result.failure_code or 'unknown'}'"
            )
            return outcome

        if result.status == "adapter_error":
            outcome.status = OUTCOME_FAILED
            outcome.stop_reason = STOP_FAILED
            outcome.stop_detail = (
                f"stopped at page {page}: adapter error - "
                f"{'; '.join(result.warnings) or 'no detail'}"
            )
            return outcome

        if result.status == "partial":
            # Partial data is usable but must be flagged; do not keep paging
            # on a stream the upstream says is incomplete.
            outcome.status = OUTCOME_INCOMPLETE
            outcome.stop_reason = STOP_INCOMPLETE
            outcome.stop_detail = (
                f"stopped at page {page}: status=partial / coverage.complete=false"
                + (f" - {'; '.join(result.warnings)}" if result.warnings else "")
            )
            return outcome

        # Successful page: only follow a cursor that is actually present.
        if not result.has_next_cursor:
            outcome.stop_reason = STOP_CURSOR_MISSING
            outcome.stop_detail = (
                f"stopped at page {page}: no next cursor returned"
            )
            return outcome
        # Pass the cursor back unchanged; remember which field it belongs to.
        cursor = result.next_cursor
        cursor_field = result.cursor_field

        if page == max_pages:
            outcome.stop_reason = STOP_PAGE_LIMIT
            outcome.stop_detail = (
                f"stopped at page {page}: per-platform max-pages limit reached "
                f"(another page was available)"
            )

    return outcome


def normalize_query(query: str, query_kind: str) -> str:
    """Step 1 of the skill: send a bare tag to hashtag tools.

    Most ScrapeAtlas hashtag tools accept either form, but normalizing here
    keeps every entry point (CLI, library, tests) consistent.
    """
    stripped = query.strip()
    if query_kind == HASHTAG and stripped.startswith("#"):
        return stripped.lstrip("#").strip()
    return stripped


def run_scan(
    query: str,
    platforms: list[str],
    adapter: SearchAdapter,
    query_kind: str = KEYWORD,
    max_pages: int = 1,
    window_days: Optional[int] = None,
    since: Optional[str] = None,
    until: Optional[str] = None,
) -> ScanResult:
    if query_kind not in (KEYWORD, HASHTAG):
        raise ValueError(f"query_kind must be {KEYWORD!r} or {HASHTAG!r}")
    if max_pages < 1:
        raise ValueError("max_pages must be >= 1")
    query = normalize_query(query, query_kind)
    if since is None and until is None and window_days:
        since, until = default_window(window_days)

    outcomes = [
        scan_platform(
            platform=name,
            query=query,
            query_kind=query_kind,
            adapter=adapter,
            max_pages=max_pages,
            since=since,
            until=until,
        )
        for name in platforms
    ]
    total_calls = sum(len(o.calls) for o in outcomes)
    total_credits = sum(o.credits for o in outcomes)
    return ScanResult(
        query=query,
        query_kind=query_kind,
        platforms=outcomes,
        since=since,
        until=until,
        max_pages=max_pages,
        adapter_source=adapter.source,
        total_calls=total_calls,
        total_credits=total_credits,
    )
