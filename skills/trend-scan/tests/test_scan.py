"""Automated tests for the trend-scan pipeline.

Run from the repository root:

    python -I -m unittest discover -s skills/trend-scan/tests -v

Covers: normal multi-platform scans, no-tool platforms (Instagram/X/Bluesky),
failure codes and partial coverage, missing cursors, page-limit stops, cursor
pass-through, cross-platform themes, repeat accounts and the CLI entry point.
All data comes from local fakes; nothing here touches the network or the
production ScrapeAtlas adapter path.
"""

from __future__ import annotations

import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

# Make the skill package importable when run with -I from anywhere.
SKILL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR))
TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS_DIR))

from adapters import (  # noqa: E402
    AdapterTransportError,
    ScrapeAtlasCLIAdapter,
    normalize_envelope,
)
from fakes import (  # noqa: E402
    FIXTURE_DIR,
    FixtureFileAdapter,
    ScriptedFakeAdapter,
    make_body,
    make_post,
)
from models import HASHTAG, KEYWORD, PageRequest  # noqa: E402
from platforms import NO_TOOL_PLATFORMS, resolve  # noqa: E402
from report import SAMPLE_DISCLAIMER, render_markdown  # noqa: E402
import scan  # noqa: E402
from scan_engine import (  # noqa: E402
    OUTCOME_COMPLETE,
    OUTCOME_FAILED,
    OUTCOME_INCOMPLETE,
    OUTCOME_NO_TOOL,
    STOP_CURSOR_MISSING,
    STOP_FAILED,
    STOP_INCOMPLETE,
    STOP_NO_TOOL,
    STOP_PAGE_LIMIT,
    run_scan,
)


def _body_page_one(cursor=None, cursor_field="cursor"):
    return make_body(
        [
            make_post(
                "https://example.com/p1", "@alpha", "2026-11-14T10:00:00Z",
                "Espresso machine review for home baristas #espresso",
                {"views": 9000, "likes": 500, "comment_count": 40},
            ),
            make_post(
                "https://example.com/p2", "@beta", "2026-11-13T08:30:00Z",
                "Grinder comparison and espresso dial-in tips",
                {"views": 4000, "likes": 220},
            ),
            make_post(
                "https://example.com/p3", "@alpha", "2026-11-12T20:15:00Z",
                "Morning espresso routine with latte art",
                {"views": 1500},
            ),
        ],
        cursor=cursor,
        cursor_field=cursor_field,
    )


