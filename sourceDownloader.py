#!/usr/bin/env python3
"""
Complete Website Source Code Downloader & Crawler
Author: Sagar Biswas

DISCLAIMER:
Educational and authorized testing only.
Respects server trust boundaries.
"""

import os
import re
import sys
import argparse
import hashlib
import threading
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urljoin, urlparse, unquote
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from bs4 import BeautifulSoup, FeatureNotFound


USER_AGENT = "Mozilla/5.0 (Educational Website Crawler)"
TIMEOUT = 10
visited_lock = threading.Lock()
visited = set()
processed = set()


def claim_url(url: str) -> bool:
    """Atomically check whether `url` was already seen and register it if not.

    Returns True exactly once per URL per run — the caller that gets True
    owns the URL and is responsible for enqueueing/processing it.
    """
    with visited_lock:
        if url in visited:
            return False
        visited.add(url)
        return True


def mark_processed(url: str) -> None:
    """Record that `url` was actually processed (fetched and handled)."""
    with visited_lock:
        processed.add(url)


# -----------------------------
# Networking helpers
# -----------------------------

def safe_request(url: str):
    req = Request(url, headers={"User-Agent": USER_AGENT})
    return urlopen(req, timeout=TIMEOUT)


def is_same_origin(base: str, target: str) -> bool:
    return urlparse(base).netloc == urlparse(target).netloc


# -----------------------------
# File helpers
# -----------------------------

def _guess_extension(content_type: str | None) -> str | None:
    if not content_type:
        return None

    content_type = content_type.split(";", 1)[0].strip().lower()
    mapping = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/svg+xml": ".svg",
        "image/bmp": ".bmp",
        "image/x-icon": ".ico",
        "application/pdf": ".pdf",
        "text/css": ".css",
        "application/javascript": ".js",
        "text/javascript": ".js",
    }
    return mapping.get(content_type)


def _append_query_suffix(path: str, query: str) -> str:
    if not query:
        return path

    stem, ext = os.path.splitext(path)
    suffix = hashlib.sha1(query.encode("utf-8")).hexdigest()[:12]
    return f"{stem}__{suffix}{ext}"


def sanitize_path(url: str, base_dir: str, content_type: str | None = None) -> str:
    parsed = urlparse(url)
    path = unquote(parsed.path).lstrip("/")

    if not path or path.endswith("/"):
        path = os.path.join(path, "index")

    ext = os.path.splitext(path)[1]
    if not ext:
        guessed = _guess_extension(content_type)
        if guessed:
            path = f"{path}{guessed}"
        else:
            path = f"{path}.html"

    path = _append_query_suffix(path, parsed.query)

    return os.path.join(base_dir, path)


def save_file(url: str, base_dir: str) -> str | None:
    try:
        response = safe_request(url)
        content_type = response.headers.get("Content-Type", "")
        local_path = sanitize_path(url, base_dir, content_type)

        os.makedirs(os.path.dirname(local_path), exist_ok=True)

        with open(local_path, "wb") as f:
            f.write(response.read())

        return local_path

    except (HTTPError, URLError):
        return None
# -----------------------------
# HTML processing
# -----------------------------

def extract_assets(soup: BeautifulSoup, base_url: str) -> set[str]:
    assets = set()

    for tag in soup.find_all(["link", "script", "img"]):
        attr = "href" if tag.name == "link" else "src"
        value = tag.get(attr)
        if not value:
            continue
        if isinstance(value, list):
            value = value[0] if value else ""
        if value:
            assets.add(urljoin(base_url, str(value)))

    for tag in soup.find_all(["img", "source"]):
        srcset_value = tag.get("srcset")
        if not srcset_value:
            continue
        if isinstance(srcset_value, list):
            srcset_value = " ".join(srcset_value)
        srcset_value = str(srcset_value)
        for entry in srcset_value.split(","):
            url_part = entry.strip().split(" ", 1)[0]
            if url_part:
                assets.add(urljoin(base_url, url_part))

    return assets


