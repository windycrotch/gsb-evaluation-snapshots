#!/usr/bin/env python3
"""
Concurrency / dedup tests for sourceDownloader.

Spins up a local HTTP server (stdlib only, no external network) serving a
small site where two pages both link to the same subpage, then verifies:

  * with --threads 4 every URL is requested exactly once;
  * urls.txt is written after crawling, is deduplicated + sorted, covers
    every processed URL, and its count matches the number of processed
    lines printed during the run;
  * --threads 1 produces identical results;
  * --depth range (min-max) and --no-download semantics are preserved.

Run from the repo root with either:
    python -m unittest discover -s tests -v
    python tests/test_concurrent_crawl.py
"""

import contextlib
import io
import os
import shutil
import sys
import tempfile
import threading
import unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import sourceDownloader  # noqa: E402

SITE_PAGES = {
    "index.html": (
        "<html><body>"
        '<a href="/a.html">A</a>'
        '<a href="/b.html">B</a>'
        "</body></html>"
    ),
    "a.html": (
        "<html><body>"
        '<a href="/b.html">B</a>'
        '<a href="/shared.html">shared</a>'
        "</body></html>"
    ),
    "b.html": (
        "<html><body>"
        '<a href="/a.html">A</a>'
        '<a href="/shared.html">shared</a>'
        "</body></html>"
    ),
    # Linked from both a.html and b.html; links back to / to form a cycle.
    "shared.html": (
        "<html><body>"
        '<a href="/">home</a>'
        "</body></html>"
    ),
}

# Paths the crawler is expected to request, and the URLs expected in urls.txt.
EXPECTED_PATHS = {"/", "/a.html", "/b.html", "/shared.html"}


class CountingHandler(SimpleHTTPRequestHandler):
    """Counts GET requests per path, thread-safely."""

    counts = {}
    counts_lock = threading.Lock()

    def do_GET(self):
        with CountingHandler.counts_lock:
            CountingHandler.counts[self.path] = CountingHandler.counts.get(self.path, 0) + 1
        super().do_GET()

    def log_message(self, *args):
        pass


class CrawlConcurrencyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.site_dir = tempfile.mkdtemp(prefix="crawl_site_")
        for name, html in SITE_PAGES.items():
            with open(os.path.join(cls.site_dir, name), "w", encoding="utf-8") as f:
                f.write(html)

        handler = partial(CountingHandler, directory=cls.site_dir)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.port = cls.server.server_address[1]
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()

        cls.base_url = f"http://127.0.0.1:{cls.port}/"
        cls.expected_urls = {
            cls.base_url,
            f"{cls.base_url}a.html",
            f"{cls.base_url}b.html",
            f"{cls.base_url}shared.html",
        }
        # Must mirror the project_dir sanitization in crawl_website.
        cls.project_dir = f"127_0_0_1_{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.site_dir, ignore_errors=True)

    def setUp(self):
        with CountingHandler.counts_lock:
            CountingHandler.counts = {}

    def run_crawl(self, threads, min_depth=0, max_depth=2, no_download=False):
        """Run crawl_website in a fresh temp CWD; return (urls, processed_count, workdir)."""
        workdir = tempfile.mkdtemp(prefix="crawl_out_")
        self.addCleanup(shutil.rmtree, workdir, True)
        old_cwd = os.getcwd()
        os.chdir(workdir)
        try:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                sourceDownloader.crawl_website(
                    self.base_url,
                    min_depth,
                    max_depth,
                    export_urls=True,
                    no_download=no_download,
                    threads=threads,
                )
        finally:
            os.chdir(old_cwd)

        output = buf.getvalue()
        urls_file = os.path.join(workdir, self.project_dir, "urls.txt")
        self.assertTrue(os.path.isfile(urls_file), "urls.txt was not exported")
        with open(urls_file, "r", encoding="utf-8") as f:
            urls = [line.strip() for line in f if line.strip()]

        processed_count = sum(
            1
            for line in output.splitlines()
            if ("Analyzed" in line or "Crawled only" in line or "Saved asset" in line)
        )
        return urls, processed_count, workdir

    def get_counts(self):
        with CountingHandler.counts_lock:
            return dict(CountingHandler.counts)

    def test_concurrent_dedup_and_export(self):
        urls, processed_count, _ = self.run_crawl(threads=4)

        # urls.txt: no duplicates, sorted, covers exactly the processed URLs.
        self.assertEqual(len(urls), len(set(urls)), "urls.txt contains duplicates")
        self.assertEqual(urls, sorted(urls), "urls.txt is not sorted")
        self.assertEqual(set(urls), self.expected_urls)

        # Exported count matches the number of processed lines printed.
        self.assertEqual(len(urls), processed_count)

        # The shared subpage (linked from two pages) and every other page
        # must have been requested exactly once despite 4 threads.
        counts = self.get_counts()
        self.assertEqual(set(counts), EXPECTED_PATHS)
        for path, count in counts.items():
            self.assertEqual(count, 1, f"{path} requested {count} times")

    def test_single_thread_matches_concurrent(self):
        concurrent_urls, concurrent_processed, _ = self.run_crawl(threads=4)
        concurrent_counts = self.get_counts()

        self.setUp()  # reset request counters
        single_urls, single_processed, _ = self.run_crawl(threads=1)
        single_counts = self.get_counts()

        self.assertEqual(concurrent_urls, single_urls)
        self.assertEqual(concurrent_processed, single_processed)
        self.assertEqual(concurrent_counts, single_counts)
        for path, count in single_counts.items():
            self.assertEqual(count, 1, f"{path} requested {count} times in single-thread mode")

    def test_depth_range_and_no_download(self):
        # Depth range 1-1: depth-0 page is crawled (for links) but not
        # downloaded; depth-2 page is never visited; nothing is saved.
        urls, processed_count, workdir = self.run_crawl(
            threads=4, min_depth=1, max_depth=1, no_download=True
        )

        expected = {self.base_url, f"{self.base_url}a.html", f"{self.base_url}b.html"}
        self.assertEqual(set(urls), expected)
        self.assertEqual(len(urls), processed_count)

        counts = self.get_counts()
        self.assertEqual(set(counts), {"/", "/a.html", "/b.html"})
        for path, count in counts.items():
            self.assertEqual(count, 1, f"{path} requested {count} times")

        # --no-download: no page/asset files written, only urls.txt.
        project_path = os.path.join(workdir, self.project_dir)
        self.assertEqual(os.listdir(project_path), ["urls.txt"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
