"""Test-only fakes for trend-scan.

This module deliberately lives under ``tests/`` and is never imported by the
production engine or CLI. It serves canned local responses through the exact
same :class:`adapters.SearchAdapter` interface as the production ScrapeAtlas
adapter, so tests exercise the real orchestration, normalization and
pagination code against fake data — without any network access.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from adapters import SearchAdapter, normalize_envelope
from models import PageRequest, PageResult

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"


class ScriptedFakeAdapter(SearchAdapter):
    """Return scripted responses keyed by ``(platform, page)``.

    Each response is either a raw ScrapeAtlas-style ``body`` dict (normalized
    through the shared :func:`normalize_envelope`, exactly like production) or
    an already-built :class:`PageResult`. Every request is recorded so tests
    can assert call counts and cursor pass-through.
    """

    source = "local-fake-fixtures"

    def __init__(
        self,
        responses: dict[tuple[str, int], Any],
        default_credits: int = 1,
    ) -> None:
        self._responses = responses
        self._default_credits = default_credits
        self.requests: list[PageRequest] = []

    def fetch_page(self, request: PageRequest) -> PageResult:
        self.requests.append(request)
        response = self._responses.get((request.platform, request.page))
        if response is None:
            # A missing script entry means the engine paginated further than
            # the test planned: fail loudly instead of inventing a page.
            raise KeyError(
                f"fake adapter has no scripted response for "
                f"({request.platform!r}, page {request.page})"
            )
        if isinstance(response, PageResult):
            return response
        return normalize_envelope(
            response,
            platform=request.platform,
            page=request.page,
            credits=self._default_credits,
        )


class FixtureFileAdapter(SearchAdapter):
    """Load raw bodies from per-platform JSON fixture files.

    Fixture layout (all test data, never used in production)::

        fixtures/<platform>/page1.json
        fixtures/<platform>/page2.json
    """

    source = "local-fake-fixture-files"

    def __init__(self, fixture_dir: Path = FIXTURE_DIR) -> None:
        self._dir = Path(fixture_dir)
        self.requests: list[PageRequest] = []

    def fetch_page(self, request: PageRequest) -> PageResult:
        self.requests.append(request)
        path = self._dir / request.platform / f"page{request.page}.json"
        if not path.exists():
            return PageResult(
                platform=request.platform,
                page=request.page,
                status="adapter_error",
                complete=False,
                warnings=[f"fixture not found: {path.name}"],
            )
        body = json.loads(path.read_text(encoding="utf-8"))
        return normalize_envelope(body, request.platform, request.page)


# --------------------------------------------------------------------------- #
# Body builders: compact constructors for the ScrapeAtlas-style raw envelopes.
# --------------------------------------------------------------------------- #

def make_post(
    url: str,
    author: str,
    published_at: str,
    text: str,
    metrics: Optional[dict[str, int]] = None,
) -> dict[str, Any]:
    return {
        "url": url,
        "author": author,
        "published_at": published_at,
        "text": text,
        **(metrics or {}),
    }


def make_body(
    posts: list[dict[str, Any]],
    *,
    status: str = "ok",
    complete: bool = True,
    cursor: Any = None,
    cursor_field: str = "cursor",
    failure_code: Optional[str] = None,
    warnings: Optional[list[str]] = None,
    credits_charged: int = 1,
    search_id: Optional[str] = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "status": status,
        "coverage": {"complete": complete, "warnings": warnings or []},
        "posts": posts,
        "creditsCharged": credits_charged,
    }
    if failure_code is not None:
        body["success"] = False
        body["failure"] = {"code": failure_code}
    if cursor is not None:
        body[cursor_field] = cursor
    if search_id is not None:
        body["search_id"] = search_id
    return body