def extract_links(soup: BeautifulSoup, base_url: str) -> set[str]:
    links = set()

    for a in soup.find_all("a", href=True):
        href = a.get("href")
        if isinstance(href, list):
            href = href[0] if href else ""
        href = str(href) if href else ""
        if not href:
            continue
        if href.startswith("#"):
            continue

        full = urljoin(base_url, href)
        if not full.startswith(("http://", "https://")):
            continue

        parsed = urlparse(full)
        clean = parsed._replace(fragment="").geturl()
        links.add(clean)

    return links


def rewrite_links(
    soup: BeautifulSoup,
    page_url: str,
    base_dir: str,
    asset_map: dict[str, str] | None = None,
):
    page_path = sanitize_path(page_url, base_dir)
    page_dir = os.path.dirname(page_path)

    for tag in soup.find_all(["link", "script", "img"]):
        attr = "href" if tag.name == "link" else "src"
        value = tag.get(attr)
        if not value:
            continue
        if isinstance(value, list):
            value = value[0] if value else ""
        value = str(value) if value else ""
        if not value:
            continue

        full_url = urljoin(page_url, value)

        if not is_same_origin(page_url, full_url):
            continue

        if asset_map and full_url in asset_map:
            local_path = asset_map[full_url]
        else:
            local_path = sanitize_path(full_url, base_dir)

        if not os.path.exists(local_path):
            continue

        try:
            relative_path = os.path.relpath(local_path, page_dir)
            tag[attr] = relative_path.replace("\\", "/")
        except ValueError:
            tag[attr] = "/" + os.path.relpath(local_path, base_dir).replace("\\", "/")

    for tag in soup.find_all(["img", "source"]):
        srcset_value = tag.get("srcset")
        if not srcset_value:
            continue
        if isinstance(srcset_value, list):
            srcset_value = " ".join(srcset_value)
        srcset_value = str(srcset_value)

        rewritten_entries: list[str] = []
        for entry in srcset_value.split(","):
            entry = entry.strip()
            if not entry:
                continue
            parts = entry.split(" ", 1)
            url_part = parts[0]
            descriptor = parts[1] if len(parts) > 1 else ""

            full_url = urljoin(page_url, url_part)
            if not is_same_origin(page_url, full_url):
                rewritten_entries.append(entry)
                continue

            if asset_map and full_url in asset_map:
                local_path = asset_map[full_url]
            else:
                local_path = sanitize_path(full_url, base_dir)

            if not os.path.exists(local_path):
                rewritten_entries.append(entry)
                continue

            relative_path = os.path.relpath(local_path, page_dir).replace("\\", "/")
            rewritten_entries.append(f"{relative_path} {descriptor}".strip())

        if rewritten_entries:
            tag["srcset"] = ", ".join(rewritten_entries)


# -----------------------------
# Crawl + Analyze Engine
# -----------------------------

def crawl_page(args):
    url, depth, base_url, project_dir, min_depth, max_depth, no_download = args

    # The URL was already atomically claimed via claim_url() before being
    # enqueued, so it is guaranteed to be processed exactly once per run.
    if depth > max_depth:
        return []

    try:
        response = safe_request(url)
        content_type = response.headers.get("Content-Type", "")
        normalized_type = content_type.split(";", 1)[0].strip().lower()

        is_xml = url.lower().endswith(".xml") or normalized_type in {"application/xml", "text/xml"}
        is_html = normalized_type in {"text/html", "application/xhtml+xml"}

        if not is_html and not is_xml:
            local_path = sanitize_path(url, project_dir, content_type)
            os.makedirs(os.path.dirname(local_path), exist_ok=True)
            with open(local_path, "wb") as f:
                f.write(response.read())
            mark_processed(url)
            print(f"[✓] Saved asset: {url}")
            return []

        html = response.read()
        if is_xml:
            try:
                soup = BeautifulSoup(html, "xml")
            except FeatureNotFound:
                soup = BeautifulSoup(html, "html.parser")
        else:
            soup = BeautifulSoup(html, "html.parser")

        new_links = []
        for link in extract_links(soup, url):
            if is_same_origin(base_url, link):
                new_links.append((link, depth + 1))

        if min_depth <= depth <= max_depth:
            if not no_download:
                assets = extract_assets(soup, url)
                asset_map = {}
                for asset in assets:
                    local_path = save_file(asset, project_dir)
                    if local_path:
                        asset_map[asset] = local_path

                rewrite_links(soup, url, project_dir, asset_map)

                page_path = sanitize_path(url, project_dir)
                os.makedirs(os.path.dirname(page_path), exist_ok=True)
                with open(page_path, "w", encoding="utf-8", errors="ignore") as f:
                    f.write(str(soup))

            mark_processed(url)
            print(f"[✓] Analyzed (depth {depth}): {url}")
        else:
            mark_processed(url)
            print(f"[•] Crawled only (depth {depth}): {url}")

        return new_links

    except Exception as e:
        print(f"[!] Error at {url}: {e}")
        return []


