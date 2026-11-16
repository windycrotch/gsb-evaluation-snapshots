"""Resumable multi-page scraping without a real browser or network."""

import json
from unittest.mock import patch

import pytest

from anti_scraping_playwright.scraper import (
    AntiBlockingScraper,
    ProgressFileError,
    ScraperConfig,
)


class FakePage:
    def __init__(self):
        self.navigated = []

    def goto(self, url, wait_until="load"):
        self.navigated.append((url, wait_until))

    def add_init_script(self, script):
        pass


class FakeContext:
    def __init__(self):
        self.page = FakePage()
        self.closed = False

    def new_page(self):
        return self.page

    def close(self):
        self.closed = True


class FakeBrowser:
    def __init__(self):
        self.contexts = []
        self.closed = False

    def new_context(self, **options):
        context = FakeContext()
        self.contexts.append(context)
        return context

    def close(self):
        self.closed = True


class FakePlaywright:
    def __init__(self):
        self.browser = FakeBrowser()

    @property
    def chromium(self):
        return self

    def launch(self, **options):
        return self.browser


class FakeSyncPlaywright:
    """Context manager standing in for playwright.sync_api.sync_playwright."""

    def __init__(self):
        self.api = FakePlaywright()
        self.started = 0
        self.stopped = 0

    def __call__(self):
        return self

    def __enter__(self):
        self.started += 1
        return self.api

    def __exit__(self, exc_type, exc, tb):
        self.stopped += 1
        return False


def make_scraper(**overrides):
    config = ScraperConfig(
        headless=True,
        enable_human_behavior=False,
        max_retries=2,
        retry_backoff=1.0,
        circuit_breaker_cooldown=0.0,
        circuit_breaker_threshold=100,
        **overrides,
    )
    return AntiBlockingScraper(config)


def test_first_run_writes_progress_and_summary(tmp_path):
    progress = tmp_path / "progress.json"
    fake = FakeSyncPlaywright()

    def callback(page, url):
        return {"url": url, "title": f"title-{url.rsplit('/', 1)[-1]}"}

    with patch(
        "anti_scraping_playwright.scraper.sync_playwright", fake
    ):
        summary = make_scraper().scrape_with_resume(
            ["https://example.test/a", "https://example.test/b"],
            progress,
            callback,
        )

    assert summary == {
        "succeeded": 2,
        "failed": 0,
        "skipped": 0,
        "failed_urls": [],
    }
    assert fake.api.browser.closed is True
    assert fake.stopped == 1

    state = json.loads(progress.read_text(encoding="utf-8"))
    assert state["completed_urls"] == [
        "https://example.test/a",
        "https://example.test/b",
    ]
    assert [entry["url"] for entry in state["results"]] == state["completed_urls"]
    assert state["results"][0]["result"]["title"] == "title-a"

    # Atomic writes must not leave temp files behind.
    assert list(tmp_path.glob(".progress-*.tmp")) == []


def test_resume_skips_completed_urls(tmp_path):
    progress = tmp_path / "progress.json"
    progress.write_text(
        json.dumps(
            {
                "completed_urls": ["https://example.test/a"],
                "results": [
                    {"url": "https://example.test/a", "result": {"title": "old"}}
                ],
            }
        ),
        encoding="utf-8",
    )
    fake = FakeSyncPlaywright()
    seen = []

    def callback(page, url):
        seen.append(url)
        return {"url": url}

    with patch("anti_scraping_playwright.scraper.sync_playwright", fake):
        summary = make_scraper().scrape_with_resume(
            ["https://example.test/a", "https://example.test/b"],
            progress,
            callback,
        )

    assert summary["succeeded"] == 1
    assert summary["skipped"] == 1
    assert summary["failed"] == 0
    assert seen == ["https://example.test/b"]

    state = json.loads(progress.read_text(encoding="utf-8"))
    assert state["completed_urls"] == [
        "https://example.test/a",
        "https://example.test/b",
    ]


