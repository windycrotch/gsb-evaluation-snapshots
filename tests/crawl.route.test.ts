import { describe, expect, it, vi } from 'vitest';
import { installMockMediaWiki } from './helpers/mockMediaWiki';
import type { CrawlResult } from '../types/graph';

vi.mock('../lib/db', () => ({
  getCachedPageLinks: vi.fn(() => null),
  setCachedPageLinks: vi.fn(),
  getCachedPageViews: vi.fn(() => null),
  setCachedPageViews: vi.fn(),
  getCachedRelationship: vi.fn(() => null),
  setCachedRelationship: vi.fn(),
  getCachedResult: vi.fn(() => null),
  setCachedResult: vi.fn(),
  generateCacheKey: vi.fn(() => 'test-cache-key'),
}));

import { POST } from '../app/api/crawl/route';
import * as database from '../lib/db';

async function postCrawl(body: Record<string, unknown>, clientIp?: string): Promise<Response> {
  const request = new Request('http://localhost/api/crawl', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(clientIp ? { 'x-real-ip': clientIp } : {}),
    },
    body: JSON.stringify(body),
  });

  return POST(request as never);
}

describe('crawl route', () => {
  it('returns not_found with suggestions for a missing seed', async () => {
    const mock = installMockMediaWiki();

    try {
      const request = new Request('http://localhost/api/crawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seedTitle: 'Typoed article', depth: 2, maxNodes: 100 }),
      });
      const response = await POST(request as never);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body).toEqual({
        error: 'not_found',
        title: 'Typoed article',
        suggestions: ['Page 0', 'Page 1'],
      });
    } finally {
      mock.restore();
    }
  });

  it('fetches a cold crawl seed link page only once', async () => {
    const mock = installMockMediaWiki({ mode: 'topical' });
    const originalFetch = globalThis.fetch;
    const seedLinkFetches: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input.toString());
      if (url.searchParams.get('prop') === 'links') {
        const titles = (url.searchParams.get('titles') ?? '').split('|');
        if (titles.includes('Page 0')) seedLinkFetches.push(url.searchParams.get('plcontinue') ?? 'initial');
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const response = await postCrawl({ seedTitle: 'Page 0', depth: 1, maxNodes: 50 }, '192.0.2.93');
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain('event: done');
      expect(seedLinkFetches).toEqual(['initial']);
      expect(mock.stats.linkRowsDownloaded).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
      mock.restore();
    }
  });

  it('rejects an expansion with too many known nodes', async () => {
  const knownNodeIds = Array.from(
    { length: 501 },
    (_, index) => `Page ${index}`,
  );

  const response = await postCrawl({
    seedTitle: 'Page 0',
    depth: 1,
    maxNodes: 50,
    knownNodeIds,
    knownEdgeIndexPairs: [],
    baseDepth: 0,
  });

  expect(response.status).toBe(400);

  const body = await response.json();

  expect(body).toEqual({
    error: 'Invalid expansion node count',
  });
});

it('rejects an expansion with too many known edges', async () => {
  const knownEdgeIndexPairs: [number, number][] = Array.from(
    { length: 50_001 },
    () => [0, 0],
  );

  const response = await postCrawl({
    seedTitle: 'Page 0',
    depth: 1,
    maxNodes: 50,
    knownNodeIds: ['Page 0'],
    knownEdgeIndexPairs,
    baseDepth: 0,
  });

  expect(response.status).toBe(400);

  const body = await response.json();

  expect(body).toEqual({
    error: 'Invalid expansion edge count',
  });
});

it('rejects an expansion with an empty node id', async () => {
  const response = await postCrawl({
    seedTitle: 'Page 0',
    depth: 1,
    maxNodes: 50,
    knownNodeIds: [''],
    knownEdgeIndexPairs: [],
    baseDepth: 0,
  });

  expect(response.status).toBe(400);

  const body = await response.json();

  expect(body).toEqual({
    error: 'Invalid expansion node id',
  });
});

it('rejects duplicate expansion node ids', async () => {
  const response = await postCrawl({
    seedTitle: 'Page 0',
    depth: 1,
    maxNodes: 50,
    knownNodeIds: ['Page 0', 'Page 0'],
    knownEdgeIndexPairs: [],
    baseDepth: 0,
  });

  expect(response.status).toBe(400);

  const body = await response.json();

  expect(body).toEqual({
    error: 'Duplicate expansion node id',
  });
});

