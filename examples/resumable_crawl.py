#!/usr/bin/env python3
"""Resumable whole-site crawl finalization for the Scavio Extract API.

A crawl job can stop halfway through: a page times out, robots.txt blocks a path,
or the balance runs out. This tool makes that survivable.

    crawl   POST /api/v1/extract/crawl  (202 + job id, Idempotency-Key)
            poll GET .../crawl/{id}?include_content=false until terminal
            page GET .../crawl/{id}?status=succeeded|failed|skipped along next_cursor
            write every succeeded page to its own file, everything else to
            failures.json, including any stopped_reason.

    resume  read failures.json and POST only those URLs to
            POST /api/v1/extract/batch (never restart the crawl). invalid_urls
            from the 202 are merged into the next failure list; if every URL is
            invalid the API answers 400 and no job is created.

Guarantees:
  * one file per URL, filename derived from the URL and stable across rounds,
    so the same URL always lands in the same file and never duplicates;
  * markdown/text/html is written exactly as returned, byte for byte;
  * a succeeded result with empty content is recorded as a failure, never
    written as an empty file pretending to be success;
  * failed (0 credits) and skipped (0 credits, e.g. robots) stay separate
    categories in failures.json;
  * every crawl/batch POST carries an Idempotency-Key, generated
    deterministically from the request when one is not supplied.

Standard library only. The API key is read from SCAVIO_API_KEY unless --api-key
is given.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
FORMAT_EXTENSIONS = {"markdown": "md", "text": "txt", "html": "html"}
PAGES_DIRNAME = "pages"
FAILURES_FILENAME = "failures.json"
INDEX_FILENAME = "page-index.json"
SCHEMA_VERSION = 1
# Only transient, never-billed statuses are retried. 400/401/402/404 are handed
# straight back to the caller because retrying them cannot help.
RETRY_STATUSES = {429, 502, 503}
MAX_ATTEMPTS = 5

STOPPED_REASON_HINTS = {
    "insufficient_credits": "the credit balance ran out",
    "max_pages": "the max_pages limit was reached",
    "time_limit": "the job's 6-hour time limit was reached",
    "storage_limit": "the per-job 250 MB storage limit was reached",
    "cancelled": "the job was cancelled before finishing",
}


class ScavioError(RuntimeError):
    """An API response the workflow cannot continue from."""


class ScavioClient:
    """Thin urllib wrapper: JSON in, (status_code, parsed_body) out.

    Retries only the transient, free-of-charge failures (429 with Retry-After,
    502/503 and transport errors), with capped exponential backoff.
    """

    def __init__(self, base_url: str, api_key: str, timeout: float = 60.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
        }

    def _open(self, method: str, url: str, payload: bytes | None,
              extra_headers: dict[str, str]) -> tuple[int, dict[str, str], bytes]:
        headers = dict(self._headers)
        headers.update(extra_headers)
        req = urllib.request.Request(url, data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers or {}), exc.read()

    def request(self, method: str, path: str, *, params: dict[str, Any] | None = None,
                body: dict[str, Any] | None = None,
                idempotency_key: str | None = None) -> tuple[int, dict[str, Any]]:
        url = self.base_url + path
        if params:
            url += "?" + urllib.parse.urlencode(
                {k: v for k, v in params.items() if v is not None}
            )
        payload = None
        headers: dict[str, str] = {}
        if body is not None:
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key

        attempt = 0
        while True:
            attempt += 1
            try:
                status, resp_headers, raw = self._open(method, url, payload, headers)
            except (urllib.error.URLError, TimeoutError) as exc:
                if attempt >= MAX_ATTEMPTS:
                    raise ScavioError(f"network error calling {method} {path}: {exc}") from exc
                time.sleep(min(2 ** attempt, 30))
                continue
            if status in RETRY_STATUSES and attempt < MAX_ATTEMPTS:
                retry_after = resp_headers.get("Retry-After")
                delay = float(retry_after) if retry_after and retry_after.isdigit() else min(2 ** attempt, 30)
                time.sleep(delay)
                continue
            try:
                parsed = json.loads(raw.decode("utf-8")) if raw else {}
            except json.JSONDecodeError as exc:
                raise ScavioError(f"{status} response from {path} was not JSON: {raw[:200]!r}") from exc
            return status, parsed

    def post_json(self, path: str, body: dict[str, Any], idempotency_key: str):
        return self.request("POST", path, body=body, idempotency_key=idempotency_key)

    def get_json(self, path: str, params: dict[str, Any] | None = None):
        return self.request("GET", path, params=params)


# --------------------------------------------------------------------------- #
# URL -> filename
# --------------------------------------------------------------------------- #

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def url_to_filename(url: str, extension: str) -> str:
    """Derive a unique, stable, filesystem-safe filename from a URL.

    The human-readable part comes from host + path; the short SHA-256 suffix is
    what guarantees uniqueness and stability. The same URL always produces the
    same filename, even across separate crawl and resume runs, so a page is
    stored once and a re-fetch overwrites its own file instead of duplicating.
    """
    parts = urllib.parse.urlsplit(url)
    host = parts.netloc.lower()
    raw_path = urllib.parse.unquote(parts.path.strip("/"))
    slug = _UNSAFE.sub("-", raw_path).strip("-._") or "index"
    if len(slug) > 80:
        slug = slug[:80].rstrip("-._") or "index"
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
    return f"{_UNSAFE.sub('-', host).strip('-._')}--{slug}--{digest}.{extension}"


# --------------------------------------------------------------------------- #
# Job handling: poll, then page every status along next_cursor
# --------------------------------------------------------------------------- #

def poll_until_terminal(client: ScavioClient, kind: str, job_id: str,
                        poll_interval: float) -> dict[str, Any]:
    """Light progress polls (include_content=false) until the job ends."""
    path = f"/api/v1/extract/{kind}/{job_id}"
    while True:
        status, body = client.get_json(path, {"include_content": "false"})
        if status != 200:
            raise ScavioError(f"polling {kind} {job_id} failed: HTTP {status} {body}")
        data = body["data"]
        if data["status"] in TERMINAL_STATUSES:
            return data
        time.sleep(poll_interval)


def fetch_all_results(client: ScavioClient, kind: str, job_id: str) -> dict[str, Any]:
    """Page through succeeded, failed and skipped results separately.

    Cursor paging is per status filter, so each of the three passes walks its
    own next_cursor chain. Keyed by URL: one record per URL even if the API
    repeats one across pages.
    """
    path = f"/api/v1/extract/{kind}/{job_id}"
    results: dict[str, dict[str, Any]] = {}
    last: dict[str, Any] = {}
    for page_status in ("succeeded", "failed", "skipped"):
        cursor = None
        while True:
            params: dict[str, Any] = {
                "status": page_status,
                "limit": 100,
                "include_content": "true",
            }
            if cursor:
                params["cursor"] = cursor
            status, body = client.get_json(path, params)
            if status != 200:
                raise ScavioError(f"fetching {page_status} pages failed: HTTP {status} {body}")
            last = body["data"]
            for result in last.get("results", []):
                results[result["url"]] = result
            cursor = last.get("next_cursor")
            if not cursor:
                break
    last["_results_by_url"] = results
    return last


# --------------------------------------------------------------------------- #
# Failure-list items
# --------------------------------------------------------------------------- #

def make_item(url: str, category: str, status_code: Any,
              error: str | None, skip_reason: str | None) -> dict[str, Any]:
    """One failures.json entry. category is exactly 'failed' or 'skipped'.

    skipped entries may carry no status_code; failed entries always explain why
    in `error`. The two are never merged because only failed pages are retried
    by default and they mean different things (fetch error vs robots/rule skip).
    """
    return {
        "url": url,
        "category": category,
        "status_code": status_code,
        "error": error,
        "skip_reason": skip_reason,
    }


def item_from_result(result: dict[str, Any]) -> dict[str, Any]:
    url = result["url"]
    status_code = result.get("status_code")
    if result["status"] == "failed":
        return make_item(url, "failed", status_code, result.get("error"), None)
    if result["status"] == "skipped":
        return make_item(url, "skipped", status_code, None, result.get("skip_reason"))
    # succeeded but content is missing/empty: a paid success with nothing in it
    # must not masquerade as a captured page.
    return make_item(
        url,
        "failed",
        status_code,
        "page reported succeeded but returned empty content",
        None,
    )


def is_empty_success(result: dict[str, Any]) -> bool:
    return result["status"] == "succeeded" and not (result.get("content") or "").strip()


def stopped_note(reason: str | None) -> str | None:
    if not reason:
        return None
    hint = STOPPED_REASON_HINTS.get(reason, reason)
    return (
        f"Job ended early with stopped_reason={reason!r} ({hint}). Pages still "
        "queued or not yet discovered were never fetched and are not itemized "
        "here; fix the cause (top up credits, raise max_pages, ...) and rerun "
        "the crawl for the remainder, or use resume for the URLs listed below."
    )


# --------------------------------------------------------------------------- #
# On-disk layout
# --------------------------------------------------------------------------- #

def write_page(out_dir: str, url: str, content: str, fmt: str,
               index: dict[str, Any], round_no: int, result: dict[str, Any]) -> str:
    """Write one page exactly as returned. Returns the file's relative path."""
    extension = FORMAT_EXTENSIONS.get(fmt, "txt")
    filename = url_to_filename(url, extension)
    pages_dir = os.path.join(out_dir, PAGES_DIRNAME)
    os.makedirs(pages_dir, exist_ok=True)
    path = os.path.join(pages_dir, filename)
    # newline="" disables Windows CRLF translation: the markdown is written
    # byte-for-byte as the API returned it, never rewritten or truncated.
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(content)
    index[url] = {
        "file": f"{PAGES_DIRNAME}/{filename}",
        "status_code": result.get("status_code"),
        "depth": result.get("depth"),
        "truncated": bool(result.get("truncated")),
        "round": round_no,
    }
    return index[url]["file"]