class NormalMultiPlatformTests(unittest.TestCase):
    def setUp(self):
        self.adapter = ScriptedFakeAdapter(
            {
                ("tiktok", 1): _body_page_one(cursor=None),
                ("youtube", 1): make_body(
                    [
                        make_post(
                            "https://youtu.be/yt1", "@tubebrew",
                            "2026-11-15T00:00:00Z",
                            "Home espresso setup tour #espresso",
                            {"view_count": 30000, "like_count": 1200},
                        )
                    ]
                ),
                ("reddit", 1): make_body(
                    [
                        make_post(
                            "https://reddit.com/r/x", "u/reduser",
                            "2026-11-11T00:00:00Z",
                            "Espresso grinder recommendations thread",
                            {"upvotes": 80},
                        )
                    ]
                ),
            }
        )

    def test_scan_collects_every_platform_and_counts_calls(self):
        result = run_scan(
            "espresso", ["tiktok", "youtube", "reddit"],
            self.adapter, max_pages=1,
        )
        self.assertEqual(result.total_calls, 3)
        self.assertEqual([o.platform for o in result.platforms],
                         ["tiktok", "youtube", "reddit"])
        self.assertTrue(all(o.status == OUTCOME_COMPLETE for o in result.platforms))
        tiktok = result.outcome("tiktok")
        self.assertEqual(tiktok.pages_covered, 1)
        self.assertEqual(len(tiktok.posts), 3)
        # One adapter call per requested page, no extra calls.
        self.assertEqual(len(self.adapter.requests), 3)
        self.assertTrue(all(req.page == 1 for req in self.adapter.requests))

    def test_report_has_required_sections_and_sample_disclaimer(self):
        result = run_scan(
            "espresso", ["tiktok", "youtube"], self.adapter, max_pages=1,
        )
        markdown = render_markdown(result)
        self.assertIn("# Trend scan: espresso", markdown)
        self.assertIn("## tiktok", markdown)
        self.assertIn("## youtube", markdown)
        self.assertIn("## Cross-platform themes", markdown)
        self.assertIn("## Repeat accounts", markdown)
        self.assertIn(SAMPLE_DISCLAIMER, markdown)
        # Per-post requirements: URL, author, engagement.
        self.assertIn("https://example.com/p1", markdown)
        self.assertIn("@alpha", markdown)
        self.assertIn("engagement:", markdown)
        # Date range reflects the actual posts on the page.
        self.assertIn("2026-11-12", markdown)
        self.assertIn("2026-11-14", markdown)
        # The coverage declaration is the final non-empty line.
        last_line = [line for line in markdown.strip().splitlines() if line][-1]
        self.assertIn("Coverage declaration", last_line)
        self.assertIn("total calls: 2", last_line)

    def test_top_posts_capped_at_five_and_ranked_by_metric(self):
        posts = [
            make_post(f"https://example.com/{i}", f"@u{i}",
                      "2026-11-10T00:00:00Z", f"post {i}",
                      {"views": i * 1000})
            for i in range(1, 7)
        ]
        adapter = ScriptedFakeAdapter({("tiktok", 1): make_body(posts)})
        result = run_scan("espresso", ["tiktok"], adapter, max_pages=1)
        markdown = render_markdown(result)
        # Five numbered entries max.
        self.assertEqual(markdown.count("\n1. "), 1)
        self.assertIn("5. ", markdown)
        self.assertNotIn("6. [", markdown)
        # Highest metric first.
        top = result.outcome("tiktok").posts
        from scan_engine import rank_posts
        self.assertEqual(rank_posts(top)[0].url, "https://example.com/6")

    def test_cross_platform_theme_and_repeat_account(self):
        result = run_scan(
            "espresso", ["tiktok", "youtube"], self.adapter, max_pages=1,
        )
        markdown = render_markdown(result)
        # "#espresso" appears on both platforms' posts.
        self.assertIn("`#espresso`", markdown)
        # @alpha authors two tiktok posts.
        self.assertIn("@alpha - 2 post(s)", markdown)


class NoToolPlatformTests(unittest.TestCase):
    def test_instagram_x_bluesky_are_known_no_tool_platforms(self):
        self.assertEqual(NO_TOOL_PLATFORMS, frozenset({"instagram", "x", "bluesky"}))
        for platform in ("instagram", "x", "bluesky"):
            for kind in (KEYWORD, HASHTAG):
                _, operation, reason = resolve(platform, kind)
                self.assertIsNone(operation)
                self.assertIn("no", reason)

    def test_no_tool_skip_is_explicit_and_makes_zero_calls(self):
        adapter = ScriptedFakeAdapter({("tiktok", 1): _body_page_one()})
        result = run_scan(
            "espresso",
            ["tiktok", "instagram", "x", "bluesky"],
            adapter, max_pages=1,
        )
        self.assertEqual(result.total_calls, 1)  # tiktok only
        by_name = {o.platform: o for o in result.platforms}
        for name in ("instagram", "x", "bluesky"):
            outcome = by_name[name]
            self.assertEqual(outcome.status, OUTCOME_NO_TOOL)
            self.assertEqual(outcome.stop_reason, STOP_NO_TOOL)
            self.assertEqual(outcome.calls, [])
            self.assertTrue(outcome.skip_reason)
        self.assertEqual(len(adapter.requests), 1)

        markdown = render_markdown(result)
        self.assertIn("no tool skipped", markdown)
        last_line = markdown.strip().splitlines()[-1]
        self.assertIn("no-tool skipped: instagram, x, bluesky", last_line)
        self.assertIn("tiktok=complete", last_line)

    def test_unknown_platform_is_reported_not_crashed(self):
        adapter = ScriptedFakeAdapter({})
        result = run_scan("espresso", ["myspace"], adapter, max_pages=1)
        self.assertEqual(result.platforms[0].status, OUTCOME_NO_TOOL)
        self.assertIn("unknown platform", result.platforms[0].skip_reason)
        self.assertEqual(result.total_calls, 0)


