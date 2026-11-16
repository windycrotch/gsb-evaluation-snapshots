"""Data-fetch adapters for trend-scan.

The scan engine depends only on the :class:`SearchAdapter` abstract interface,
so the real ScrapeAtlas backend and the test-only fake backend (kept under
``tests/``) are interchangeable. Nothing in this module imports test fixtures,
and fake data can therefore never flow through the production path.
"""

from __future__ import annotations

import json
import subprocess
from abc import ABC, abstractmethod
from typing import Any, Optional

from models import PageRequest, PageResult, Post

# Continuation field names used across ScrapeAtlas endpoints (see the
# scrapeatlas skill's pagination section). A response may use any one of them.
CURSOR_FIELDS = (
    "cursor",
    "max_cursor",
    "next_max_id",
    "continuationToken",
    "after",
    "pagination_token",
    "page",
)

# Engagement metric aliases seen on different platforms, normalized to a
# common vocabulary.
_METRIC_ALIASES = {
    "play_count": "views",
    "plays": "views",
    "view_count": "views",
    "views": "views",
    "like_count": "likes",
    "likes": "likes",
    "digg_count": "likes",
    "comment_count": "comments",
    "comments": "comments",
    "share_count": "shares",
    "shares": "shares",
    "repost_count": "reposts",
    "reposts": "reposts",
    "favorite_count": "favorites",
    "favorites": "favorites",
    "save_count": "saves",
    "saves": "saves",
    "upvotes": "upvotes",
    "score": "score",
}

_URL_KEYS = ("url", "web_url", "link", "permalink", "post_url", "video_url")
_AUTHOR_KEYS = (
    "author", "author_name", "username", "handle", "user_name",
    "screen_name", "account", "channel", "subreddit",
)
_DATE_KEYS = (
    "published_at", "publish_time", "created_at", "create_time", "timestamp",
    "upload_date", "date_posted", "posted_at", "datetime", "date",
)
_TEXT_KEYS = ("text", "title", "caption", "description", "content", "body")
_LIST_KEYS = (
    "posts", "results", "items", "videos", "data", "entries", "tweets",
    "threads", "notes", "comments", "records",
)

_FAILED_STATUSES = {"failed", "challenged", "error"}


class SearchAdapter(ABC):
    """Pluggable backend: one method, one page of normalized results."""

    #: where the data comes from; rendered into the report header
    source: str = "abstract"

    @abstractmethod
    def fetch_page(self, request: PageRequest) -> PageResult:
        """Fetch exactly one page. Must never raise for upstream failures:

        return a :class:`PageResult` with ``status="failed"`` (or
        ``"adapter_error"``) so the engine can keep the rest of the scan
        running and report the failure code honestly.
        """
        raise NotImplementedError


# --------------------------------------------------------------------------- #
# Helpers shared with the test fake so both backends normalize identically.
# --------------------------------------------------------------------------- #

def _first_present(mapping: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if key in mapping and mapping[key] not in (None, ""):
            return mapping[key]
    return None


def _coerce_int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.replace(",", "").strip())
        except ValueError:
            return None
    return None


def _normalize_metrics(item: dict[str, Any]) -> dict[str, int]:
    metrics: dict[str, int] = {}
    for key, value in item.items():
        normalized = _METRIC_ALIASES.get(key)
        if normalized is None:
            continue
        number = _coerce_int(value)
        if number is not None:
            # Keep the largest value if several aliases collide.
            metrics[normalized] = max(metrics.get(normalized, number), number)
    # Nested engagement/statistics blobs are common too.
    for container_key in ("metrics", "engagement", "stats", "statistics"):
        container = item.get(container_key)
        if isinstance(container, dict):
            for key, value in container.items():
                normalized = _METRIC_ALIASES.get(key, key)
                number = _coerce_int(value)
                if number is not None:
                    metrics[normalized] = max(metrics.get(normalized, number), number)
    return metrics


def _normalize_author(item: dict[str, Any]) -> Optional[str]:
    value = _first_present(item, _AUTHOR_KEYS)
    if isinstance(value, dict):
        nested = _first_present(
            value, ("handle", "username", "name", "display_name", "nickname")
        )
        value = nested
    return str(value) if value not in (None, "") else None


def _normalize_post(item: dict[str, Any]) -> Post:
    url = _first_present(item, _URL_KEYS)
    return Post(
        url=str(url) if url is not None else None,
        author=_normalize_author(item),
        published_at=(
            str(_first_present(item, _DATE_KEYS))
            if _first_present(item, _DATE_KEYS) is not None
            else None
        ),
        text=(
            str(_first_present(item, _TEXT_KEYS))
            if _first_present(item, _TEXT_KEYS) is not None
            else None
        ),
        metrics=_normalize_metrics(item),
        raw=item,
    )


