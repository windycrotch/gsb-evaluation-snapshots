import { JSDOM } from "jsdom";
import { extractFast, extractDeep, type LinkFormat, type ImageMode } from "./extractor.js";
import { validateTargetUrl } from "./security.js";
import { fetchHtml } from "./extractor.js";

export interface DiscoveredUrl {
  url: string;
  source: "sitemap" | "robots" | "html_link";
  lastmod?: string;
}

export interface MapWebsiteOptions {
  url: string;
  maxLinks?: number;
  maxUrls?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
  timeoutMs?: number;
}

export interface MapWebsiteResult {
  host: string;
  sitemapsFound: string[];
  totalDiscovered: number;
  urls: DiscoveredUrl[];
}

export interface CrawlWebsiteOptions {
  startUrl?: string;
  url?: string;
  maxDepth?: number;
  maxPages?: number;
  concurrency?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
  mode?: "fast" | "deep";
  linkFormat?: LinkFormat;
  imageMode?: ImageMode;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  proxy?: string;
  timeoutMs?: number;
  /**
   * Total wall-clock budget for the whole crawl, measured from function
   * entry. Once exhausted no new pages are dispatched; in-flight requests
   * may finish but queued URLs are dropped.
   */
  maxDurationMs?: number;
  /**
   * Maximum retries per page for recoverable failures (timeouts, HTTP
   * 429/5xx, network errors). Non-recoverable failures (403, anti-bot /
   * CAPTCHA challenges, invalid URLs) are never retried. Defaults to 0.
   */
  maxRetries?: number;
}

export interface CrawledPage {
  url: string;
  depth: number;
  markdown: string;
  charCount: number;
  estimatedTokens: number;
  /** How many fetch attempts this page consumed (1 for an immediate success). */
  attempts: number;
  error?: string;
}

export interface CrawlWebsiteResult {
  startUrl: string;
  totalPagesCrawled: number;
  totalEstimatedTokens: number;
  /** True when the crawl ended early because maxDurationMs ran out. */
  stoppedByBudget: boolean;
  /** Queued URLs never processed because of the time budget or maxPages. */
  skippedCount: number;
  pages: CrawledPage[];
}

const MAX_URL_PATTERNS = 10;
const MAX_URL_PATTERN_LENGTH = 200;

/**
 * Compile include/exclude filters. Patterns are case-sensitive substrings where
 * `*` matches any run of characters; they are deliberately NOT regexes because
 * crawled URLs are attacker-controlled and a backtracking regex like
 * `^(([a-z/:.])+)+$` blocks the event loop for seconds (ReDoS).
 */
export function compileUrlPatterns(patterns: string[], kind: "include" | "exclude"): Array<(s: string) => boolean> {
  if (patterns.length > MAX_URL_PATTERNS) throw new Error(`Too many ${kind} patterns (max ${MAX_URL_PATTERNS})`);
  return patterns.map((p) => {
    if (p.length > MAX_URL_PATTERN_LENGTH) throw new Error(`${kind} pattern is too long (max ${MAX_URL_PATTERN_LENGTH} characters)`);
    // Fail loudly on old regex syntax: silently matching it literally would turn
    // an exclude like "logout|admin" into a no-op. ("?" and "+" stay legal: URLs use them.)
    if (/[\\^$()[\]{}|]|\.\*/.test(p)) {
      throw new Error(`Invalid ${kind} pattern "${p}": patterns are substrings where * is the only wildcard, not regexes`);
    }
    const parts = p.split("*").filter(Boolean);
    return (s: string) => {
      let at = 0;
      for (const part of parts) {
        const i = s.indexOf(part, at);
        if (i < 0) return false;
        at = i + part.length;
      }
      return true;
    };
  });
}

function makeUrlFilter(host: string, includePatterns: string[], excludePatterns: string[]): (candidate: string) => boolean {
  const include = compileUrlPatterns(includePatterns, "include");
  const exclude = compileUrlPatterns(excludePatterns, "exclude");
  return (candidate) => {
    try {
      const parsed = new URL(candidate);
      if (parsed.hostname !== host) return false;
      const hit = (m: (s: string) => boolean) => m(parsed.pathname) || m(candidate);
      if (exclude.some(hit)) return false;
      return include.length === 0 || include.some(hit);
    } catch {
      return false;
    }
  };
}