class FailureAndPartialTests(unittest.TestCase):
    def test_rate_limited_failure_keeps_no_data_and_records_code(self):
        adapter = ScriptedFakeAdapter({
            ("tiktok", 1): make_body([], failure_code="upstream_rate_limited"),
        })
        result = run_scan("espresso", ["tiktok"], adapter, max_pages=3)
        outcome = result.outcome("tiktok")
        self.assertEqual(outcome.status, OUTCOME_FAILED)
        self.assertEqual(outcome.stop_reason, STOP_FAILED)
        self.assertEqual(outcome.pages_covered, 1)
        self.assertEqual(outcome.failure_codes, ["upstream_rate_limited"])
        self.assertIn("upstream_rate_limited", render_markdown(result))
        # No further pages after a failure.
        self.assertEqual(len(adapter.requests), 1)

    def test_not_found_failure_code_is_declared_in_coverage_line(self):
        adapter = ScriptedFakeAdapter({
            ("reddit", 1): make_body([], failure_code="not_found"),
        })
        result = run_scan("espresso", ["reddit"], adapter)
        last_line = render_markdown(result).strip().splitlines()[-1]
        self.assertIn("failure codes: reddit:not_found", last_line)

    def test_partial_status_keeps_posts_but_marks_incomplete(self):
        adapter = ScriptedFakeAdapter({
            ("tiktok", 1): make_body(
                [
                    make_post("https://example.com/keep", "@survivor",
                              "2026-11-14T10:00:00Z",
                              "partial but usable espresso post",
                              {"likes": 12}),
                ],
                status="partial",
                complete=False,
                warnings=["upstream timed out before all results loaded"],
                cursor="should-not-be-followed",
            ),
        })
        result = run_scan("espresso", ["tiktok"], adapter, max_pages=3)
        outcome = result.outcome("tiktok")
        self.assertEqual(outcome.status, OUTCOME_INCOMPLETE)
        self.assertEqual(outcome.stop_reason, STOP_INCOMPLETE)
        self.assertEqual(len(outcome.posts), 1)  # data retained
        self.assertEqual(outcome.posts[0].url, "https://example.com/keep")
        self.assertEqual(len(adapter.requests), 1)  # no paging on partial
        markdown = render_markdown(result)
        self.assertIn("incomplete (partial coverage)", markdown)
        self.assertIn("upstream timed out", markdown)

    def test_coverage_complete_false_alone_is_treated_as_partial(self):
        adapter = ScriptedFakeAdapter({
            ("tiktok", 1): make_body(
                [make_post("https://example.com/x", "@a",
                           "2026-11-14T10:00:00Z", "espresso")],
                status="ok", complete=False,
            ),
        })
        result = run_scan("espresso", ["tiktok"], adapter)
        self.assertEqual(result.outcome("tiktok").status, OUTCOME_INCOMPLETE)

    def test_failure_on_second_page_keeps_first_page_results(self):
        adapter = ScriptedFakeAdapter({
            ("tiktok", 1): make_body(
                [make_post("https://example.com/p1", "@a",
                           "2026-11-14T10:00:00Z", "espresso page one",
                           {"views": 100})],
                cursor="page-2-cursor",
            ),
            ("tiktok", 2): make_body([], failure_code="upstream_error"),
        })
        result = run_scan("espresso", ["tiktok"], adapter, max_pages=3)
        outcome = result.outcome("tiktok")
        self.assertEqual(outcome.status, OUTCOME_FAILED)
        self.assertEqual(outcome.pages_covered, 2)
        self.assertEqual(len(outcome.posts), 1)  # first page preserved
        self.assertEqual(outcome.failure_codes, ["upstream_error"])
        self.assertIn("stopped at page 2", outcome.stop_detail)

    def test_adapter_error_does_not_kill_the_whole_scan(self):
        adapter = ScriptedFakeAdapter({
            ("tiktok", 1): make_body([], status="failed"),
            ("youtube", 1): make_body(
                [make_post("https://youtu.be/ok", "@y",
                           "2026-11-14T10:00:00Z", "espresso")]
            ),
        })
        # Rewrite tiktok to a transport-style adapter error.
        from models import PageResult
        adapter._responses[("tiktok", 1)] = PageResult(
            platform="tiktok", page=1, status="adapter_error",
            complete=False, warnings=["CLI transport error: exit 127"],
        )
        result = run_scan("espresso", ["tiktok", "youtube"], adapter)
        self.assertEqual(result.outcome("tiktok").status, OUTCOME_FAILED)
        self.assertEqual(result.outcome("youtube").status, OUTCOME_COMPLETE)
        self.assertEqual(result.total_calls, 2)


