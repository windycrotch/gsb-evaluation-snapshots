"""Markdown report rendering and cross-platform analysis.

The final line of every report is a single coverage declaration: calls made,
per-platform status, pages covered, no-tool skips and failure codes. Every
report also states that search results are a platform-ranked sample, not a
measure of total volume.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass

from models import Post
from scan_engine import (
    METRIC_PRIORITY,
    OUTCOME_COMPLETE,
    OUTCOME_FAILED,
    OUTCOME_INCOMPLETE,
    OUTCOME_NO_TOOL,
    PlatformOutcome,
    ScanResult,
    date_range,
    rank_posts,
)

SAMPLE_DISCLAIMER = (
    "Search results are a ranked sample chosen by each platform; they do not "
    "represent total volume or the size of the trend."
)

_TOP_POSTS_MIN = 3
_TOP_POSTS_MAX = 5
_THEME_MIN_POSTS = 2
_REPEAT_MIN_APPEARANCES = 2

_STOP_WORDS = frozenset(
    """
    a an and are as at be but by for from has have had he her hers him his how i
    if in into is it its just me my no not now of on or our out own so she such
    than that the their theirs them then there these they this to too up us was
    we were what when where which while who why will with you your yours via vs
    about after all any because been before being between both can did do does
    done each few get got more most other over some only same should would could
    shall may might must here there very also new one two using use used this
    """.split()
)

_HASHTAG_RE = re.compile(r"#[\w][\w\-]{1,}")
_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9\-]{2,}")
_HANDLE_RE = re.compile(r"^@?[A-Za-z0-9._\-]{2,}$")


@dataclass
class Theme:
    term: str
    count: int
    is_hashtag: bool
    platforms: list[str]
    examples: list[tuple[str, str]]  # (platform, post URL or snippet)


@dataclass
class RepeatAccount:
    account: str
    appearances: int
    platforms: list[str]
    urls: list[str]


def _post_terms(post: Post) -> list[str]:
    if not post.text:
        return []
    terms: list[str] = []
    lowered = post.text.lower()
    terms.extend(m.group(0).lower() for m in _HASHTAG_RE.finditer(post.text))
    for token in _TOKEN_RE.findall(lowered):
        if token not in _STOP_WORDS:
            terms.append(token)
    return terms


def cross_platform_themes(result: ScanResult) -> list[Theme]:
    """Recurring terms/hashtags across the collected posts.

    A term qualifies when it appears in at least two posts. Terms that appear
    on more than one platform are surfaced first; ties break on post count.
    """
    term_posts: dict[str, list[tuple[str, Post]]] = defaultdict(list)
    for outcome in result.platforms:
        for post in outcome.posts:
            for term in set(_post_terms(post)):
                term_posts[term].append((outcome.platform, post))

    themes: list[Theme] = []
    for term, occurrences in term_posts.items():
        if len(occurrences) < _THEME_MIN_POSTS:
            continue
        platforms = sorted({platform for platform, _ in occurrences})
        examples: list[tuple[str, str]] = []
        for platform, post in occurrences[:3]:
            examples.append((platform, post.url or (post.text or "")[:80]))
        themes.append(
            Theme(
                term=term,
                count=len(occurrences),
                is_hashtag=term.startswith("#"),
                platforms=platforms,
                examples=examples,
            )
        )
    themes.sort(
        key=lambda t: (len(t.platforms) > 1, len(t.platforms), t.count),
        reverse=True,
    )
    return themes


def _normalize_handle(author: str) -> str:
    handle = author.strip().lstrip("@")
    return handle.lower()


def repeat_accounts(result: ScanResult) -> list[RepeatAccount]:
    """Accounts appearing in at least two collected posts, anywhere."""
    seen: dict[str, RepeatAccount] = {}
    for outcome in result.platforms:
        for post in outcome.posts:
            if not post.author or not _HANDLE_RE.match(post.author.strip()):
                continue
            key = _normalize_handle(post.author)
            entry = seen.get(key)
            if entry is None:
                entry = RepeatAccount(
                    account=post.author.lstrip("@"),
                    appearances=0,
                    platforms=[],
                    urls=[],
                )
                seen[key] = entry
            entry.appearances += 1
            if outcome.platform not in entry.platforms:
                entry.platforms.append(outcome.platform)
            if post.url and post.url not in entry.urls:
                entry.urls.append(post.url)
    repeats = [
        entry for entry in seen.values()
        if entry.appearances >= _REPEAT_MIN_APPEARANCES
    ]
    repeats.sort(key=lambda e: (e.appearances, len(e.platforms)), reverse=True)
    return repeats


def _format_metrics(post: Post) -> str:
    if not post.metrics:
        return "no engagement metrics provided"
    parts = [f"{name}={value}" for name, value in sorted(post.metrics.items())]
    return ", ".join(parts)


def _render_post_line(index: int, post: Post) -> list[str]:
    title = (post.text or "").strip().replace("\n", " ")
    if len(title) > 100:
        title = title[:97] + "..."
    lines = [
        f"{index}. " + (f"[{title}]({post.url})" if post.url else (title or "(untitled)")),
        f"   - author: {post.author or 'not provided'} | published: "
        f"{post.published_at or 'not provided'}",
        f"   - engagement: {_format_metrics(post)}",
    ]
    if not post.url:
        lines.append("   - url: not provided by source")
    return lines


def _render_platform(outcome: PlatformOutcome) -> list[str]:
    heading = f"## {outcome.platform}"
    if outcome.operation:
        heading += f" ({outcome.operation}, {outcome.query_kind})"
    lines = [heading]

    if outcome.status == OUTCOME_NO_TOOL:
        lines.append("")
        lines.append(f"- status: no tool skipped - {outcome.skip_reason}")
        lines.append("- calls made: 0; pages covered: 0")
        lines.append("")
        return lines

    status_label = {
        OUTCOME_COMPLETE: "complete",
        OUTCOME_INCOMPLETE: "incomplete (partial coverage)",
        OUTCOME_FAILED: "failed",
    }.get(outcome.status, outcome.status)
    lines.append("")
    lines.append(f"- status: {status_label}")
    lines.append(f"- calls made: {len(outcome.calls)}; pages covered: {outcome.pages_covered}")
    lines.append(f"- result count: {len(outcome.posts)} posts")
    since, until = date_range(outcome.posts)
    lines.append(
        f"- actual date range in pages: {since or 'no dates provided'} "
        f"to {until or 'no dates provided'}"
    )
    if outcome.credits:
        lines.append(f"- credits charged: {outcome.credits}")
    if outcome.stop_detail:
        lines.append(f"- pagination: {outcome.stop_detail}")
    for warning in outcome.warnings:
        lines.append(f"- coverage warning: {warning}")
    for code in outcome.failure_codes:
        lines.append(f"- failure code: {code}")

    lines.append("")
    if not outcome.posts:
        lines.append("_No posts returned._")
        lines.append("")
        return lines

    ranked = rank_posts(outcome.posts)
    top = ranked[:_TOP_POSTS_MAX]
    # Keep between 3 and 5 where the page has enough posts; fewer is reported
    # honestly rather than padded.
    lines.append(
        f"### Top posts on {outcome.platform} "
        f"(ranked by best available metric in {', '.join(METRIC_PRIORITY)})"
    )
    lines.append("")
    for index, post in enumerate(top, start=1):
        lines.extend(_render_post_line(index, post))
    if len(ranked) < _TOP_POSTS_MIN:
        lines.append(
            f"\n_Note: only {len(ranked)} post(s) available; the 3-to-5 target "
            "could not be met from this sample._"
        )
    lines.append("")
    return lines


def _render_themes(result: ScanResult) -> list[str]:
    lines = ["## Cross-platform themes", ""]
    themes = cross_platform_themes(result)
    if not themes:
        lines.append("_No recurring terms found in the collected sample._")
        lines.append("")
        return lines
    for theme in themes:
        kind = "hashtag" if theme.is_hashtag else "term"
        scope = ", ".join(theme.platforms)
        lines.append(
            f"- `{theme.term}` ({kind}) - {theme.count} post(s) on: {scope}"
        )
        for platform, reference in theme.examples:
            lines.append(f"  - {platform}: {reference}")
    lines.append("")
    return lines


def _render_repeats(result: ScanResult) -> list[str]:
    lines = ["## Repeat accounts", ""]
    repeats = repeat_accounts(result)
    if not repeats:
        lines.append("_No account appeared in more than one collected post._")
        lines.append("")
        return lines
    for entry in repeats:
        cross = "cross-platform" if len(entry.platforms) > 1 else "single-platform"
        lines.append(
            f"- @{entry.account} - {entry.appearances} post(s) "
            f"({cross}; {', '.join(entry.platforms)})"
        )
        for url in entry.urls[:5]:
            lines.append(f"  - {url}")
    lines.append("")
    return lines


def _coverage_line(result: ScanResult) -> str:
    status_bits = []
    skipped = []
    failures = []
    page_bits = []
    for outcome in result.platforms:
        if outcome.status == OUTCOME_NO_TOOL:
            skipped.append(outcome.platform)
            status_bits.append(f"{outcome.platform}=no_tool")
            continue
        status_bits.append(f"{outcome.platform}={outcome.status}")
        page_bits.append(f"{outcome.platform}:{outcome.pages_covered}p")
        for code in outcome.failure_codes:
            failures.append(f"{outcome.platform}:{code}")

    parts = [
        f"Coverage declaration - total calls: {result.total_calls}",
        f"credits charged: {result.total_credits}",
        "platform status: " + ", ".join(status_bits),
        "pages covered: " + (", ".join(page_bits) if page_bits else "none"),
        "no-tool skipped: " + (", ".join(skipped) if skipped else "none"),
        "failure codes: " + (", ".join(failures) if failures else "none"),
        f"data source: {result.adapter_source}",
    ]
    return " | ".join(parts)


def render_markdown(result: ScanResult) -> str:
    kind_label = "hashtag" if result.query_kind == "hashtag" else "keyword"
    lines = [
        f"# Trend scan: {result.query}",
        "",
        f"- query kind: {kind_label}",
        f"- requested platforms: {', '.join(o.platform for o in result.platforms)}",
        f"- time window: {result.since or 'not specified'} to {result.until or 'not specified'}",
        f"- max pages per platform: {result.max_pages}",
        f"- data source adapter: {result.adapter_source}",
        "",
        f"> {SAMPLE_DISCLAIMER}",
        "",
    ]
    for outcome in result.platforms:
        lines.extend(_render_platform(outcome))
    lines.extend(_render_themes(result))
    lines.extend(_render_repeats(result))
    lines.append(_coverage_line(result))
    return "\n".join(lines) + "\n"