it('rejects an expansion edge that does not contain exactly two indexes', async () => {
  const response = await postCrawl({
    seedTitle: 'Page 0',
    depth: 1,
    maxNodes: 50,
    knownNodeIds: ['Page 0'],
    knownEdgeIndexPairs: [[0] as unknown as [number, number]],
    baseDepth: 0,
  });

  expect(response.status).toBe(400);

  const body = await response.json();

  expect(body).toEqual({
    error: 'Invalid expansion edge index',
  });
});

it('rejects an expansion edge with an out-of-range index', async () => {
  const response = await postCrawl({
    seedTitle: 'Page 0',
    depth: 1,
    maxNodes: 50,
    knownNodeIds: ['Page 0'],
    knownEdgeIndexPairs: [[0, 1]],
    baseDepth: 0,
  });

  expect(response.status).toBe(400);

  const body = await response.json();

  expect(body).toEqual({
    error: 'Invalid expansion edge index',
  });
});

it('still accepts a valid expansion request', async () => {
  const mock = installMockMediaWiki();

  try {
    const response = await postCrawl({
      seedTitle: 'Page 0',
      depth: 1,
      maxNodes: 50,
      knownNodeIds: ['Page 0'],
      knownEdgeIndexPairs: [],
      baseDepth: 0,
    });

    expect(response.status).toBe(200);

    const body = await response.text();

    expect(body).toContain('event: stage\ndata: {"stage":"analyzing"}');
    expect(body).toContain('event: done');
    expect(body.indexOf('event: stage')).toBeLessThan(body.indexOf('event: analysis'));
    expect(body.indexOf('event: analysis')).toBeLessThan(body.indexOf('event: done'));
    expect(body).toContain('"result"');
  } finally {
    mock.restore();
  }
});