class PaginationTests(unittest.TestCase):
    def test_missing_cursor_stops_after_page_one(self):
        adapter = ScriptedFakeAdapter({
            ("tiktok", 1): _body_page_one(cursor=None),
            ("tiktok", 2): _body_page_one(),  # must never be requested
        })
        result = run_scan("espresso", ["tiktok"], adapter, max_pages=5)
        outcome = result.outcome("tiktok")
        self.assertEqual(outcome.pages_covered, 1)
        self.assertEqual(outcome.stop_reason, STOP_CURSOR_MISSING)
        self.assertIn("no next cursor", outcome.stop_detail)
        self.assertEqual(len(adapter.requests), 1)

    def test_page_limit_stops_even_when_cursor_remains(self):
        adapter = ScriptedFakeAdapter({
            ("tiktok", 1): _body_page_one(cursor="c1"),
            ("tiktok", 2): make_body(
                [make_post("https://example.com/p4", "@d",
                           "2026-11-11T10:00:00Z", "espresso page two")],
                cursor="c2",
            ),
            ("tiktok", 3): _body_page_one(cursor="c3"),  # not requested
        })
        result = run_scan("espresso", ["tiktok"], adapter, max_pages=2)
        outcome = result.outcome("tiktok")
        self.assertEqual(outcome.pages_covered, 2)
        self.assertEqual(outcome.stop_reason, STOP_PAGE_LIMIT)
        self.assertIn("page 2", outcome.stop_detail)
        self.assertEqual(len(adapter.requests), 2)

    def test_cursor_is_passed_back_unchanged_with_its_field_name(self):
        token = {"opaque": ["nested", 3]}
        adapter = ScriptedFakeAdapter({
            ("tiktok", 1): _body_page_one(
                cursor=token, cursor_field="continuationToken"
            ),
            ("tiktok", 2): make_body([]),
        })
        run_scan("espresso", ["tiktok"], adapter, max_pages=2)
        second = adapter.requests[1]
        self.assertEqual(second.page, 2)
        self.assertEqual(second.cursor, token)  # exactly the returned object
        self.assertEqual(second.cursor_field, "continuationToken")

    def test_search_id_cursor_bundle_is_echoed_both_fields(self):
        adapter = ScriptedFakeAdapter({
            ("tiktok", 1): make_body(
                [make_post("https://example.com/p1", "@a",
                           "2026-11-14T10:00:00Z", "espresso")],
                cursor="cur-9", search_id="sid-1",
            ),
            ("tiktok", 2): make_body([]),
        })
        run_scan("espresso", ["tiktok"], adapter, max_pages=2)
        second = adapter.requests[1]
        self.assertEqual(
            second.cursor, {"search_id": "sid-1", "cursor": "cur-9"}
        )
        self.assertEqual(second.cursor_field, "search_id+cursor")

    def test_first_page_request_has_no_cursor(self):
        adapter = ScriptedFakeAdapter({("tiktok", 1): _body_page_one()})
        run_scan("espresso", ["tiktok"], adapter)
        self.assertIsNone(adapter.requests[0].cursor)
        self.assertIsNone(adapter.requests[0].cursor_field)