/**
 * Discover the architecture and page inventory of a website via sitemaps, robots.txt, and link graphs.
 */
export async function mapWebsite(options: MapWebsiteOptions): Promise<MapWebsiteResult> {
  const { url, timeoutMs = 10000, includePatterns = [], excludePatterns = [] } = options;
  const maxLimit = options.maxUrls ?? options.maxLinks ?? 100;
  await validateTargetUrl(url);

  const parsedStart = new URL(url);
  const origin = parsedStart.origin;
  const sitemapsFound: string[] = [];
  const discoveredMap = new Map<string, DiscoveredUrl>();

  const isUrlAllowed = makeUrlFilter(parsedStart.hostname, includePatterns, excludePatterns);

  // 1. Inspect robots.txt for declared sitemaps
  try {
    const robotsUrl = `${origin}/robots.txt`;
    const robotsTxt = await fetchHtml(robotsUrl, { timeoutMs: 5000 });
    const sitemapRegex = /Sitemap:\s*(https?:\/\/[^\s\r\n]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = sitemapRegex.exec(robotsTxt)) !== null) {
      const sitemapUrl = match[1].trim();
      if (!sitemapsFound.includes(sitemapUrl)) {
        sitemapsFound.push(sitemapUrl);
      }
    }
  } catch {
    /* robots.txt unavailable or blocked */
  }

  // Fallback to default sitemap.xml if none detected
  if (sitemapsFound.length === 0) {
    sitemapsFound.push(`${origin}/sitemap.xml`);
  }

  // 2. Fetch and parse sitemaps
  for (const sitemapUrl of sitemapsFound) {
    if (discoveredMap.size >= maxLimit) break;
    try {
      await validateTargetUrl(sitemapUrl);
      const xmlContent = await fetchHtml(sitemapUrl, { timeoutMs });
      const locRegex = /<loc>\s*(https?:\/\/[^<\s]+)\s*<\/loc>/gi;
      const lastmodRegex = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i;

      let locMatch: RegExpExecArray | null;
      while ((locMatch = locRegex.exec(xmlContent)) !== null) {
        const foundUrl = locMatch[1].trim();
        try {
          if (isUrlAllowed(foundUrl) && !discoveredMap.has(foundUrl)) {
            // Extract snippet for lastmod if present around loc
            const chunk = xmlContent.slice(locMatch.index, locMatch.index + 300);
            const lastmodMatch = chunk.match(lastmodRegex);
            discoveredMap.set(foundUrl, {
              url: foundUrl,
              source: "sitemap",
              lastmod: lastmodMatch ? lastmodMatch[1] : undefined,
            });
            if (discoveredMap.size >= maxLimit) break;
          }
        } catch {
          /* skip invalid URLs */
        }
      }
    } catch {
      /* sitemap fetch failed */
    }
  }

  // 3. If sitemaps yielded few links, parse links from root HTML page
  if (discoveredMap.size < 10) {
    try {
      const homeHtml = await fetchHtml(url, { timeoutMs });
      const dom = new JSDOM(homeHtml, { url });
      const anchors = Array.from(dom.window.document.querySelectorAll("a[href]"));

      for (const a of anchors) {
        if (discoveredMap.size >= maxLimit) break;
        const href = a.getAttribute("href");
        if (!href) continue;

        try {
          const resolved = new URL(href, url);
          if (resolved.protocol === "http:" || resolved.protocol === "https:") {
            resolved.hash = "";
            const cleanUrl = resolved.toString();
            if (isUrlAllowed(cleanUrl) && !discoveredMap.has(cleanUrl)) {
              discoveredMap.set(cleanUrl, {
                url: cleanUrl,
                source: "html_link",
              });
            }
          }
        } catch {
          /* ignore unparseable links */
        }
      }
    } catch {
      /* home page fetch failed */
    }
  }

  const urls = Array.from(discoveredMap.values()).slice(0, maxLimit);

  return {
    host: parsedStart.hostname,
    sitemapsFound,
    totalDiscovered: urls.length,
    urls,
  };
}

