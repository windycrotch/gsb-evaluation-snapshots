'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('./helpers/worker-runtime.cjs');

// 换方案探索合约：确定性、可复现、签名不同、物品不丢失不重复、失败有明确原因。
test('exploreAlternative returns a validated, distinct layout and is reproducible from the same seed', async () => {
    const { Item, Packer, jobs } = runtime();
    const make = () => Array.from({ length: 6 }, (_, i) => new Item(String(i), 'Cube', 2, 2, 2));
    const bin = [8, 8, 8];
    const initial = await jobs.run(make(), bin);
    const excluded = Packer.layoutSignature(initial.items);

    const first = await jobs.exploreAlternative(make(), bin, { seed: 41, excludeSignatures: [excluded] });
    const second = await jobs.exploreAlternative(make(), bin, { seed: 41, excludeSignatures: [excluded] });

    assert.equal(first.success, true);
    assert.equal(first.reason, null);
    assert.equal(first.seed, 41);
    assert.ok(first.trialsRun >= 1);
    // 合约 1：通过 validatePackingResult（含支撑检查）
    assert.equal(Packer.validatePackingResult(first.items, ...bin, true, 0.5).valid, true);
    // 合约 2：签名与排除签名不同
    assert.notEqual(Packer.layoutSignature(first.items), excluded);
    // 合约 3：物品不丢失、不重复
    const allIds = [...first.items, ...first.unpacked].map(item => item.id);
    assert.equal(allIds.length, 6);
    assert.equal(new Set(allIds).size, 6);
    // 合约 4：相同种子与相同输入逐坐标一致
    assert.equal(Packer.layoutSignature(first.items), Packer.layoutSignature(second.items));
    assert.deepEqual(
        first.items.map(item => [item.id, item.x, item.y, item.z, item.rotationType]),
        second.items.map(item => [item.id, item.x, item.y, item.z, item.rotationType])
    );
});

test('a unique exact-fit layout yields NO_DISTINCT_LAYOUT instead of a duplicate', async () => {
    const { Item, Packer, jobs } = runtime();
    const items = [new Item('one', 'One', 4, 4, 4)];
    const bin = [4, 4, 4];
    const initial = await jobs.run(items, bin);
    const failure = await jobs.exploreAlternative(items, bin, {
        seed: 23, excludeSignatures: [Packer.layoutSignature(initial.items)]
    });
    assert.equal(failure.success, false);
    assert.equal(failure.reason, Packer.EXPLORE_FAILURE.NO_DISTINCT_LAYOUT);
    assert.deepEqual(failure.items, []);
    assert.deepEqual(failure.unpacked, []);
});

test('oversized cargo reports NO_FIT_ITEMS without starting a layout search', async () => {
    const { Item, Packer, jobs } = runtime();
    const items = [new Item('huge', 'Huge', 5, 5, 5), new Item('small', 'Small', 1, 1, 1)];
    const failure = await jobs.exploreAlternative([items[0]], [4, 4, 4], { seed: 1, excludeSignatures: [] });
    assert.equal(failure.success, false);
    assert.equal(failure.reason, Packer.EXPLORE_FAILURE.NO_FIT_ITEMS);
    // 混合清单中超尺寸物品进入未装，可装物品仍能产出合法方案
    const ok = await jobs.exploreAlternative(items, [4, 4, 4], { seed: 1, excludeSignatures: [] });
    assert.equal(ok.success, true);
    assert.equal(ok.items.length, 1);
    assert.equal(ok.unpacked.length, 1);
    assert.equal(ok.unpacked[0].id, 'huge');
});

test('an exhausted time budget returns TIME_BUDGET_EXCEEDED and never an illegal layout', () => {
    const { Item, Packer } = require('../packer.js');
    const items = [
        new Item('a', 'A', 9, 7, 5), new Item('b', 'B', 8, 6, 4), new Item('c', 'C', 7, 5, 3),
        new Item('d', 'D', 6, 4, 2), new Item('e', 'E', 5, 3, 2)
    ];
    const failure = new Packer(20, 20, 20).exploreAlternative(items, {
        seed: 77, maxTrials: 12, timeBudgetMs: -100, excludeSignatures: []
    });
    assert.equal(failure.success, false);
    assert.equal(failure.reason, Packer.EXPLORE_FAILURE.TIME_BUDGET_EXCEEDED);
    assert.equal(failure.trialsRun, 0);
    assert.deepEqual(failure.items, []);
});