class HashtagAndCapabilityTests(unittest.TestCase):
    def test_hashtag_uses_hashtag_operation_and_bare_tag(self):
        adapter = ScriptedFakeAdapter({
            ("facebook", 1): make_body(
                [make_post("https://fb.com/p", "@fb",
                           "2026-11-14T10:00:00Z", "#espresso post")]
            ),
        })
        result = run_scan(
            "#espresso", ["facebook"], adapter,
            query_kind=HASHTAG, max_pages=1,
        )
        self.assertEqual(result.outcome("facebook").operation, "facebookHashtag")
        self.assertEqual(adapter.requests[0].query, "espresso")
        self.assertEqual(adapter.requests[0].query_kind, HASHTAG)

    def test_reddit_has_no_hashtag_tool(self):
        adapter = ScriptedFakeAdapter({})
        result = run_scan(
            "#espresso", ["reddit"], adapter, query_kind=HASHTAG,
        )
        self.assertEqual(result.outcome("reddit").status, OUTCOME_NO_TOOL)

    def test_linkedin_costs_two_credits_and_passes_through(self):
        adapter = ScriptedFakeAdapter({
            ("linkedin", 1): make_body(
                [make_post("https://linkedin.com/p", "@li",
                           "2026-11-14T10:00:00Z", "espresso b2b post")],
                credits_charged=2,
            ),
        })
        result = run_scan("espresso", ["linkedin"], adapter)
        self.assertEqual(result.total_credits, 2)
        self.assertEqual(result.outcome("linkedin").operation,
                         "linkedinSearchPosts")


class FixtureFileAdapterTests(unittest.TestCase):
    def test_loads_json_fixtures_through_shared_normalizer(self):
        adapter = FixtureFileAdapter()
        result = run_scan(
            "espresso", ["tiktok", "reddit"], adapter, max_pages=1,
        )
        tiktok = result.outcome("tiktok")
        self.assertEqual(tiktok.status, OUTCOME_COMPLETE)
        self.assertEqual(len(tiktok.posts), 3)
        # max_cursor is recognized as the cursor field.
        self.assertEqual(tiktok.calls[0].result.cursor_field, "max_cursor")
        self.assertEqual(tiktok.calls[0].result.next_cursor, "tk-cursor-abc")
        # Nested metric aliases normalize to the shared vocabulary.
        self.assertEqual(tiktok.posts[0].metrics["views"], 120000)
        self.assertEqual(tiktok.posts[0].metrics["likes"], 8400)
        self.assertEqual(result.outcome("reddit").posts[0].metrics["upvotes"], 240)

    def test_missing_fixture_file_is_adapter_error_not_exception(self):
        adapter = FixtureFileAdapter()
        result = run_scan("espresso", ["youtube"], adapter)
        self.assertEqual(result.outcome("youtube").status, OUTCOME_FAILED)
        self.assertIn("fixture not found",
                      result.outcome("youtube").calls[0].result.warnings[0])