/**
 * Pull every outbound href out of an already-extracted markdown document.
 *
 * Covers both link formats we emit: inline `[text](url)` and the footnote
 * reference block (`[1]: https://...`) produced by `link_format: references`.
 * `strip` yields neither, which is why the caller falls back to a refetch.
 */
export function extractHrefsFromMarkdown(markdown: string): string[] {
  const hrefs: string[] = [];
  const inline = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = inline.exec(markdown)) !== null) {
    hrefs.push(m[1]);
  }
  const footnote = /^\[\d+\]:\s*(\S+)/gm;
  while ((m = footnote.exec(markdown)) !== null) {
    hrefs.push(m[1]);
  }
  return hrefs;
}

/**
 * Decide whether a page-fetch failure is worth retrying.
 *
 * Recoverable: timeouts, HTTP 429 / 5xx (including the "Anti-Bot protection
 * triggered: HTTP Status 503" wrapper fetchHtml puts around them), and
 * network-level failures (socket resets, DNS, connection refused).
 * Everything else — 403, CAPTCHA/challenge pages, SSRF blocks, invalid
 * URLs, oversize responses — is final.
 */
export function isRecoverableCrawlError(message: string): boolean {
  if (/timed out/i.test(message)) return true;
  if (/HTTP (?:Status )?429/.test(message)) return true;
  if (/HTTP (?:Status )?5\d{2}/.test(message)) return true;
  if (/HTTP (?:Status )?\d{3}/.test(message)) return false;
  if (/Anti-Bot|not allowed|invalid|credentials|exceeds maximum size/i.test(message)) return false;
  return true;
}

const RETRY_INITIAL_BACKOFF_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Perform autonomous, recursive website crawling with depth boundaries, regex route filtering, and token accounting.
 */
