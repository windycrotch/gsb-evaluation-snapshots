"""Normalized data models shared by every trend-scan adapter.

The adapter interface (see ``adapters.SearchAdapter``) speaks only these
types, so the production ScrapeAtlas adapter and the test-only fake adapter
are interchangeable and the scan engine never sees a raw platform payload.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

KEYWORD = "keyword"
HASHTAG = "hashtag"
QUERY_KINDS = (KEYWORD, HASHTAG)


@dataclass(frozen=True)
class PageRequest:
    """One page fetch for one platform.

    ``cursor`` is opaque. Per the scrapeatlas pagination rule it must be the
    exact value the previous page returned (any JSON type), or ``None`` for
    the first page. It must never be invented, edited or reused across
    different inputs.
    """

    platform: str
    query: str
    query_kind: str = KEYWORD
    since: Optional[str] = None
    until: Optional[str] = None
    max_pages_hint: int = 1
    page: int = 1
    cursor: Any = None
    cursor_field: Optional[str] = None


@dataclass
class Post:
    """A normalized search result. Nulls mean the source omitted the field."""

    url: Optional[str]
    author: Optional[str]
    published_at: Optional[str]
    text: Optional[str] = None
    metrics: dict[str, int] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)

    def metric_value(self, priority: tuple[str, ...]) -> Optional[int]:
        """Best available engagement metric, following ``priority`` order."""
        for name in priority:
            value = self.metrics.get(name)
            if isinstance(value, int):
                return value
        return None


@dataclass
class PageResult:
    """Normalized response to a :class:`PageRequest`.

    Statuses:
      - ``ok``: a complete page
      - ``partial``: usable but incomplete (``status == "partial"`` or
        ``coverage.complete is False``); ``posts`` are kept
      - ``failed``: a failure code was returned; ``posts`` may still hold
        whatever partial data the body carried
      - ``adapter_error``: the adapter itself could not get a response
        (CLI missing, unparseable body, transport error)
    """

    platform: str
    page: int
    posts: list[Post] = field(default_factory=list)
    status: str = "ok"
    complete: bool = True
    failure_code: Optional[str] = None
    warnings: list[str] = field(default_factory=list)
    next_cursor: Any = None
    cursor_field: Optional[str] = None
    credits_charged: int = 0
    raw: Any = None

    @property
    def has_next_cursor(self) -> bool:
        return self.next_cursor is not None and self.next_cursor != ""
