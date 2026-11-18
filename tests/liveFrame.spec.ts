import { expect, test } from '@playwright/test';

test('runtime dark, order and shared clips preserve snapshots, filters and nested leases', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const rows = await page.evaluate(() => window.rigPlayHarness.runtimeMetadataProbe());
  expect(rows).toHaveLength(4);
  for (const row of rows) {
    expect(row.poser).toBe('runtime');
    expect(row.difference, row.rig).toBeNull();
    expect(row.filterDifference, row.rig).toBeNull();
    expect(row.afterFilterDifference, row.rig).toBeNull();
    expect(row.snapshotKept, row.rig).toBe(true);
    expect(row.nestedStale, row.rig).toBe(true);
    expect(row.readonly, row.rig).toBe(true);
  }
  expect(rows.find(row => row.rig === 'figure')!.shared).toBe(true);
});

test('physics names its oracle policy and preserves nonloop timeScale, replay and movement', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const rows = await page.evaluate(() => window.rigPlayHarness.runtimePhysicsPolicyProbe());
  for (const row of rows) {
    expect(row.poser).toMatch(/^oracle: physics constraint ".+" requires player clock, seek and movement integration$/);
    expect(row.difference, row.operation).toBeNull();
    expect(row.timeDifference, row.operation).toBeNull();
  }
});

test('runtime clip movement reuses mesh rasters, inverse uses path and disappearance restores the root', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const rows = await page.evaluate(() => window.rigPlayHarness.runtimeClipRendererProbe());
  expect(rows.every(row => row.poser === 'runtime')).toBe(true);
  expect(rows[0].meshes).toBeGreaterThan(0);
  for (const row of rows.slice(1)) {
    expect(row.meshes).toBe(0);
    expect(row.reused).toBeGreaterThan(0);
  }
  expect(rows[1].clipWrites).toBe(0);
  expect(rows[2].rootClip).not.toBe(rows[1].rootClip);
  expect(rows[3].elementPaths.some(path => path.startsWith('path('))).toBe(true);
  expect(rows[3].rootClip).toBe('inset(0px)');
  expect(rows[4].rootClip).toBe('inset(0px)');
  expect(rows[4].elementPaths.every(path => path === '')).toBe(true);
  expect(rows[4].frameHasClip).toBe(false);
});

for (const rig of ['walk', 'flex', 'squash', 'portrait', 'nod', 'look', 'ride', 'figure', 'glow', 'turned', 'duo']) {
  test(`live frame exact values, snapshots and pixels: ${rig}`, async ({ page }) => {
    await page.goto('/tests/harness.html');
    await page.waitForFunction(() => Boolean(window.rigPlayHarness));
    const result = await page.evaluate(rig => window.rigPlayHarness.liveFrameProbe(rig), rig);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.numeric, `${rig}/${row.animation}: ${row.poser}`).toEqual([]);
      if (row.pixelValues > 0 && row.contentPixels > 0) expect(row.pixelDifferences, `${rig}/${row.animation}: ${row.poser}`).toBe(0);
      else console.log('LIVE_FRAME_PIXEL_SKIP', `${rig}/${row.animation}: no drawable content at the sampled times`);
      expect(row.snapshotKept).toBe(true);
      expect(row.stale).toBe(true);
      expect(row.nestedStale).toBe(true);
      expect(row.rendererStale).toBe(true);
      expect(row.readonly).toBe(true);
      expect(row.freshQuery).toBe(true);
      expect(row.staleQuery).toBe(true);
      expect(row.nestedStaleQuery).toBe(true);
      if (row.poser === 'runtime') expect(row.drawIdentity).toBe(true);
      else expect(row.drawIdentity).toBeNull();
    }
    console.log('LIVE_FRAME_CASE', JSON.stringify(result));
  });
}