class ProductionAdapterContractTests(unittest.TestCase):
    """The real ScrapeAtlas CLI adapter must honor the same interface."""

    def test_implements_same_interface_and_builds_inputs(self):
        adapter = ScrapeAtlasCLIAdapter(
            {"tiktok": "tiktokSearchKeyword"},
            runner=lambda command, timeout: ("{}", ""),
        )
        self.assertEqual(adapter.source, "scrapeatlas-cli")
        request = PageRequest(
            platform="tiktok", query="espresso", since="2026-11-09T00:00:00Z",
            until="2026-11-16T00:00:00Z",
            cursor="keep-me", cursor_field="max_cursor",
        )
        inputs = adapter._build_inputs(request)
        self.assertEqual(inputs["keyword"], "espresso")
        self.assertEqual(inputs["since"], "2026-11-09T00:00:00Z")
        self.assertEqual(inputs["max_cursor"], "keep-me")  # unchanged

    def test_cli_failure_returns_adapter_error_result(self):
        def failing_runner(command, timeout):
            raise AdapterTransportError("exit 127")

        adapter = ScrapeAtlasCLIAdapter(
            {"tiktok": "tiktokSearchKeyword"}, runner=failing_runner,
        )
        result = adapter.fetch_page(
            PageRequest(platform="tiktok", query="espresso")
        )
        self.assertEqual(result.status, "adapter_error")
        self.assertIn("CLI transport error", result.warnings[0])

    def test_non_json_output_is_adapter_error(self):
        adapter = ScrapeAtlasCLIAdapter(
            {"tiktok": "tiktokSearchKeyword"},
            runner=lambda command, timeout: ("not json at all", ""),
        )
        result = adapter.fetch_page(
            PageRequest(platform="tiktok", query="espresso")
        )
        self.assertEqual(result.status, "adapter_error")

    def test_cli_normalizes_like_the_fake(self):
        raw_body = {
            "status": "partial",
            "coverage": {"complete": False, "warnings": ["slow upstream"]},
            "results": [
                {"link": "https://example.com/x", "username": "@z",
                 "play_count": "2,500", "digg_count": 99},
            ],
            "after": "opaque-token",
        }
        captured = {}

        def runner(command, timeout):
            captured["command"] = command
            return json.dumps(raw_body), ""

        adapter = ScrapeAtlasCLIAdapter(
            {"tiktok": "tiktokSearchKeyword"}, runner=runner,
        )
        result = adapter.fetch_page(
            PageRequest(platform="tiktok", query="espresso")
        )
        self.assertEqual(result.status, "partial")
        self.assertFalse(result.complete)
        self.assertEqual(result.next_cursor, "opaque-token")
        self.assertEqual(result.cursor_field, "after")
        self.assertEqual(result.posts[0].metrics["views"], 2500)
        self.assertEqual(result.posts[0].metrics["likes"], 99)
        # The CLI is called by operation id with a JSON --input argument.
        self.assertEqual(captured["command"][:3],
                         ["scrapeatlas", "call", "tiktokSearchKeyword"])


class CliEntryPointTests(unittest.TestCase):
    def test_list_platforms_prints_table(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = scan.main(["--list-platforms"])
        self.assertEqual(code, 0)
        self.assertIn("tiktokSearchKeyword", buf.getvalue())
        self.assertIn("instagram", buf.getvalue())

    def test_query_validation(self):
        with self.assertRaises(SystemExit):
            scan.main(["--platforms", "tiktok"])
        with self.assertRaises(SystemExit):
            scan.main(["--query", "x"])
        with self.assertRaises(SystemExit):
            scan.main(["--query", "x", "--platforms", "tiktok", "--max-pages", "0"])

    def test_hashtag_detection_and_prefix_stripping(self):
        self.assertEqual(scan.determine_query_kind("espresso", False), KEYWORD)
        self.assertEqual(scan.determine_query_kind("#espresso", False), HASHTAG)
        self.assertEqual(scan.determine_query_kind("espresso", True), HASHTAG)
        self.assertEqual(scan.strip_hashtag_prefix("#espresso"), "espresso")

    def test_end_to_end_with_fixture_adapter_via_engine(self):
        # The CLI itself only wires the production adapter; end-to-end report
        # rendering with fake data runs through the same engine entry point.
        adapter = FixtureFileAdapter()
        result = run_scan(
            "espresso", ["tiktok", "instagram", "reddit"],
            adapter, query_kind=KEYWORD, max_pages=1, window_days=7,
        )
        markdown = render_markdown(result)
        last_line = markdown.strip().splitlines()[-1]
        self.assertIn("total calls: 2", last_line)
        self.assertIn("no-tool skipped: instagram", last_line)
        self.assertIn("failure codes: none", last_line)
        self.assertIn("pages covered: tiktok:1p, reddit:1p", last_line)
        self.assertIn(SAMPLE_DISCLAIMER, markdown)


if __name__ == "__main__":
    unittest.main(verbosity=2)