def load_json(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def save_json(path: str, doc: dict[str, Any]) -> None:
    """Atomic write so a crash never leaves a half-written failure list."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(doc, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp, path)


def summarize(items: list[dict[str, Any]], succeeded: int) -> dict[str, int]:
    return {
        "succeeded": succeeded,
        "failed": sum(1 for i in items if i["category"] == "failed"),
        "skipped": sum(1 for i in items if i["category"] == "skipped"),
        "remaining_unfetched": len(items),
    }


def deterministic_key(*parts: Any) -> str:
    raw = "|".join(str(p) for p in parts)
    return "scavio-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


# --------------------------------------------------------------------------- #
# Shared finalization of a finished job
# --------------------------------------------------------------------------- #

def finalize_job(out_dir: str, summary: dict[str, Any], round_no: int,
                 index: dict[str, Any]) -> tuple[list[dict[str, Any]], int]:
    """Walk every result of one job: write successes, return failure items.

    Empty-content successes count as failures (with an explanation) and never
    produce a file.
    """
    items: list[dict[str, Any]] = []
    empty = 0
    for url, result in sorted(summary["_results_by_url"].items()):
        if result["status"] == "succeeded" and not is_empty_success(result):
            write_page(out_dir, url, result["content"], summary.get("format", "markdown"),
                       index, round_no, result)
        else:
            if is_empty_success(result):
                empty += 1
            items.append(item_from_result(result))
    return items, empty


# --------------------------------------------------------------------------- #
# crawl subcommand
# --------------------------------------------------------------------------- #

def cmd_crawl(args: argparse.Namespace) -> int:
    client = ScavioClient(args.base_url, args.api_key, args.timeout)
    payload: dict[str, Any] = {
        "url": args.url,
        "max_pages": args.max_pages,
        "max_depth": args.max_depth,
        "format": args.format,
        "mode": args.mode,
    }
    if args.include_paths:
        payload["include_paths"] = args.include_paths
    if args.exclude_paths:
        payload["exclude_paths"] = args.exclude_paths
    if args.sitemap:
        payload["sitemap"] = args.sitemap

    key = args.idempotency_key or deterministic_key("crawl", json.dumps(payload, sort_keys=True))
    status, body = client.post_json("/api/v1/extract/crawl", payload, key)
    if status != 202:
        return report_rejected_start("crawl", status, body)
    job = body["data"]
    job_id = job["id"]
    print(f"crawl started: {job_id} (credits/page {job.get('credits_per_page')})")

    progress = poll_until_terminal(client, "crawl", job_id, args.poll_interval)
    print(f"crawl {progress['status']}: {progress.get('pages')} "
          f"credits_used={progress.get('credits_used')} "
          f"stopped_reason={progress.get('stopped_reason')}")
    summary = fetch_all_results(client, "crawl", job_id)

    out_dir = args.out or os.path.join("crawl-output", urllib.parse.urlsplit(args.url).netloc)
    os.makedirs(out_dir, exist_ok=True)
    index: dict[str, Any] = {}
    items, empty = finalize_job(out_dir, summary, round_no=0, index=index)

    reason = progress.get("stopped_reason")
    doc = {
        "schema_version": SCHEMA_VERSION,
        "source_job": {
            "id": job_id,
            "type": "crawl",
            "url": args.url,
            "status": progress["status"],
            "stopped_reason": reason,
            "error": progress.get("error"),
        },
        "last_job": {"id": job_id, "type": "crawl", "status": progress["status"],
                     "stopped_reason": reason},
        "stopped_reason": reason,
        "stopped_note": stopped_note(reason),
        "summary": summarize(items, len(index)),
        "items": items,
        "rounds": [{
            "round": 0,
            "kind": "crawl",
            "job_id": job_id,
            "status": progress["status"],
            "stopped_reason": reason,
            "succeeded": len(index),
            "failed": sum(1 for i in items if i["category"] == "failed"),
            "skipped": sum(1 for i in items if i["category"] == "skipped"),
            "empty_content": empty,
        }],
    }
    save_json(os.path.join(out_dir, FAILURES_FILENAME), doc)
    save_json(os.path.join(out_dir, INDEX_FILENAME), index)
    print_outcome(out_dir, doc)
    return 0


# --------------------------------------------------------------------------- #
# resume subcommand
# --------------------------------------------------------------------------- #

def cmd_resume(args: argparse.Namespace) -> int:
    failures_path = os.path.abspath(args.failures)
    doc = load_json(failures_path)
    out_dir = args.out or os.path.dirname(failures_path)
    categories = set(args.categories.split(",")) if args.categories else {"failed", "skipped"}

    old_items: list[dict[str, Any]] = doc.get("items", [])
    chosen = [item for item in old_items if item["category"] in categories]
    # Preserve order, drop duplicates defensively (the API removes them too).
    seen: set[str] = set()
    urls: list[str] = []
    for item in chosen:
        if item["url"] not in seen:
            seen.add(item["url"])
            urls.append(item["url"])
    if not urls:
        print("no URLs in failures.json match; nothing to resume")
        return 0

    round_no = len(doc.get("rounds", []))
    key = args.idempotency_key or deterministic_key(
        "batch", failures_path, round_no, json.dumps(urls, sort_keys=True)
    )
    client = ScavioClient(args.base_url, args.api_key, args.timeout)
    status, body = client.post_json(
        "/api/v1/extract/batch",
        {"urls": urls, "format": args.format, "mode": args.mode},
        key,
    )
    if status == 400:
        # Every URL was invalid: no job exists, nothing was billed. Keep the
        # list intact and record why this round could not start.
        doc.setdefault("rounds", []).append({
            "round": round_no,
            "kind": "batch",
            "status": "rejected",
            "error": "all_urls_invalid",
            "detail": body,
            "submitted": len(urls),
        })
        save_json(failures_path, doc)
        print("batch rejected (HTTP 400): all submitted URLs are invalid; no job "
              "was created and the failure list was kept for review")
        return 3
    if status != 202:
        return report_rejected_start("batch", status, body)

    job = body["data"]
    job_id = job["id"]
    invalid_urls = job.get("invalid_urls", []) or []
    print(f"batch started: {job_id} ({job.get('urls_count')} accepted, "
          f"{len(invalid_urls)} invalid)")

    progress = poll_until_terminal(client, "batch", job_id, args.poll_interval)
    summary = fetch_all_results(client, "batch", job_id)
    results = summary["_results_by_url"]

    index_path = os.path.join(out_dir, INDEX_FILENAME)
    index = load_json(index_path) if os.path.exists(index_path) else {}

    # Start from the previous list and apply this round's outcomes in place,
    # preserving order so the list stays readable across rounds.
    by_url = {item["url"]: item for item in old_items}
    order = [item["url"] for item in old_items]

    # invalid_urls from the 202 never ran and stay on the next failure list.
    for invalid in invalid_urls:
        url, error = invalid["url"], invalid.get("error") or "invalid URL rejected by batch"
        if url in by_url:
            by_url[url]["category"] = "failed"
            by_url[url]["error"] = error
            by_url[url]["skip_reason"] = None
        else:
            by_url[url] = make_item(url, "failed", None, error, None)
            order.append(url)

    counts = {"succeeded": 0, "failed": 0, "skipped": 0, "empty_content": 0}
    for url, result in results.items():
        if result["status"] == "succeeded" and not is_empty_success(result):
            write_page(out_dir, url, result["content"], summary.get("format", args.format),
                       index, round_no, result)
            counts["succeeded"] += 1
            if url in by_url:
                order.remove(url)
                del by_url[url]
            continue
        if is_empty_success(result):
            counts["empty_content"] += 1
        by_url[url] = item_from_result(result)
        if url not in order:
            order.append(url)
        counts[by_url[url]["category"]] += 1

    remaining = [by_url[url] for url in order]
    reason = progress.get("stopped_reason")
    doc["last_job"] = {"id": job_id, "type": "batch", "status": progress["status"],
                       "stopped_reason": reason}
    if reason:
        # This round itself ended early; carry the new reason forward.
        doc["stopped_reason"] = reason
        doc["stopped_note"] = stopped_note(reason)
    else:
        # The batch finished cleanly, so the crawl's early-stop warning no
        # longer describes the current state; the remaining items stand alone.
        doc["stopped_reason"] = None
        doc["stopped_note"] = None
    doc["items"] = remaining
    doc["summary"] = summarize(remaining, len(index))
    doc.setdefault("rounds", []).append({
        "round": round_no,
        "kind": "batch",
        "job_id": job_id,
        "status": progress["status"],
        "stopped_reason": reason,
        "submitted": len(urls),
        "invalid_urls": [u["url"] for u in invalid_urls],
        **counts,
    })
    save_json(failures_path, doc)
    save_json(index_path, index)
    print_outcome(out_dir, doc)
    return 0


# --------------------------------------------------------------------------- #
# CLI plumbing
# --------------------------------------------------------------------------- #

def report_rejected_start(kind: str, status: int, body: dict[str, Any]) -> int:
    message = body.get("message") or body.get("error") or body
    billing = body.get("billing_url")
    print(f"{kind} not started: HTTP {status}: {message}"
          + (f" (top up: {billing})" if billing else ""), file=sys.stderr)
    # 402 is specifically "balance below one page's cost"; 2 makes it scriptable.
    return 2 if status == 402 else 4


def print_outcome(out_dir: str, doc: dict[str, Any]) -> None:
    print(f"output: {out_dir}")
    print(f"summary: {doc['summary']}")
    if doc.get("stopped_reason"):
        print(f"stopped_reason: {doc['stopped_reason']}")
        print(f"note: {doc['stopped_note']}")
    if doc["items"]:
        print(f"next step: rerun resume against {os.path.join(out_dir, FAILURES_FILENAME)} "
              "to fetch only the remaining URLs via /api/v1/extract/batch")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", dest="base_url", default="https://api.scavio.dev",
                        help="API root (override for tests)")
    parser.add_argument("--api-key", default=os.environ.get("SCAVIO_API_KEY"),
                        help="defaults to $SCAVIO_API_KEY")
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--poll-interval", dest="poll_interval", type=float, default=5.0,
                        help="seconds between include_content=false progress polls")
    sub = parser.add_subparsers(dest="command", required=True)

    crawl = sub.add_parser("crawl", help="start a crawl and finalize it on disk")
    crawl.add_argument("--url", required=True)
    crawl.add_argument("--out", help="output directory (default crawl-output/<host>)")
    crawl.add_argument("--max-pages", dest="max_pages", type=int, default=100)
    crawl.add_argument("--max-depth", dest="max_depth", type=int, default=3)
    crawl.add_argument("--include-paths", dest="include_paths", nargs="*")
    crawl.add_argument("--exclude-paths", dest="exclude_paths", nargs="*")
    crawl.add_argument("--sitemap", choices=["include", "skip", "only"])
    crawl.add_argument("--mode", choices=["normal", "advanced", "ultra"], default="normal")
    crawl.add_argument("--format", choices=list(FORMAT_EXTENSIONS), default="markdown")
    crawl.add_argument("--idempotency-key", dest="idempotency_key")
    crawl.set_defaults(func=cmd_crawl)

    resume = sub.add_parser("resume", help="batch-extract only the URLs in a failures list")
    resume.add_argument("--failures", required=True, help="path to failures.json")
    resume.add_argument("--out", help="output directory (default: alongside failures.json)")
    resume.add_argument("--categories", default="failed,skipped",
                        help="comma-separated subset of failed,skipped (default both)")
    resume.add_argument("--mode", choices=["normal", "advanced", "ultra"], default="normal")
    resume.add_argument("--format", choices=list(FORMAT_EXTENSIONS), default="markdown")
    resume.add_argument("--idempotency-key", dest="idempotency_key")
    resume.set_defaults(func=cmd_resume)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.api_key:
        print("SCAVIO_API_KEY is not set and --api-key was not given", file=sys.stderr)
        return 5
    try:
        return args.func(args)
    except ScavioError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
