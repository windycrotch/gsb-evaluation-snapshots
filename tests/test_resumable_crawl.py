#!/usr/bin/env python3
"""End-to-end tests for examples/resumable_crawl.py against an in-process mock
of the Scavio Extract API. No network, no key, no third-party packages.

Run:  python -I tests/test_resumable_crawl.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler
from socketserver import ThreadingTCPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "examples"))

import resumable_crawl as rc  # noqa: E402

# --------------------------------------------------------------------------- #
# Mock API: scripted crawl + batch jobs keyed by id
# --------------------------------------------------------------------------- #

CRAWL_JOB = {
    "id": "crawl_test-1",
    "type": "crawl",
    "status": "completed",
    "stopped_reason": "insufficient_credits",
    "error": None,
    "url": "https://example.test/docs",
    "format": "markdown",
    "mode": "normal",
    "pages": {"discovered": 6, "queued": 2, "succeeded": 3, "failed": 1, "skipped": 2},
    "credits_used": 3,
    "results": [
        {"url": "https://example.test/docs/intro", "depth": 1, "status": "succeeded",
         "status_code": 200, "truncated": False, "error": None, "skip_reason": None,
         "credits": 1, "content": "# Intro\n\nline1\nline2 with **markdown**\n"},
        {"url": "https://example.test/docs/guide", "depth": 1, "status": "succeeded",
         "status_code": 200, "truncated": False, "error": None, "skip_reason": None,
         "credits": 1, "content": "# Guide\n\ncontent unchanged\n"},
        # a second page of succeeded results exercises next_cursor paging
        {"url": "https://example.test/docs/extra", "depth": 1, "status": "succeeded",
         "status_code": 200, "truncated": False, "error": None, "skip_reason": None,
         "credits": 1, "content": "# Extra\n\nsecond cursor page\n"},
        # paid success with nothing in it: must become a failed item, no file
        {"url": "https://example.test/docs/empty", "depth": 2, "status": "succeeded",
         "status_code": 200, "truncated": False, "error": None, "skip_reason": None,
         "credits": 1, "content": "   \n  "},
        {"url": "https://example.test/docs/broken", "depth": 2, "status": "failed",
         "status_code": 500, "error": "upstream timeout", "skip_reason": None},
        {"url": "https://example.test/docs/secret", "depth": 2, "status": "skipped",
         "status_code": None, "error": None, "skip_reason": "robots"},
        {"url": "https://example.test/docs/admin", "depth": 2, "status": "skipped",
         "status_code": None, "error": None, "skip_reason": "robots"},
    ],
}

# Batch job scripted by the test before calling resume.
BATCH_SCRIPT: dict[str, object] = {}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence
        pass

    def _send(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length) or b"{}")

    def do_POST(self):  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        body = self._read_body()
        if parsed.path == "/api/v1/extract/crawl":
            assert self.headers.get("Idempotency-Key"), "crawl POST needs Idempotency-Key"
            SERVER_EVENTS.append(("crawl", self.headers.get("Idempotency-Key"), body))
            return self._send(202, {"data": {"id": CRAWL_JOB["id"],
                                             "credits_per_page": 1, **body}})
        if parsed.path == "/api/v1/extract/batch":
            assert self.headers.get("Idempotency-Key"), "batch POST needs Idempotency-Key"
            SERVER_EVENTS.append(("batch", self.headers.get("Idempotency-Key"), body))
            if BATCH_SCRIPT.get("reject_all"):
                return self._send(400, {"message": "all URLs are invalid",
                                        "invalid_urls": [
                                            {"url": u, "error": "unsupported scheme"}
                                            for u in body["urls"]]})
            job = BATCH_SCRIPT["job"]
            return self._send(202, {"data": job["job_202"]})
        self._send(404, {"message": "unknown route"})

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        if parsed.path.endswith("/crawl/" + CRAWL_JOB["id"]):
            return self._job_response(CRAWL_JOB, params)
        batch_job = BATCH_SCRIPT.get("job")
        if batch_job and parsed.path.endswith("/batch/" + batch_job["id"]):
            return self._job_response(batch_job, params)
        self._send(404, {"message": "unknown job"})

    def _job_response(self, job: dict, params: dict):
        include_content = params.get("include_content", ["true"])[0] != "false"
        status_filter = params.get("status", [None])[0]
        limit = int(params.get("limit", ["25"])[0])
        cursor = params.get("cursor", [None])[0]
        if not include_content:
            light = {k: v for k, v in job.items() if k != "results"}
            light["results"] = []
            return self._send(200, {"data": light})
        rows = [r for r in job["results"] if r["status"] == status_filter]
        start = int(cursor or 0)
        window = rows[start:start + limit]
        end = start + limit
        next_cursor = str(end) if end < len(rows) else None
        return self._send(200, {"data": {
            **{k: v for k, v in job.items() if k != "results"},
            "results": window,
            "next_cursor": next_cursor,
        }})


SERVER_EVENTS: list = []


def start_server():
    httpd = ThreadingTCPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


# --------------------------------------------------------------------------- #
# Assertions
# --------------------------------------------------------------------------- #

PASSED, FAILED = 0, 0


def check(condition: bool, label: str):
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  ok  {label}")
    else:
        FAILED += 1
        print(f"FAIL  {label}")


def main() -> int:
    httpd, base_url = start_server()
    tmp = tempfile.mkdtemp(prefix="rc-test-")
    try:
        out_dir = os.path.join(tmp, "out")
        print("== crawl ==")
        rc.main(["--base-url", base_url, "--api-key", "test-key",
                 "--poll-interval", "0", "crawl",
                 "--url", "https://example.test/docs", "--out", out_dir,
                 "--max-pages", "10"])

        pages_dir = os.path.join(out_dir, "pages")
        files = sorted(os.listdir(pages_dir))
        check(len(files) == 3, f"one file per succeeded URL, none duplicated (got {files})")
        intro_file = rc.url_to_filename("https://example.test/docs/intro", "md")
        with open(os.path.join(pages_dir, intro_file), encoding="utf-8", newline="") as h:
            check(h.read() == "# Intro\n\nline1\nline2 with **markdown**\n",
                  "markdown written byte-for-byte, never rewritten or truncated")
        check(not any("DUPLICATE" in open(os.path.join(pages_dir, f), encoding="utf-8").read()
                      for f in files), "no duplicate file was created for any URL")
        check(not os.path.exists(os.path.join(pages_dir,
                      rc.url_to_filename("https://example.test/docs/empty", "md"))),
              "empty-content success wrote no file")

        failures_path = os.path.join(out_dir, "failures.json")
        doc = json.load(open(failures_path, encoding="utf-8"))
        by_url = {i["url"]: i for i in doc["items"]}
        check(sorted(by_url) == [
            "https://example.test/docs/admin",
            "https://example.test/docs/broken",
            "https://example.test/docs/empty",
            "https://example.test/docs/secret",
        ], "failure list contains failed + skipped + empty-content URLs only")

        broken = by_url["https://example.test/docs/broken"]
        check(broken["category"] == "failed" and broken["status_code"] == 500
              and broken["error"] == "upstream timeout" and broken["skip_reason"] is None,
              "failed item: category/status_code/error kept apart")
        robots = by_url["https://example.test/docs/secret"]
        check(robots["category"] == "skipped" and robots["status_code"] is None
              and robots["skip_reason"] == "robots" and robots["error"] is None,
              "skipped item: no status_code, skip_reason recorded")
        empty = by_url["https://example.test/docs/empty"]
        check(empty["category"] == "failed"
              and "empty content" in (empty["error"] or ""),
              "empty success converted to failed with an explanation")
        check(doc["stopped_reason"] == "insufficient_credits"
              and "never fetched" in doc["stopped_note"]
              and "insufficient_credits" in doc["stopped_note"],
              "stopped_reason plus a remaining-pages warning recorded")
        check(doc["summary"] == {"succeeded": 3, "failed": 2, "skipped": 2,
                                 "remaining_unfetched": 4},
              f"summary counts split failed/skipped (got {doc['summary']})")
        index = json.load(open(os.path.join(out_dir, "page-index.json"), encoding="utf-8"))
        check(len(index) == 3 and index["https://example.test/docs/intro"]["round"] == 0,
              "index maps every succeeded URL to its unique file")
        check(len({v["file"] for v in index.values()}) == 3, "filenames are unique")
        check(SERVER_EVENTS and SERVER_EVENTS[0][0] == "crawl" and SERVER_EVENTS[0][1],
              "crawl POST carried an Idempotency-Key")

        print("== resume: batch only, one invalid URL, one new skip, one success ==")
        BATCH_SCRIPT["job"] = {
            "id": "batch_test-1",
            "type": "batch",
            "status": "completed",
            "stopped_reason": None,
            "error": None,
            "format": "markdown",
            "mode": "normal",
            "pages": {"discovered": 4, "queued": 0, "succeeded": 1, "failed": 1, "skipped": 1},
            "credits_used": 1,
            "job_202": {"id": "batch_test-1", "urls_count": 3,
                        "invalid_urls": [
                            {"url": "https://example.test/docs/admin",
                             "error": "unsupported scheme"}]},
            "results": [
                {"url": "https://example.test/docs/broken", "status": "succeeded",
                 "status_code": 200, "truncated": False, "error": None, "skip_reason": None,
                 "credits": 1, "content": "# Broken fixed\n"},
                {"url": "https://example.test/docs/secret", "status": "skipped",
                 "status_code": None, "error": None, "skip_reason": "robots"},
                {"url": "https://example.test/docs/empty", "status": "failed",
                 "status_code": 502, "error": "still empty upstream", "skip_reason": None},
            ],
        }
        code = rc.main(["--base-url", base_url, "--api-key", "test-key",
                        "--poll-interval", "0", "resume",
                        "--failures", failures_path, "--mode", "advanced"])
        check(code == 0, "resume exits 0")
        last_event = SERVER_EVENTS[-1]
        check(last_event[0] == "batch" and last_event[1],
              "resume used POST /batch with an Idempotency-Key (no crawl restart)")
        check(set(last_event[2]["urls"]) == {
            "https://example.test/docs/broken",
            "https://example.test/docs/empty",
            "https://example.test/docs/secret",
            "https://example.test/docs/admin",
        }, "only failure-list URLs were submitted")
        check(last_event[2]["mode"] == "advanced", "batch mode passed through")

        doc2 = json.load(open(failures_path, encoding="utf-8"))
        remaining = {i["url"]: i for i in doc2["items"]}
        check("https://example.test/docs/broken" not in remaining,
              "recovered URL removed from the failure list")
        check(os.path.exists(os.path.join(out_dir, "pages",
                      rc.url_to_filename("https://example.test/docs/broken", "md"))),
              "recovered page written to its own file")
        check(remaining["https://example.test/docs/admin"]["category"] == "failed"
              and remaining["https://example.test/docs/admin"]["error"] == "unsupported scheme",
              "invalid_urls merged into the next failure list")
        check(remaining["https://example.test/docs/secret"]["category"] == "skipped",
              "still-skipped URL stays in its own category")
        check(remaining["https://example.test/docs/empty"]["error"] == "still empty upstream",
              "re-failed URL keeps its new error")
        check(doc2["summary"]["succeeded"] == 4 and doc2["summary"]["remaining_unfetched"] == 3,
              f"summary updated (got {doc2['summary']})")
        check(doc2["stopped_reason"] is None and doc2["stopped_note"] is None,
              "a clean batch clears the crawl's stale early-stop warning")
        check(len(doc2["rounds"]) == 2 and doc2["rounds"][1]["kind"] == "batch"
              and doc2["rounds"][1]["invalid_urls"] == ["https://example.test/docs/admin"],
              "round history records the batch and its invalid URLs")

        print("== resume again: every URL invalid -> 400, no job, list kept ==")
        before = json.load(open(failures_path, encoding="utf-8"))
        BATCH_SCRIPT["reject_all"] = True
        code = rc.main(["--base-url", base_url, "--api-key", "test-key",
                        "--poll-interval", "0", "resume", "--failures", failures_path])
        check(code == 3, "all-invalid batch returns a distinct exit code")
        after = json.load(open(failures_path, encoding="utf-8"))
        check(after["items"] == before["items"], "failure list preserved after 400")
        check(after["rounds"][-1]["status"] == "rejected"
              and after["rounds"][-1]["error"] == "all_urls_invalid",
              "the rejected round is recorded with the API's reason")
        check(len(SERVER_EVENTS) == 3 and all(e[1] for e in SERVER_EVENTS),
              "every crawl/batch POST had an Idempotency-Key")

        print("== helpers ==")
        check(rc.url_to_filename("https://example.test/a/b?x=1", "md")
              == rc.url_to_filename("https://example.test/a/b?x=1", "md"),
              "filename derivation is deterministic for the same URL")
        check(rc.url_to_filename("https://a.test/p", "md")
              != rc.url_to_filename("https://b.test/p", "md"),
              "different URLs produce different filenames")
        check(all(c not in rc.url_to_filename("https://example.test/a/b/c", "md")
                  for c in "/?&=\\"), "filenames contain no unsafe path characters")
        check(rc.is_empty_success({"status": "succeeded", "content": ""})
              and not rc.is_empty_success({"status": "succeeded", "content": "x"}),
              "empty-content detection")
        check(rc.stopped_note("max_pages") and "max_pages" in rc.stopped_note("max_pages")
              and rc.stopped_note(None) is None, "stopped-reason notes")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        httpd.shutdown()

    print(f"\n{PASSED} passed, {FAILED} failed")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