def test_failed_urls_can_be_retried_in_a_follow_up_run(tmp_path):
    progress = tmp_path / "progress.json"
    fake = FakeSyncPlaywright()
    failing = {"https://example.test/bad"}

    def flaky_callback(page, url):
        if url in failing:
            raise RuntimeError("blocked by target site")
        return {"url": url, "ok": True}

    with patch("anti_scraping_playwright.scraper.sync_playwright", fake):
        first = make_scraper().scrape_with_resume(
            ["https://example.test/ok", "https://example.test/bad"],
            progress,
            flaky_callback,
        )

    assert first["succeeded"] == 1
    assert first["failed"] == 1
    assert first["failed_urls"] == ["https://example.test/bad"]

    # Failed pages must not have been recorded as completed.
    state = json.loads(progress.read_text(encoding="utf-8"))
    assert state["completed_urls"] == ["https://example.test/ok"]

    # The returned failed_urls feed directly into a retry run that now succeeds.
    failing.clear()
    with patch("anti_scraping_playwright.scraper.sync_playwright", fake):
        retry = make_scraper().scrape_with_resume(
            first["failed_urls"], progress, flaky_callback
        )

    assert retry == {
        "succeeded": 1,
        "failed": 0,
        "skipped": 0,
        "failed_urls": [],
    }
    state = json.loads(progress.read_text(encoding="utf-8"))
    assert state["completed_urls"] == [
        "https://example.test/ok",
        "https://example.test/bad",
    ]


def test_interrupted_run_resumes_without_losing_finished_pages(tmp_path):
    progress = tmp_path / "progress.json"
    fake = FakeSyncPlaywright()
    urls = [
        "https://example.test/1",
        "https://example.test/2",
        "https://example.test/3",
    ]

    def interrupting_callback(page, url):
        result = {"url": url}
        if url == "https://example.test/2":
            # Simulate the process dying mid-batch after page 1 was persisted.
            raise KeyboardInterrupt()
        return result

    with (
        patch("anti_scraping_playwright.scraper.sync_playwright", fake),
        pytest.raises(KeyboardInterrupt),
    ):
        make_scraper().scrape_with_resume(urls, progress, interrupting_callback)

    # The previously finished page survived the interruption and is parseable.
    state = json.loads(progress.read_text(encoding="utf-8"))
    assert state["completed_urls"] == ["https://example.test/1"]

    completed = []

    def callback(page, url):
        completed.append(url)
        return {"url": url}

    with patch("anti_scraping_playwright.scraper.sync_playwright", fake):
        summary = make_scraper().scrape_with_resume(urls, progress, callback)

    assert summary["succeeded"] == 2
    assert summary["skipped"] == 1
    assert summary["failed"] == 0
    assert completed == ["https://example.test/2", "https://example.test/3"]
    state = json.loads(progress.read_text(encoding="utf-8"))
    assert state["completed_urls"] == urls


@pytest.mark.parametrize(
    "payload",
    [
        "{not valid json",
        json.dumps({"completed_urls": [], "results": {}}),
        json.dumps({"completed_urls": [1, 2], "results": []}),
        json.dumps({"completed_urls": [], "results": [{"url": 5}]}),
        json.dumps([1, 2, 3]),
    ],
)
def test_corrupt_progress_file_raises_instead_of_clearing(tmp_path, payload):
    progress = tmp_path / "progress.json"
    progress.write_text(payload, encoding="utf-8")

    with pytest.raises(ProgressFileError):
        make_scraper().scrape_with_resume(
            ["https://example.test/a"], progress, lambda page, url: None
        )

    # The damaged file is left untouched rather than silently reset.
    assert progress.read_text(encoding="utf-8") == payload


def test_all_urls_completed_never_launches_browser(tmp_path):
    progress = tmp_path / "progress.json"
    progress.write_text(
        json.dumps(
            {
                "completed_urls": ["https://example.test/a"],
                "results": [{"url": "https://example.test/a", "result": {}}],
            }
        ),
        encoding="utf-8",
    )
    fake = FakeSyncPlaywright()

    with patch("anti_scraping_playwright.scraper.sync_playwright", fake):
        summary = make_scraper().scrape_with_resume(
            ["https://example.test/a"], progress, lambda page, url: {}
        )

    assert summary == {
        "succeeded": 0,
        "failed": 0,
        "skipped": 1,
        "failed_urls": [],
    }
    assert fake.started == 0
