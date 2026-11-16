"""Platform search capability table, mirroring the trend-scan SKILL.md rules.

A platform with neither a keyword nor a hashtag entry for the requested kind
must be recorded as an explicit "no tool" skip by the engine — never silently
dropped and never replaced by another platform.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PlatformCapability:
    platform: str
    keyword_operation: str | None
    hashtag_operation: str | None
    time_filter: str
    credits: int = 1
    note: str = ""

    def operation_for(self, query_kind: str) -> str | None:
        if query_kind == "hashtag":
            return self.hashtag_operation
        return self.keyword_operation


# Order matches the tools table in SKILL.md.
CAPABILITIES: dict[str, PlatformCapability] = {
    cap.platform: cap
    for cap in (
        PlatformCapability(
            "tiktok",
            "tiktokSearchKeyword",
            "tiktokSearchHashtag",
            "publish_time / since / until",
        ),
        PlatformCapability(
            "youtube",
            "youtubeSearch",
            "youtubeSearchHashtag",
            "uploadDate / since / until",
        ),
        PlatformCapability(
            "reddit",
            "redditGlobalSearch",
            None,
            "timeframe / since / until",
        ),
        PlatformCapability(
            "threads",
            "threadsSearch",
            "threadsSearchTags",
            "recent / since / until",
        ),
        PlatformCapability(
            "linkedin",
            "linkedinSearchPosts",
            None,
            "date_posted / since / until",
            credits=2,
            note="2 credits per call",
        ),
        PlatformCapability(
            "pinterest",
            "pinterestSearch",
            None,
            "since / until",
        ),
        PlatformCapability(
            "facebook",
            None,
            "facebookHashtag",
            "none",
        ),
        PlatformCapability(
            "tumblr",
            "tumblrSearch",
            "tumblrTag",
            "sort=recent",
        ),
        PlatformCapability(
            "mastodon",
            None,
            "mastodonHashtag",
            "since / until",
            note="mastodonSearch finds accounts/tags, not posts",
        ),
        # Topic-research tools outside the social-video set, documented in SKILL.md.
        PlatformCapability("hackernews", "hackernewsSearch", None, "since / until"),
        PlatformCapability("medium", "mediumSearch", None, "since / until"),
        PlatformCapability("substack", "substackSearch", None, "since / until"),
        PlatformCapability(
            "quora", "quoraSearch", None, "since / until", credits=2,
            note="2 credits per call",
        ),
        PlatformCapability("producthunt", "producthuntSearch", None, "since / until"),
        # Explicitly no keyword or hashtag search in ScrapeAtlas.
        PlatformCapability(
            "instagram", None, None, "n/a",
            note="no keyword or hashtag search tool in ScrapeAtlas",
        ),
        PlatformCapability(
            "x", None, None, "n/a",
            note="no keyword or hashtag search tool in ScrapeAtlas",
        ),
        PlatformCapability(
            "bluesky", None, None, "n/a",
            note="no keyword or hashtag search tool in ScrapeAtlas",
        ),
    )
}

# Platforms the skill explicitly names as having no search capability. Keeping
# them as real table rows means the engine reports them instead of erroring.
NO_TOOL_PLATFORMS = frozenset(
    name for name, cap in CAPABILITIES.items()
    if cap.keyword_operation is None and cap.hashtag_operation is None
)


def normalize_platform(name: str) -> str:
    return name.strip().lower().replace(" ", "")


def resolve(platform: str, query_kind: str) -> tuple[PlatformCapability | None, str | None, str]:
    """Return ``(capability, operation_id, skip_reason)``.

    ``operation_id`` and ``skip_reason`` are mutually exclusive: a platform
    that genuinely has no matching tool gets a human-readable reason so the
    caller can record an explicit skip. An unknown platform is treated the
    same way rather than crashing the whole scan.
    """
    key = normalize_platform(platform)
    cap = CAPABILITIES.get(key)
    if cap is None:
        return None, None, (
            f"unknown platform '{platform}': not in the trend-scan capability table"
        )
    operation = cap.operation_for(query_kind)
    if operation is None:
        kind_label = "hashtag" if query_kind == "hashtag" else "keyword"
        # The note for no-tool platforms already states the same fact; only
        # append it when it adds information (credits, related tools, etc.).
        note_adds_info = bool(cap.note) and "no " not in cap.note
        detail = f": {cap.note}" if note_adds_info else ""
        reason = f"no {kind_label} search tool in ScrapeAtlas{detail}"
        return cap, None, reason
    return cap, operation, ""


def describe_table() -> str:
    lines = [
        "platform     keyword               hashtag                  time filter",
        "-" * 78,
    ]
    for name, cap in CAPABILITIES.items():
        lines.append(
            f"{name:<12} "
            f"{(cap.keyword_operation or '-'):<21} "
            f"{(cap.hashtag_operation or '-'):<24} "
            f"{cap.time_filter}"
        )
    return "\n".join(lines)