def _extract_posts(body: dict[str, Any]) -> list[dict[str, Any]]:
    for key in _LIST_KEYS:
        value = body.get(key)
        if isinstance(value, list) and (not value or isinstance(value[0], dict)):
            return value
    # Fall back to the first dict-valued list anywhere in the top level.
    for value in body.values():
        if isinstance(value, list) and value and isinstance(value[0], dict):
            return value
    return []


def _extract_cursor(body: dict[str, Any]) -> tuple[Any, Optional[str]]:
    """Find the continuation value and the field that carried it.

    Some endpoints pair ``search_id`` with ``cursor``; the pair is bundled so
    the engine can echo both back unchanged.
    """
    if isinstance(body.get("pagination"), dict):
        pagination = body["pagination"]
        for field_name in CURSOR_FIELDS:
            if pagination.get(field_name) not in (None, ""):
                return pagination[field_name], field_name
    search_id = body.get("search_id")
    cursor = body.get("cursor")
    if cursor not in (None, ""):
        if search_id not in (None, ""):
            return {"search_id": search_id, "cursor": cursor}, "search_id+cursor"
        return cursor, "cursor"
    for field_name in CURSOR_FIELDS:
        if body.get(field_name) not in (None, ""):
            return body[field_name], field_name
    return None, None


def _extract_failure(body: dict[str, Any]) -> tuple[Optional[str], list[str]]:
    failure = body.get("failure")
    code = None
    if isinstance(failure, dict):
        code = failure.get("code")
    elif isinstance(failure, str):
        code = failure
    code = body.get("failure_code") if code is None else code
    warnings: list[str] = []
    coverage = body.get("coverage")
    if isinstance(coverage, dict):
        raw_warnings = coverage.get("warnings")
        if isinstance(raw_warnings, list):
            warnings = [str(w) for w in raw_warnings]
    return (str(code) if code is not None else None), warnings


def normalize_envelope(
    body: dict[str, Any], platform: str, page: int, credits: int = 0
) -> PageResult:
    """Convert a raw ScrapeAtlas ``body`` into a normalized :class:`PageResult`.

    Shared by the production CLI adapter and the test fake so both interpret
    ``status``, ``coverage`` and failure codes identically.
    """
    if not isinstance(body, dict):
        return PageResult(
            platform=platform, page=page, status="adapter_error", complete=False,
            warnings=["response body was not a JSON object"], credits_charged=credits,
            raw=body,
        )

    failure_code, warnings = _extract_failure(body)
    raw_status = str(body.get("status", "ok")).lower()
    coverage = body.get("coverage")
    coverage_complete = (
        coverage.get("complete") if isinstance(coverage, dict) else None
    )
    success = body.get("success", True)

    is_failed = (
        success is False
        or raw_status in _FAILED_STATUSES
        or failure_code is not None
    )
    is_partial = raw_status == "partial" or coverage_complete is False

    posts = [_normalize_post(item) for item in _extract_posts(body)]
    next_cursor, cursor_field = _extract_cursor(body)

    if is_failed:
        status = "failed"
        complete = False
    elif is_partial:
        status = "partial"
        complete = False
    else:
        status = "ok"
        complete = True

    return PageResult(
        platform=platform,
        page=page,
        posts=posts,
        status=status,
        complete=complete,
        failure_code=failure_code,
        warnings=warnings,
        next_cursor=next_cursor,
        cursor_field=cursor_field,
        credits_charged=_coerce_int(body.get("creditsCharged")) or credits,
        raw=body,
    )


# --------------------------------------------------------------------------- #
# Production backend: the real ScrapeAtlas CLI.
# --------------------------------------------------------------------------- #