def crawl_website(base_url: str, min_depth: int, max_depth: int, export_urls: bool = False, no_download: bool = False, threads: int = 1):
    global visited, processed
    visited = set()
    processed = set()

    parsed = urlparse(base_url)
    # Sanitize every character that is invalid in directory names (e.g. the
    # ":" in "host:port") so local sites can be crawled on any platform.
    project_dir = re.sub(r"[^A-Za-z0-9_-]", "_", parsed.netloc)
    os.makedirs(project_dir, exist_ok=True)

    queue = deque()
    if claim_url(base_url):
        queue.append((base_url, 0))

    def enqueue_new_links(results):
        # Links returned by workers must pass the same atomic dedup check
        # before being queued, so no URL is ever submitted twice.
        for link, d in results:
            if d <= max_depth and claim_url(link):
                queue.append((link, d))

    while queue:
        batch = []
        if threads > 1:
            for _ in range(min(threads, len(queue))):
                if queue:
                    batch.append(queue.popleft())
        else:
            batch.append(queue.popleft())

        if threads > 1 and len(batch) > 1:
            with ThreadPoolExecutor(max_workers=len(batch)) as executor:
                futures = [executor.submit(crawl_page, (url, depth, base_url, project_dir, min_depth, max_depth, no_download)) for url, depth in batch]
                for future in as_completed(futures):
                    enqueue_new_links(future.result())
        else:
            for url, depth in batch:
                results = crawl_page((url, depth, base_url, project_dir, min_depth, max_depth, no_download))
                enqueue_new_links(results)

    if export_urls:
        # Written only after every crawl task has finished; contains the
        # deduplicated, sorted set of URLs actually processed this run.
        exported = sorted(processed)
        urls_file = os.path.join(project_dir, "urls.txt")
        with open(urls_file, "w", encoding="utf-8") as f:
            for url in exported:
                f.write(url + "\n")
        print(f"[✓] Exported {len(exported)} URLs to {urls_file}")


# -----------------------------
# CLI
# -----------------------------

def parse_depth(depth_str: str) -> tuple[int, int]:
    if "-" in depth_str:
        min_d, max_d = depth_str.split("-", 1)
        return int(min_d), int(max_d)
    else:
        d = int(depth_str)
        return 0, d


def main():
    parser = argparse.ArgumentParser(description="Educational Website Source Crawler")
    parser.add_argument("url", help="Base URL (include http:// or https://)")
    parser.add_argument(
        "--depth",
        default="0",
        help="Crawl depth (e.g. 2 or 1-2)"
    )
    parser.add_argument(
        "--export-urls",
        action="store_true",
        help="Export visited URLs to urls.txt"
    )
    parser.add_argument(
        "--no-download",
        action="store_true",
        help="Only crawl and export URLs, skip downloading files"
    )
    parser.add_argument(
        "--threads",
        type=int,
        default=1,
        help="Number of threads for concurrent crawling (default: 1)"
    )

    args = parser.parse_args()

    # Avoid crashing on consoles whose encoding (e.g. GBK) cannot render
    # the status symbols; fall back to replacement characters instead.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, OSError):
            pass

    if not args.url.startswith(("http://", "https://")):
        print("[!] Invalid URL format.")
        sys.exit(1)

    min_depth, max_depth = parse_depth(args.depth)

    crawl_website(args.url, min_depth, max_depth, args.export_urls, args.no_download, args.threads)


if __name__ == "__main__":
    main()