for (const [rig, animation] of [['figure', 'tilted_moved'], ['walk', undefined]] as Array<[string, string | undefined]>) {
  test(`live frame isStale query: fresh, stale, nested and readonly paths: ${rig}`, async ({ page }) => {
    await page.goto('/tests/harness.html');
    await page.waitForFunction(() => Boolean(window.rigPlayHarness));
    const result = await page.evaluate(([rig, animation]) => window.rigPlayHarness.liveFrameStaleQuery(rig, animation ?? undefined), [rig, animation] as [string, string | undefined]);
    expect(result.poser, rig).toBe('runtime');
    // Normal path: the fresh borrow queries clean, repeatedly, and reads real values.
    expect(result.fresh, rig).toBe(true);
    expect(result.freshRepeated, rig).toBe(true);
    expect(typeof result.firstValue, rig).toBe('number');
    // Readonly path: a write is a read-only violation, never confused with expiry.
    expect(result.readonly, rig).toBe(true);
    expect(result.readonlyKeptFresh, rig).toBe(true);
    // Stale path: one pose step expires the borrow; the query observes it without throwing.
    expect(result.stale, rig).toBe(true);
    expect(result.staleRead, rig).toBe(true);
    expect(result.staleRepeated, rig).toBe(true);
    // Nested path: the vertex buffer (and the clip polygon, where the rig has one) agrees.
    expect(result.nestedStale, rig).toBe(true);
    expect(result.nestedRead, rig).toBe(true);
    if (rig === 'figure') {
      expect(result.polygonStale, rig).toBe(true);
      expect(result.polygonRead, rig).toBe(true);
    } else {
      expect(result.polygonStale, rig).toBeNull();
    }
    // The query never renews: a fresh lease is clean while the expired one stays expired.
    expect(result.renewed, rig).toBe(true);
    // Production reuse path: same buffers, values coherent with the snapshot.
    expect(result.production.reused, rig).toBe(true);
    expect(result.production.queriedFresh, rig).toBe(true);
    expect(result.production.valuesMatch, rig).toBe(true);
    // Oracle fallback: the raw borrowed frame keys its query off the generation.
    expect(result.oracleFresh, rig).toBe(true);
    expect(result.oracleStale, rig).toBe(true);
    console.log('LIVE_FRAME_STALE_QUERY', JSON.stringify(result));
  });
}

test('runtime composition fallback keeps time and invalidates old views', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const result = await page.evaluate(() => window.rigPlayHarness.liveFrameTransitions());
  expect(result.beforeCount).toBeGreaterThan(0);
  expect(result.composedReason).toContain('oracle: track composition');
  expect(result.composedTime).toBe(result.at);
  expect(result.oldStale).toBe(true);
  expect(result.disposed).toBe(true);
});

test('planted vertex, snapshot and unchecked-lease defects fail their gates', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const corrupt = await page.evaluate(() => window.rigPlayHarness.liveFrameProbe('turned', 'vertices'));
  expect(corrupt.rows.some(row => row.poser === 'runtime' && row.numeric.length > 0)).toBe(true);
  expect(corrupt.rows.some(row => row.pixelDifferences > 0)).toBe(true);
  const unchecked = await page.evaluate(() => window.rigPlayHarness.liveFrameProbe('turned', 'lease'));
  expect(unchecked.rows.some(row => row.poser === 'runtime' && !row.stale && !row.nestedStale && !row.rendererStale && !row.readonly && !row.staleQuery && !row.nestedStaleQuery)).toBe(true);
  const shared = await page.evaluate(() => window.rigPlayHarness.liveFrameProbe('walk', 'snapshot'));
  expect(shared.rows.some(row => row.poser === 'runtime' && !row.snapshotKept)).toBe(true);
});


test('a null attachment key without a setup attachment has coherent runtime/oracle identity', async ({ page }) => {
  await page.route('**/rigs/turned/skeleton.model.json', async route => {
    const response = await route.fetch();
    const model: { slots: Array<{ name: string; setup: string | null }>; animations: Array<{ slots: Array<{ name: string; timelines: Array<{ name: string; keys: Array<{ time: number; name: string | null }> }> }> }> } = await response.json();
    const slot = model.slots.find(value => value.name === 's');
    const timeline = model.animations[0].slots.find(value => value.name === 's')?.timelines.find(value => value.name === 'attachment');
    if (!slot || !timeline) throw Error('NULL_IDENTITY_FIXTURE: turned needs slot s and its attachment timeline');
    slot.setup = null;
    timeline.keys = [{ time: 0.25, name: null }, { time: 1, name: null }];
    await route.fulfill({ response, json: model });
  });
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const clean = await page.evaluate(() => window.rigPlayHarness.liveFrameNullIdentity());
  expect(clean.every(row => row.poser === 'runtime' && row.difference === null)).toBe(true);
  expect(clean.map(row => row.actual)).toEqual(['no-attachment', 'no-attachment', 'timeline-null', 'timeline-null', 'timeline-null']);
  const planted = await page.evaluate(() => window.rigPlayHarness.liveFrameNullIdentity(true));
  expect(planted.some(row => row.expected === 'timeline-null' && row.actual === 'no-attachment' && row.difference !== null)).toBe(true);
  console.log('LIVE_FRAME_NULL_IDENTITY', JSON.stringify({ clean, planted }));
});