# Query/input field name per operation, following the parameters documented in
# the trend-scan and scrapeatlas skills. Run `scrapeatlas <platform> <action>
# --help` to confirm against the installed CLI version.
_INPUT_BUILDERS = {
    "tiktokSearchKeyword": lambda q, r: {"keyword": q, **_time_inputs(r)},
    "tiktokSearchHashtag": lambda q, r: {"hashtag": q, **_time_inputs(r)},
    "tiktokSearchTop": lambda q, r: {"keyword": q, **_time_inputs(r)},
    "youtubeSearch": lambda q, r: {"query": q, **_time_inputs(r)},
    "youtubeSearchHashtag": lambda q, r: {"hashtag": q, **_time_inputs(r)},
    "redditGlobalSearch": lambda q, r: {"query": q, **_time_inputs(r)},
    "redditSubredditSearch": lambda q, r: {"query": q, **_time_inputs(r)},
    "threadsSearch": lambda q, r: {"query": q, **_time_inputs(r)},
    "threadsSearchTags": lambda q, r: {"tag": q, **_time_inputs(r)},
    "linkedinSearchPosts": lambda q, r: {"keywords": q, **_time_inputs(r)},
    "pinterestSearch": lambda q, r: {"query": q, **_time_inputs(r)},
    "facebookHashtag": lambda q, r: {"hashtag": q},
    "tumblrSearch": lambda q, r: {"query": q, "sort": "recent"},
    "tumblrTag": lambda q, r: {"tag": q, "sort": "recent"},
    "mastodonHashtag": lambda q, r: {"hashtag": q, **_time_inputs(r)},
    "hackernewsSearch": lambda q, r: {"query": q, **_time_inputs(r)},
    "mediumSearch": lambda q, r: {"query": q, **_time_inputs(r)},
    "substackSearch": lambda q, r: {"query": q, **_time_inputs(r)},
    "quoraSearch": lambda q, r: {"query": q, **_time_inputs(r)},
    "producthuntSearch": lambda q, r: {"query": q, **_time_inputs(r)},
}


def _time_inputs(request: PageRequest) -> dict[str, Any]:
    inputs: dict[str, Any] = {}
    if request.since:
        inputs["since"] = request.since
    if request.until:
        inputs["until"] = request.until
    return inputs


class ScrapeAtlasCLIAdapter(SearchAdapter):
    """Production adapter. Calls the real ``scrapeatlas`` CLI as a subprocess.

    The CLI is installed and authenticated out-of-band (see the
    ``scrapeatlas-setup`` skill). This adapter never handles API keys: the CLI
    owns its own credentials, so no key appears in arguments, URLs or output.
    """

    source = "scrapeatlas-cli"

    def __init__(
        self,
        operation_by_platform: dict[str, str],
        cli_binary: str = "scrapeatlas",
        timeout_seconds: int = 120,
        runner=None,
    ) -> None:
        self._operations = dict(operation_by_platform)
        self._cli = cli_binary
        self._timeout = timeout_seconds
        # Injectable runner for unit testing the production adapter itself.
        self._runner = runner or self._default_runner

    def _build_inputs(self, request: PageRequest) -> dict[str, Any]:
        operation = self._operations[request.platform]
        builder = _INPUT_BUILDERS.get(operation)
        if builder is None:
            inputs: dict[str, Any] = {"query": request.query, **_time_inputs(request)}
        else:
            inputs = builder(request.query, request)
        # Echo the previous cursor back unchanged under its original field.
        if request.cursor is not None:
            if request.cursor_field == "search_id+cursor" and isinstance(
                request.cursor, dict
            ):
                inputs.update(request.cursor)
            elif request.cursor_field:
                inputs[request.cursor_field] = request.cursor
            else:
                inputs["cursor"] = request.cursor
        return inputs

    def fetch_page(self, request: PageRequest) -> PageResult:
        operation = self._operations.get(request.platform)
        if operation is None:
            return PageResult(
                platform=request.platform, page=request.page,
                status="adapter_error", complete=False,
                warnings=[f"no ScrapeAtlas operation mapped for {request.platform}"],
            )
        payload = json.dumps(self._build_inputs(request), ensure_ascii=False)
        try:
            stdout, stderr = self._runner(
                [self._cli, "call", operation, "--input", payload],
                self._timeout,
            )
        except AdapterTransportError as exc:
            return PageResult(
                platform=request.platform, page=request.page,
                status="adapter_error", complete=False,
                warnings=[f"CLI transport error: {exc}"],
            )
        try:
            body = json.loads(stdout)
        except (json.JSONDecodeError, TypeError) as exc:
            return PageResult(
                platform=request.platform, page=request.page,
                status="adapter_error", complete=False,
                warnings=[
                    f"CLI returned non-JSON output: {exc}",
                    f"stderr: {stderr.strip()[:300]}",
                ],
            )
        return normalize_envelope(body, request.platform, request.page)

    @staticmethod
    def _default_runner(command: list[str], timeout: int) -> tuple[str, str]:
        try:
            completed = subprocess.run(
                command, capture_output=True, text=True, timeout=timeout,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise AdapterTransportError(str(exc)) from exc
        if completed.returncode != 0:
            raise AdapterTransportError(
                f"exit {completed.returncode}: {completed.stderr.strip()[:300]}"
            )
        return completed.stdout, completed.stderr


class AdapterTransportError(Exception):
    """Raised internally when the CLI subprocess cannot be run or fails."""