it('preserves expansion edges between known nodes and from new nodes to known nodes', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = new URL(input.toString());
    const property = url.searchParams.get('prop');
    if (property === 'pageviews') {
      return Response.json({ query: { pages: [] } });
    }
    const titles = (url.searchParams.get('titles') ?? '').split('|').filter(Boolean);
    return Response.json({
      query: {
        pages: titles.map((title, index) => ({
          pageid: index + 1,
          title,
          links: title === 'Expanded'
            ? [{ title: 'Page 1' }, { title: 'New A' }]
            : title === 'New A'
              ? [{ title: 'Known B' }, { title: 'New A' }, { title: 'Outside' }]
              : [],
        })),
      },
    });
  }) as typeof fetch;
  vi.mocked(database.setCachedResult).mockClear();

  try {
    const response = await postCrawl({
      seedTitle: 'Expanded',
      depth: 1,
      maxNodes: 50,
      knownNodeIds: ['Expanded', 'Page 1', 'Known B'],
      knownEdgeIndexPairs: [[0, 1]],
      baseDepth: 0,
    }, '192.0.2.92');
    const stream = await response.text();
    const doneEvent = stream.split('\n\n').find((event) => event.startsWith('event: done'));
    const payloadLine = doneEvent?.split('\n').find((line) => line.startsWith('data:'));
    const result = JSON.parse(payloadLine!.slice(5)).result as CrawlResult;
    const edgeKeys = result.edges.map((edge) => `${edge.source}|${edge.target}`);

    expect(result.nodes.map((node) => node.id)).toEqual(['New A']);
    expect(result.edges).toContainEqual({ source: 'Expanded', target: 'Page 1' });
    expect(result.edges).toContainEqual({ source: 'New A', target: 'Known B' });
    expect(edgeKeys).not.toContain('New A|New A');
    expect(edgeKeys).not.toContain('New A|Outside');
    expect(new Set(edgeKeys).size).toBe(edgeKeys.length);
    expect(database.setCachedResult).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it('returns budget-truncated crawl results without caching them as complete', async () => {
  const originalFetch = globalThis.fetch;
  let linkRequests = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(input.toString());
    if (url.searchParams.get('prop') === 'links') {
      linkRequests += 1;
      const title = url.searchParams.get('titles')?.split('|')[0] ?? 'Page 0';
      return Response.json({
        query: {
          pages: [{ pageid: 1, title, links: [{ title: 'Page 1' }] }],
        },
        continue: { plcontinue: '1|0|500' },
      });
    }
    return Response.json({ query: { pages: [] } });
  }) as typeof fetch;

  try {
    const response = await postCrawl({ seedTitle: 'Page 0', depth: 1, maxNodes: 50 }, '192.0.2.91');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(linkRequests).toBeGreaterThanOrEqual(200);
    expect(body).toContain('"partial":true');
    expect(database.setCachedResult).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it('rate limits repeated crawl requests and includes retry headers', async () => {
  vi.mocked(database.getCachedResult).mockReturnValue({
    id: 'cached-result',
    seedId: 'Page 0',
    nodes: [],
    edges: [],
    communities: [],
    crawledAt: new Date(0).toISOString(),
    positions: {},
  } as CrawlResult);

  try {
    for (let requestNumber = 0; requestNumber < 60; requestNumber += 1) {
      const response = await postCrawl(
        { seedTitle: 'Page 0', depth: 1, maxNodes: 50 },
        '192.0.2.90',
      );
      expect(response.status).toBe(200);
    }

    const response = await postCrawl(
      { seedTitle: 'Page 0', depth: 1, maxNodes: 50 },
      '192.0.2.90',
    );
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(response.headers.get('ratelimit-limit')).toBe('60');
    expect(body.error).toMatch(/Too many crawl requests/);
  } finally {
    vi.mocked(database.getCachedResult).mockReturnValue(null);
  }
});

function parseDoneEvent(stream: string): CrawlResult {
  const doneEvent = stream.split('\n\n').find((event) => event.startsWith('event: done'));
  const payloadLine = doneEvent?.split('\n').find((line) => line.startsWith('data:'));
  if (!payloadLine) throw new Error('stream ended without a done event');
  return JSON.parse(payloadLine.slice(5)).result as CrawlResult;
}

it('expand: normal expansion returns a mergeable delta with baseDepth offsets and clean edges', async () => {
  const mock = installMockMediaWiki({ mode: 'topical' });
  vi.mocked(database.setCachedResult).mockClear();

  try {
    const response = await postCrawl({
      seedTitle: 'Page 0',
      depth: 1,
      maxNodes: 50,
      knownNodeIds: ['Page 0', 'Page 3', 'Page 4'],
      knownEdgeIndexPairs: [[0, 1]],
      baseDepth: 2,
    }, '192.0.2.80');

    expect(response.status).toBe(200);
    const stream = await response.text();
    const result = parseDoneEvent(stream);
    const nodeIds = new Set([...result.nodes.map((node) => node.id), 'Page 0', 'Page 3', 'Page 4']);
    const edgeKeys = result.edges.map((edge) => `${edge.source}|${edge.target}`);

    // Only new nodes are returned, and their depth is offset by baseDepth.
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes.some((node) => ['Page 0', 'Page 3', 'Page 4'].includes(node.id))).toBe(false);
    expect(result.nodes.every((node) => node.depth === 3)).toBe(true);

    // Edges to known nodes survive; no self loops, unknown endpoints, or duplicates.
    expect(result.edges).toContainEqual({ source: 'Page 0', target: 'Page 3' });
    expect(result.edges).toContainEqual({ source: 'Page 0', target: 'Page 4' });
    for (const edge of result.edges) {
      expect(edge.source).not.toBe(edge.target);
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }
    expect(new Set(edgeKeys).size).toBe(edgeKeys.length);

    // Known-node metrics accompany the delta; expansion results are never cached.
    expect(result.metrics).toBeDefined();
    expect(Object.keys(result.metrics ?? {}).sort()).toEqual(['Page 0', 'Page 3', 'Page 4']);
    expect(database.setCachedResult).not.toHaveBeenCalled();
  } finally {
    mock.restore();
  }
});

it('expand: a client disconnect stops upstream requests but still emits a warning and partial delta', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let linkRequestsStarted = 0;
  let linkRequestsAfterAbort = 0;
  let releaseSecondRequest: ((() => void) | null) = null;
  globalThis.fetch = (async (input) => {
    const url = new URL(input.toString());
    if (url.searchParams.get('prop') === 'links') {
      linkRequestsStarted += 1;
      if (controller.signal.aborted) linkRequestsAfterAbort += 1;
      if (linkRequestsStarted === 2) {
        await new Promise<void>((resolve) => {
          releaseSecondRequest = resolve;
        });
      }
      const titles = (url.searchParams.get('titles') ?? '').split('|').filter(Boolean);
      return Response.json({
        query: {
          pages: titles.map((title, index) => ({
            pageid: index + 1,
            title,
            links: [{ title: 'New A' }, { title: 'New B' }],
          })),
        },
      });
    }
    return Response.json({ query: { pages: [] } });
  }) as typeof fetch;
  vi.mocked(database.setCachedResult).mockClear();

  try {
    const request = new Request('http://localhost/api/crawl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-real-ip': '192.0.2.81' },
      body: JSON.stringify({
        seedTitle: 'Expanded',
        depth: 2,
        maxNodes: 100,
        knownNodeIds: ['Expanded', 'Known B'],
        knownEdgeIndexPairs: [],
        baseDepth: 1,
      }),
      signal: controller.signal,
    });
    const responsePromise = POST(request as never);

    // Wait until the second link request is in flight, then simulate the client going away.
    await vi.waitFor(() => expect(releaseSecondRequest).not.toBeNull());
    const requestsAtAbort = linkRequestsStarted;
    controller.abort();
    const release = releaseSecondRequest as (() => void) | null;
    release?.();

    const response = await responsePromise;
    expect(response.status).toBe(200);
    const stream = await response.text();

    expect(stream).toContain('event: warning');
    const warningEvent = stream.split('\n\n').find((event) => event.startsWith('event: warning'));
    expect(warningEvent).toContain('"reason":"aborted"');

    const result = parseDoneEvent(stream);
    expect(result.partial).toBe(true);
    // Anything fetched before the disconnect remains in the mergeable delta.
    const nodeIds = new Set([...result.nodes.map((node) => node.id), 'Expanded', 'Known B']);
    for (const edge of result.edges) {
      expect(edge.source).not.toBe(edge.target);
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }
    const edgeKeys = result.edges.map((edge) => `${edge.source}|${edge.target}`);
    expect(new Set(edgeKeys).size).toBe(edgeKeys.length);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(linkRequestsAfterAbort).toBe(0);
    expect(linkRequestsStarted).toBe(requestsAtAbort);
    expect(database.setCachedResult).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it('a cold crawl with a rate-limited seed still closes with a partial result instead of an error event', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ error: 'rate limited' }),
    { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '0.001' } },
  )) as typeof fetch;
  vi.mocked(database.setCachedResult).mockClear();

  try {
    const response = await postCrawl(
      { seedTitle: 'Page 0', depth: 1, maxNodes: 50 },
      '192.0.2.86',
    );
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(stream).not.toContain('event: error');
    expect(stream).toContain('event: warning');
    const result = parseDoneEvent(stream);
    expect(result.partial).toBe(true);
    expect(result.failedTitles).toContain('Page 0');
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(database.setCachedResult).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it('expand: persistent upstream 429s yield a partial delta instead of failing the whole request', async () => {
  const originalFetch = globalThis.fetch;
  let rateLimitedRequests = 0;
  globalThis.fetch = (async () => {
    rateLimitedRequests += 1;
    return new Response(JSON.stringify({ error: 'rate limited' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '0.001' },
    });
  }) as typeof fetch;
  vi.mocked(database.setCachedResult).mockClear();

  try {
    const response = await postCrawl({
      seedTitle: 'Expanded',
      depth: 1,
      maxNodes: 50,
      knownNodeIds: ['Expanded', 'Known B'],
      knownEdgeIndexPairs: [],
      baseDepth: 1,
    }, '192.0.2.85');
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(rateLimitedRequests).toBeGreaterThan(0);
    expect(stream).toContain('event: warning');
    const result = parseDoneEvent(stream);
    expect(result.partial).toBe(true);
    expect(result.failedTitles).toContain('Expanded');
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(database.setCachedResult).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it('expand: budget exhaustion returns partial with failedTitles and no result-cache write', async () => {
  const originalFetch = globalThis.fetch;
  let linkRequests = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(input.toString());
    if (url.searchParams.get('prop') === 'links') {
      linkRequests += 1;
      const title = url.searchParams.get('titles')?.split('|')[0] ?? 'Page 0';
      return Response.json({
        query: {
          pages: [{ pageid: 1, title, links: [{ title: 'New A' }, { title: 'Known B' }] }],
        },
        continue: { plcontinue: '1|0|500' },
      });
    }
    return Response.json({ query: { pages: [] } });
  }) as typeof fetch;
  vi.mocked(database.setCachedResult).mockClear();

  try {
    const response = await postCrawl({
      seedTitle: 'Page 0',
      depth: 2,
      maxNodes: 500,
      knownNodeIds: ['Page 0', 'Known B'],
      knownEdgeIndexPairs: [[0, 1]],
      baseDepth: 1,
    }, '192.0.2.82');
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(linkRequests).toBeGreaterThanOrEqual(200);
    expect(stream).toContain('event: warning');
    const result = parseDoneEvent(stream);
    expect(result.partial).toBe(true);
    expect(Array.isArray(result.failedTitles)).toBe(true);

    // The edge to the known node survives and the delta stays clean.
    expect(result.edges).toContainEqual({ source: 'Page 0', target: 'Known B' });
    const nodeIds = new Set([...result.nodes.map((node) => node.id), 'Page 0', 'Known B']);
    const edgeKeys = result.edges.map((edge) => `${edge.source}|${edge.target}`);
    for (const edge of result.edges) {
      expect(edge.source).not.toBe(edge.target);
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }
    expect(new Set(edgeKeys).size).toBe(edgeKeys.length);
    expect(database.setCachedResult).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it('expand: concurrent expansions of the same seed return independent, non-polluted deltas', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = new URL(input.toString());
    if (url.searchParams.get('prop') === 'pageviews') {
      return Response.json({ query: { pages: [] } });
    }
    const titles = (url.searchParams.get('titles') ?? '').split('|').filter(Boolean);
    return Response.json({
      query: {
        pages: titles.map((title, index) => ({
          pageid: index + 1,
          title,
          links: title === 'Expanded'
            ? [{ title: 'Shared New' }, { title: 'Only A' }, { title: 'Only B' }]
            : [],
        })),
      },
    });
  }) as typeof fetch;

  try {
    const [responseA, responseB] = await Promise.all([
      postCrawl({
        seedTitle: 'Expanded',
        depth: 1,
        maxNodes: 50,
        knownNodeIds: ['Expanded', 'Known A'],
        knownEdgeIndexPairs: [],
        baseDepth: 1,
      }, '192.0.2.83'),
      postCrawl({
        seedTitle: 'Expanded',
        depth: 1,
        maxNodes: 50,
        knownNodeIds: ['Expanded', 'Known B'],
        knownEdgeIndexPairs: [[0, 1]],
        baseDepth: 4,
      }, '192.0.2.84'),
    ]);

    const [streamA, streamB] = await Promise.all([
      responseA.text(),
      responseB.text(),
    ]);
    const resultA = parseDoneEvent(streamA);
    const resultB = parseDoneEvent(streamB);

    // Each response carries only its own delta; the other request's known node never leaks in.
    expect(resultA.nodes.map((node) => node.id).sort()).toEqual(['Only A', 'Only B', 'Shared New']);
    expect(resultB.nodes.map((node) => node.id).sort()).toEqual(['Only A', 'Only B', 'Shared New']);
    expect(resultA.nodes.some((node) => node.id === 'Known B')).toBe(false);
    expect(resultB.nodes.some((node) => node.id === 'Known A')).toBe(false);

    // baseDepth is per-request.
    expect(resultA.nodes.every((node) => node.depth === 2)).toBe(true);
    expect(resultB.nodes.every((node) => node.depth === 5)).toBe(true);

    // Metrics describe only the known nodes that each client actually sent.
    expect(Object.keys(resultA.metrics ?? {}).sort()).toEqual(['Expanded', 'Known A']);
    expect(Object.keys(resultB.metrics ?? {}).sort()).toEqual(['Expanded', 'Known B']);

    // Edges stay clean in both deltas.
    for (const result of [resultA, resultB]) {
      const nodeIds = new Set([
        ...result.nodes.map((node) => node.id),
        'Expanded',
        ...Object.keys(result.metrics ?? {}),
      ]);
      const keys = result.edges.map((edge) => `${edge.source}|${edge.target}`);
      for (const edge of result.edges) {
        expect(edge.source).not.toBe(edge.target);
        expect(nodeIds.has(edge.source)).toBe(true);
        expect(nodeIds.has(edge.target)).toBe(true);
      }
      expect(new Set(keys).size).toBe(keys.length);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

});