export async function crawlWebsite(options: CrawlWebsiteOptions): Promise<CrawlWebsiteResult> {
  // The total-duration budget is measured from function entry.
  const crawlStartMs = Date.now();
  const startUrl = options.startUrl || options.url;
  if (!startUrl) {
    throw new Error("Missing startUrl for crawler");
  }
  const {
    maxDepth = 2,
    maxPages = 10,
    concurrency = 3,
    includePatterns = [],
    excludePatterns = [],
    mode = "fast",
    linkFormat,
    imageMode,
    headers,
    cookies,
    proxy,
    timeoutMs = 15000,
    maxDurationMs,
    maxRetries = 0,
  } = options;

  await validateTargetUrl(startUrl);
  const targetHost = new URL(startUrl).hostname;

  // Total crawl budget, measured from function entry so URL validation and
  // filter setup are included.
  const deadline =
    typeof maxDurationMs === "number" && Number.isFinite(maxDurationMs)
      ? crawlStartMs + Math.max(0, maxDurationMs)
      : Number.POSITIVE_INFINITY;

  const isUrlAllowed = makeUrlFilter(targetHost, includePatterns, excludePatterns);

  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
  const visited = new Set<string>([startUrl]);
  const pages: CrawledPage[] = [];

  // When the caller asks for crawl-level retries, the extractor's own
  // retry/escalation policy is switched off so every attempt (and its
  // backoff) is accounted for here against the total-duration budget.
  // With the default maxRetries: 0 the extractor behaves exactly as before.
  const extractorRetryOverrides =
    maxRetries > 0 ? { maxRetries: 0, escalate: false } : {};

  const crawlPage = async ({ url: currentUrl, depth }: { url: string; depth: number }): Promise<void> => {
    let attempts = 0;
    let backoffMs = RETRY_INITIAL_BACKOFF_MS;
    // Retried attempts re-run the same extract call, so validateTargetUrl
    // and the URL filters apply to every attempt exactly as before.
    while (true) {
      attempts++;
      try {
        let markdown: string;
        if (mode === "deep") {
          markdown = await extractDeep({
            url: currentUrl,
            timeoutMs,
            headers,
            cookies,
            proxy,
            linkFormat,
            imageMode,
            ...extractorRetryOverrides,
          });
        } else {
          markdown = await extractFast({
            url: currentUrl,
            timeoutMs,
            headers,
            cookies,
            proxy,
            linkFormat,
            imageMode,
            ...extractorRetryOverrides,
          });
        }

        const charCount = markdown.length;
        const estimatedTokens = Math.ceil(charCount / 4);

        pages.push({
          url: currentUrl,
          depth,
          markdown,
          charCount,
          estimatedTokens,
          attempts,
        });

        // If depth allows, discover outgoing links from this page
        if (depth < maxDepth && pages.length + queue.length < maxPages * 2) {
          try {
            // Reuse the markdown we already have instead of re-fetching the
            // page. A second fetchHtml doubles the traffic and, in `deep`
            // mode, returns raw SPA markup with an empty <div id="root">, so
            // link discovery silently found nothing and the crawl stopped.
            // The rendered markdown carries every href the browser saw.
            let hrefs = extractHrefsFromMarkdown(markdown);
            if (hrefs.length === 0 && linkFormat === "strip") {
              // `strip` removes URLs by design; the page may still be worth
              // one extra fetch if it has no other way to expose its links.
              const html = await fetchHtml(currentUrl, { timeoutMs: 5000, headers, cookies, proxy });
              const dom = new JSDOM(html, { url: currentUrl });
              hrefs = Array.from(dom.window.document.querySelectorAll("a[href]"))
                .map((a) => a.getAttribute("href") || "");
            }

            for (const href of hrefs) {
              if (!href) continue;
              try {
                const resolved = new URL(href, currentUrl);
                resolved.hash = "";
                const normalizedUrl = resolved.toString();

                if (!visited.has(normalizedUrl) && isUrlAllowed(normalizedUrl)) {
                  visited.add(normalizedUrl);
                  queue.push({ url: normalizedUrl, depth: depth + 1 });
                }
              } catch {
                /* skip */
              }
            }
          } catch {
            /* link discovery error ignored */
          }
        }
        return;
      } catch (err: any) {
        const message = err?.message || String(err);
        const remainingMs = deadline - Date.now();
        if (attempts <= maxRetries && isRecoverableCrawlError(message) && remainingMs > 0) {
          // Increasing backoff between retries; the wait consumes the same
          // total-duration budget, so it is capped at what remains.
          await sleep(Math.min(backoffMs, remainingMs));
          backoffMs *= 2;
          continue;
        }
        pages.push({
          url: currentUrl,
          depth,
          markdown: "",
          charCount: 0,
          estimatedTokens: 0,
          attempts,
          error: message,
        });
        return;
      }
    }
  };

  // Worker pool: a slot is refilled as soon as its page finishes. Fixed-size
  // waves (`Promise.all` per batch) left every slot idle until the slowest page
  // of the batch returned.
  let inFlight = 0;
  let stoppedByBudget = false;
  let skippedCount = 0;
  await new Promise<void>((resolve) => {
    const pump = () => {
      if (Date.now() >= deadline && (queue.length > 0 || inFlight > 0)) {
        // Budget exhausted: stop dispatching new pages. In-flight requests
        // are left to finish; everything still queued is dropped.
        stoppedByBudget = true;
        skippedCount += queue.length;
        queue.length = 0;
      }
      while (inFlight < concurrency && queue.length > 0 && pages.length + inFlight < maxPages) {
        const item = queue.shift()!;
        inFlight++;
        crawlPage(item).finally(() => {
          inFlight--;
          pump();
        });
      }
      if (inFlight === 0) {
        // URLs left behind because maxPages (not the time budget) stopped
        // dispatching also count as skipped.
        skippedCount += queue.length;
        queue.length = 0;
        resolve();
      }
    };
    pump();
  });

  const totalEstimatedTokens = pages.reduce((sum, p) => sum + p.estimatedTokens, 0);

  return {
    startUrl,
    totalPagesCrawled: pages.length,
    totalEstimatedTokens,
    stoppedByBudget,
    skippedCount,
    pages,
  };
}