test('engine exploreAlternative never mutates its input and accepts legacy single-signature option', () => {
    const { Item, Packer } = require('../packer.js');
    const items = [
        new Item('a', 'A', 9, 7, 5), new Item('b', 'B', 8, 6, 4), new Item('c', 'C', 7, 5, 3)
    ];
    const snapshot = items.map(item => [item.x, item.y, item.z, item.rotationType, item.rw, item.rh, item.rd]);
    const packer = new Packer(20, 20, 20);
    const first = packer.exploreAlternative(items, { seed: 7, maxTrials: 8 });
    assert.equal(first.success, true);
    const again = packer.exploreAlternative(items, {
        seed: 7, maxTrials: 8, excludeSignature: first.signature
    });
    // 唯一候选被排除后要么失败，要么给出不同签名，绝不返回相同布局
    assert.ok(again.success === false || again.signature !== first.signature);
    assert.deepEqual(
        items.map(item => [item.x, item.y, item.z, item.rotationType, item.rw, item.rh, item.rd]),
        snapshot
    );
});

test('every returned candidate keeps full cargo accounting across packed and unpacked sets', async () => {
    const { Item, Packer, jobs } = runtime();
    // 混合尺寸 + 部分装载空间：既有未装货物，也存在多种不同摆法
    const items = [];
    for (let i = 0; i < 10; i++) items.push(new Item('c' + i, 'Cube', 2, 2, 2));
    for (let i = 0; i < 4; i++) items.push(new Item('b' + i, 'Box', 3, 2, 1));
    const bin = [6, 6, 6];
    const initial = await jobs.run(items, bin);
    const result = await jobs.exploreAlternative(items, bin, {
        seed: 11, excludeSignatures: [Packer.layoutSignature(initial.items)]
    });
    assert.equal(result.success, true);
    assert.equal(result.items.length + result.unpacked.length, items.length);
    const ids = new Set();
    for (const item of [...result.items, ...result.unpacked]) {
        assert.equal(ids.has(item.id), false);
        ids.add(item.id);
    }
    assert.equal(ids.size, items.length);
    assert.equal(Packer.validatePackingResult(result.items, ...bin).valid, true);
    assert.notEqual(Packer.layoutSignature(result.items), Packer.layoutSignature(initial.items));
});

test('capacity-bound identical cubes honestly report NO_DISTINCT_LAYOUT rather than fake variation', async () => {
    const { Item, Packer, jobs } = runtime();
    // 4x4x4 容器装 2x2x2 立方体，网格位置被几何完全锁死，只有一种布局
    const items = Array.from({ length: 12 }, (_, i) => new Item('c' + i, 'Cube', 2, 2, 2));
    const bin = [4, 4, 4];
    const initial = await jobs.run(items, bin);
    const result = await jobs.exploreAlternative(items, bin, {
        seed: 11, maxTrials: 16, excludeSignatures: [Packer.layoutSignature(initial.items)]
    });
    assert.equal(result.success, false);
    assert.equal(result.reason, Packer.EXPLORE_FAILURE.NO_DISTINCT_LAYOUT);
    assert.deepEqual(result.items, []);
});

test('aborting an exploration rejects with AbortError and leaves no partial layout', async () => {
    const { Item, jobs } = runtime();
    const controller = new AbortController();
    controller.abort();
    const items = Array.from({ length: 10 }, (_, i) => new Item('c' + i, 'Cube', 2, 2, 2));
    await assert.rejects(
        jobs.exploreAlternative(items, [8, 8, 8], { seed: 3 }, { signal: controller.signal }),
        { name: 'AbortError' }
    );
});
