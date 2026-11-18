import assert from 'node:assert/strict';
import { optimizeProductionSchedule } from '../src/production-optimizer.mjs';

const item = (itemId, quantity) => ({ itemId, quantity });
const machine = (id, availableAt = 0) => ({ id, availableAt });
const recipe = (id, durationSeconds, machineIds, inputs = [], outputQuantity = 1) =>
  ({ id, itemId: id, outputQuantity, durationSeconds, machineIds, inputs });
const order = (id, requirements, extra = {}) => ({ id, requirements, ...extra });
const snapshot = overrides => ({ snapshotTime: 1000, complete: true, inventory: [], orders: [], recipes: [], machines: [], incoming: [], ...overrides });
const solve = (input, limits) => optimizeProductionSchedule(snapshot(input), { maxNodes: 100000, maxMilliseconds: 5000, ...limits });
let passed = 0;
function test(name, work) { work(); passed++; console.log('通过：' + name); }

// Independent integer-time enumeration for small regression fixtures. It tries
// every production recipe, including extra work, without BOM pruning or bounds.
function referenceCompletion(input, horizon, prioritized = false) {
  const levels = [...new Set(input.orders.map(row => row.priority ?? 0))].sort((a, b) => a - b);
  let best = null;
  const better = candidate => {
    if (best === null) return true;
    for (let index = 0; index < candidate.length; index++) {
      if (candidate[index] !== best[index]) return candidate[index] < best[index];
    }
    return false;
  };
  const ids = [...new Set([
    ...input.inventory.map(row => row.itemId),
    ...input.recipes.flatMap(row => [row.itemId, ...row.inputs.map(material => material.itemId)]),
    ...input.orders.flatMap(row => row.requirements.map(material => material.itemId)),
  ])].sort();
  const stock = Object.fromEntries(ids.map(id => [id, 0]));
  for (const row of input.inventory) stock[row.itemId] += row.quantity;
  let layer = [{ stock, held: Object.fromEntries(ids.map(id => [id, 0])),
    available: input.machines.map(row => row.availableAt), events: structuredClone(input.incoming),
    done: input.orders.map(() => false), completed: input.orders.map(() => null) }];
  for (let time = 0; time <= horizon; time++) {
    const queue = [], seen = new Set();
    const missedDeadline = state => input.orders.some((row, index) => !state.done[index] && time > (row.deadline ?? Infinity));
    const add = state => {
      const key = JSON.stringify([ids.map(id => state.stock[id]), ids.map(id => state.held[id]),
        state.available.map(ready => Math.max(time, ready)), state.done, prioritized ? state.completed : null,
        state.events.map(event => [event.itemId, event.quantity, event.readyAt]).sort()]);
      if (seen.has(key)) return;
      seen.add(key);
      queue.push(state);
    };
    for (const state of layer) {
      for (const event of state.events) if (event.readyAt === time) state.stock[event.itemId] += event.quantity;
      state.events = state.events.filter(event => event.readyAt > time);
      add(state);
    }
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const state = queue[cursor];
      if (state.done.every(Boolean)) {
        if (!prioritized) return time;
        const objective = levels.map(priority => Math.max(...input.orders.flatMap((row, index) => (row.priority ?? 0) === priority ? [state.completed[index]] : [])));
        if (better(objective)) best = objective;
        continue;
      }
      if (missedDeadline(state)) continue;
      for (const [index, request] of input.orders.entries()) {
        if (state.done[index] || !request.requirements.every(row => state.stock[row.itemId] >= row.quantity)) continue;
        const next = structuredClone(state);
        next.done[index] = true;
        next.completed[index] = time;
        for (const row of request.requirements) {
          next.stock[row.itemId] -= row.quantity;
          if (request.consumeOnCompletion === false) next.held[row.itemId] += row.quantity;
        }
        add(next);
      }
      for (const production of input.recipes) {
        if (production.enabled === false || time > (production.availableUntil ?? Infinity)) continue;
        if (!production.inputs.every(row => state.stock[row.itemId] >= row.quantity)) continue;
        const physical = state.stock[production.itemId] + state.held[production.itemId]
          + state.events.filter(event => event.itemId === production.itemId).reduce((total, event) => total + event.quantity, 0);
        const cap = input.stockCaps?.[production.itemId] ?? Infinity;
        if (input.stockCapMode === 'start-projected' ? physical >= cap : physical + production.outputQuantity > cap) continue;
        for (const [index, facility] of input.machines.entries()) {
          if (!production.machineIds.includes(facility.id) || state.available[index] > time) continue;
          const end = time + (production.durationByMachine?.[facility.id] ?? production.durationSeconds);
          if (end > (facility.availableUntil ?? Infinity)) continue;
          const next = structuredClone(state);
          for (const row of production.inputs) next.stock[row.itemId] -= row.quantity;
          next.available[index] = end;
          next.events.push({ itemId: production.itemId, quantity: production.outputQuantity, readyAt: end });
          add(next);
        }
      }
    }
    layer = queue.filter(state => !missedDeadline(state) && !state.done.every(Boolean));
  }
  return best;
}

test('单厂串行任务给出已证明最优的共同齐套时刻', () => {
  const result = solve({ machines: [machine('厂')], recipes: [recipe('甲', 2, ['厂']), recipe('乙', 3, ['厂'])],
    orders: [order('订单', [item('甲', 1), item('乙', 1)])] });
  assert.equal(result.status, 'optimal');
  assert.equal(result.upperBound, 5);
  assert.equal(result.lowerBound, 5);
  assert.equal(result.timeline.length, 2);
});

test('独立工厂并行缩短共同交付时间', () => {
  const result = solve({ machines: [machine('甲厂'), machine('乙厂')],
    recipes: [recipe('甲', 2, ['甲厂']), recipe('乙', 3, ['乙厂'])],
    orders: [order('甲单', [item('甲', 1)]), order('乙单', [item('乙', 1)])] });
  assert.equal(result.status, 'optimal');
  assert.equal(result.upperBound, 3);
  assert.deepEqual(result.timeline.map(row => row.start), [0, 0]);
});

test('多产量作物按所有订单累计一次取整', () => {
  const result = solve({ inventory: [item('种子', 1)], machines: [machine('农田')],
    recipes: [recipe('小麦', 5, ['农田'], [item('种子', 1)], 5)],
    orders: [order('甲单', [item('小麦', 2)]), order('乙单', [item('小麦', 3)])] });
  assert.equal(result.status, 'optimal');
  assert.equal(result.timeline.length, 1);
  assert.equal(result.upperBound, 5);
});

test('多父节点依赖汇总后按批量展开，共享库存仅抵扣一次', () => {
  const result = solve({ inventory: [item('种子', 1)], machines: [machine('农田'), machine('食品厂')],
    recipes: [recipe('小麦', 2, ['农田'], [item('种子', 1)], 5), recipe('甲', 1, ['食品厂'], [item('小麦', 2)]),
      recipe('乙', 1, ['食品厂'], [item('小麦', 3)])],
    orders: [order('甲单', [item('甲', 1)]), order('乙单', [item('乙', 1)])] });
  assert.equal(result.status, 'optimal');
  assert.equal(result.upperBound, 4);
  assert.equal(result.timeline.filter(row => row.itemId === '小麦').length, 1);
  const missing = solve({ inventory: [item('甲', 1)], orders: [order('甲单', [item('甲', 1)]), order('乙单', [item('甲', 1)])] });
  assert.equal(missing.status, 'infeasible');
});

test('已有加工已扣料，等待到货即可满足订单', () => {
  const result = solve({ machines: [machine('厂', 10)], incoming: [{ itemId: '甲', quantity: 1, readyAt: 10 }],
    recipes: [recipe('甲', 5, ['厂'], [item('木材', 10)])], orders: [order('订单', [item('甲', 1)])] });
  assert.equal(result.status, 'optimal');
  assert.equal(result.upperBound, 10);
  assert.deepEqual(result.timeline, []);
});

test('允许提前补产，超越已有队列的到货时间', () => {
  const result = solve({ machines: [machine('旧厂', 100), machine('新厂')],
    incoming: [{ itemId: '甲', quantity: 1, readyAt: 100 }],
    recipes: [recipe('甲', 3, ['旧厂', '新厂'])], orders: [order('订单', [item('甲', 1)])] });
  assert.equal(result.status, 'optimal');
  assert.equal(result.upperBound, 3);
  assert.equal(result.timeline[0].machineId, '新厂');
});

test('同厂回流与跨厂依赖按真实加工顺序排程', () => {
  const result = solve({ machines: [machine('甲厂'), machine('乙厂')],
    recipes: [recipe('甲', 2, ['甲厂']), recipe('乙', 3, ['乙厂'], [item('甲', 1)]), recipe('丙', 4, ['甲厂'], [item('乙', 1)])],
    orders: [order('订单', [item('丙', 1)])] });
  assert.equal(result.status, 'optimal');
  assert.equal(result.upperBound, 9);
  assert.deepEqual(result.timeline.map(row => [row.itemId, row.start]), [['甲', 0], ['乙', 2], ['丙', 5]]);
});

test('订单依次交付释放仓容，总需求可以大于库存上限', () => {
  const result = solve({ machines: [machine('厂')], recipes: [recipe('甲', 1, ['厂'])], stockCaps: { 甲: 2 },
    orders: [order('第一单', [item('甲', 2)]), order('第二单', [item('甲', 2)])] });
  assert.equal(result.status, 'optimal');
  assert.equal(result.upperBound, 4);
  assert.deepEqual(result.orderCompletions.map(row => row.completedAt), [2, 4]);
});

test('保留待交订单占用物理仓容，共享库存不会重复使用', () => {
  const result = solve({ machines: [machine('厂')], recipes: [recipe('甲', 1, ['厂'])], stockCaps: { 甲: 2 },
    orders: [order('第一单', [item('甲', 2)], { consumeOnCompletion: false }),
      order('第二单', [item('甲', 2)], { consumeOnCompletion: false })] });
  assert.equal(result.status, 'infeasible');
  assert(result.blockedOrders.some(row => row.reason.includes('保留')));
  const mixed = solve({ machines: [machine('厂')], recipes: [recipe('甲', 1, ['厂'])], stockCaps: { 甲: 2 },
    orders: [order('保留单', [item('甲', 2)], { consumeOnCompletion: false }), order('消耗单', [item('甲', 2)])] });
  assert.equal(mixed.status, 'optimal');
  assert.deepEqual(mixed.orderCompletions.map(row => row.orderId), ['消耗单', '保留单']);
});

test('已有未来产出也计入排产仓容', () => {
  const result = solve({ machines: [machine('旧厂', 100), machine('新厂')], stockCaps: { 甲: 1 },
    incoming: [{ itemId: '甲', quantity: 1, readyAt: 100 }], recipes: [recipe('甲', 3, ['新厂'])],
    orders: [order('订单', [item('甲', 1)])] });
  assert.equal(result.status, 'optimal');
  assert.equal(result.upperBound, 100);
  assert.deepEqual(result.timeline, []);
});

test('整单交付的分支不会抢占能缩短总工期的原料', () => {
  const result = solve({ inventory: [item('甲', 1)], machines: [machine('厂')],
    incoming: [{ itemId: '甲', quantity: 1, readyAt: 10 }], recipes: [recipe('乙', 2, ['厂'], [item('甲', 1)])],
    orders: [order('甲单', [item('甲', 1)]), order('乙单', [item('乙', 1)])] });
  assert.equal(result.status, 'optimal');
  assert.equal(result.upperBound, 10);
  assert.equal(result.timeline[0].start, 0);
});

test('已知未解锁与未知时长分别报告不可行及数据不完整', () => {
  const input = { machines: [machine('厂')], recipes: [{ ...recipe('甲', 5, ['厂']), enabled: false, blockedReason: '需工厂10级' }],
    orders: [order('订单', [item('甲', 1)])] };
  const locked = solve(input);
  assert.equal(locked.status, 'infeasible');
  assert.equal(locked.blockedOrders[0].reason, '需工厂10级');
  input.recipes[0] = { ...recipe('甲', 5, ['厂']), durationSeconds: null };
  assert.equal(solve(input).status, 'incomplete');
  assert.equal(solve({ ...input, complete: false, missingReads: ['库存读取失败'] }).status, 'incomplete');
});

test('节点预算耗尽只报告已知可行方案，不冒称最优', () => {
  const result = solve({ machines: [machine('甲厂'), machine('乙厂')],
    recipes: [recipe('甲', 2, ['甲厂']), recipe('乙', 3, ['乙厂'], [item('甲', 1)])],
    orders: [order('订单', [item('乙', 1)])] }, { maxNodes: 1 });
  assert.equal(result.status, 'best-known');
  assert.equal(result.lowerBound, 3);
  assert.equal(result.upperBound, 5);
  assert.equal(result.stats.limitReached, true);
});

test('工厂排列顺序不改变已证明的共同最优时间', () => {
  const input = { inventory: [item('原料', 2)], machines: [machine('甲厂'), machine('乙厂')],
    recipes: [recipe('甲', 4, ['甲厂'], [item('原料', 1)]), recipe('乙', 2, ['乙厂'], [item('原料', 1)])],
    orders: [order('订单', [item('甲', 1), item('乙', 1)])] };
  const first = solve(input);
  input.machines.reverse(); input.recipes.reverse();
  const second = solve(input);
  assert.equal(first.status, 'optimal'); assert.equal(second.status, 'optimal');
  assert.equal(first.upperBound, second.upperBound);
});

test('活动与临时加工线期限限制新任务', () => {
  const result = solve({ machines: [{ ...machine('厂', 3), availableUntil: 5 }],
    recipes: [{ ...recipe('甲', 3, ['厂']), availableUntil: 4 }], orders: [order('订单', [item('甲', 1)])] });
  assert.equal(result.status, 'infeasible');
  const expiredRecipe = solve({ machines: [machine('厂', 5)], recipes: [{ ...recipe('甲', 1, ['厂']), availableUntil: 4 }],
    orders: [order('订单', [item('甲', 1)])] });
  assert.equal(expiredRecipe.status, 'infeasible');
});

test('循环依赖与多配方保持未验证状态', () => {
  const cycle = solve({ machines: [machine('厂')], recipes: [recipe('甲', 1, ['厂'], [item('乙', 1)]), recipe('乙', 1, ['厂'], [item('甲', 1)])],
    orders: [order('订单', [item('甲', 1)])] });
  assert.equal(cycle.status, 'incomplete');
  const duplicate = solve({ machines: [machine('厂')], recipes: [recipe('甲', 1, ['厂']), { ...recipe('甲', 2, ['厂']), id: '另一配方' }],
    orders: [order('订单', [item('甲', 1)])] });
  assert.equal(duplicate.status, 'incomplete');
});

test('求解不修改调用方的输入快照', () => {
  const input = snapshot({ inventory: [item('甲', 1)], orders: [order('订单', [item('甲', 1)])] });
  const before = structuredClone(input);
  const result = solve(input);
  assert.deepEqual(input, before);
  assert.equal(result.status, 'optimal');
  assert.equal(result.upperBound, 0);
});

test('同配方的设施独立时长用于排程及最优下界', () => {
  const input = { machines: [machine('慢厂'), machine('快厂')], recipes: [
    { ...recipe('甲', 20, ['慢厂', '快厂']), durationByMachine: { 快厂: 2 } }
  ], orders: [order('订单', [item('甲', 2)])] };
  const result = solve(input);
  assert.equal(result.status, 'optimal');
  assert.equal(result.lowerBound, 4);
  assert.equal(result.upperBound, 4);
  assert.deepEqual(result.timeline.map(row => [row.machineId, row.start, row.end]), [['快厂', 0, 2], ['快厂', 2, 4]]);
  const mappedOnly = solve({ ...input, recipes: [{ ...input.recipes[0], durationSeconds: null, durationByMachine: { 慢厂: 20, 快厂: 2 } }] });
  assert.equal(mappedOnly.status, 'optimal');
  assert.equal(mappedOnly.upperBound, 4);
});

test('不同机器时长与开放期限一同约束合法下界', () => {
  const result = solve({ machines: [{ ...machine('快厂'), availableUntil: 1 }, machine('慢厂')], recipes: [
    { ...recipe('甲', 8, ['快厂', '慢厂']), durationByMachine: { 快厂: 2 } }
  ], orders: [order('订单', [item('甲', 1)])] }, { maxNodes: 1 });
  assert.equal(result.status, 'optimal');
  assert.equal(result.lowerBound, 8);
  assert.equal(result.upperBound, 8);
  assert.equal(result.timeline[0].machineId, '慢厂');
});

test('缺失或无效的机器耗时不能形成最优性结论', () => {
  const input = { machines: [machine('甲厂'), machine('乙厂')], recipes: [
    { ...recipe('甲', null, ['甲厂', '乙厂']), durationByMachine: { 甲厂: 2 } }
  ], orders: [order('订单', [item('甲', 1)])] };
  assert.equal(solve(input).status, 'incomplete');
  input.recipes[0].durationByMachine.乙厂 = 0;
  assert.equal(solve(input).status, 'incomplete');
  const incoming = solve({ machines: [machine('厂')], recipes: [recipe('甲', null, ['厂'])],
    incoming: [{ itemId: '甲', quantity: 1, readyAt: 100 }], orders: [order('订单', [item('甲', 1)])] });
  assert.equal(incoming.status, 'incomplete');
});

test('过期订单与无法按时完成的订单不报告最优', () => {
  const input = { machines: [machine('厂')], recipes: [recipe('甲', 5, ['厂'])], orders: [order('订单', [item('甲', 1)], { deadline: 4 })] };
  const late = solve(input);
  assert.equal(late.status, 'infeasible');
  assert.equal(late.deadlinesEnforced, true);
  assert.deepEqual(late.orderCompletions, []);
  input.orders[0].deadline = 5;
  assert.equal(solve(input).status, 'optimal');
  const expired = solve({ inventory: [item('甲', 1)], orders: [order('订单', [item('甲', 1)], { deadline: -1 })] });
  assert.equal(expired.status, 'infeasible');
  assert.equal(expired.blockedOrders[0].orderId, '订单');
  assert.equal(solve({ orders: [order('订单', [], { deadline: '5' })] }).status, 'incomplete');
});

test('联合排程保留提前交付的订单截止约束', () => {
  const result = solve({ machines: [machine('厂')], recipes: [recipe('甲', 4, ['厂']), recipe('乙', 2, ['厂'])],
    orders: [order('晚单', [item('乙', 1)]), order('急单', [item('甲', 1)], { deadline: 4 })] });
  assert.equal(result.status, 'optimal');
  assert.equal(result.upperBound, 6);
  assert.deepEqual(result.timeline.map(row => row.itemId), ['甲', '乙']);
  assert.equal(result.orderCompletions.find(row => row.orderId === '急单').completedAt, 4);
});

test('净BOM批次数不能阻止额外下游生产腾出仓容', () => {
  const input = { inventory: [item('甲', 4)], machines: [machine('厂')], stockCaps: { 甲: 5 },
    recipes: [recipe('甲', 1, ['厂'], [], 3), recipe('乙', 1, ['厂'], [item('甲', 1)])],
    orders: [order('甲单', [item('甲', 5)]), order('乙单', [item('乙', 1)])] };
  const result = solve(input);
  assert.equal(result.status, 'optimal');
  assert.equal(result.upperBound, 3);
  assert.equal(result.timeline.filter(row => row.itemId === '乙').length, 2);
  input.orders.pop();
  const outsideBom = solve(input);
  assert.equal(outsideBom.status, 'optimal');
  assert.equal(outsideBom.upperBound, 3);
  assert.equal(outsideBom.timeline.filter(row => row.itemId === '乙').length, 2);
});

test('腾仓的额外原料也纳入依赖闭包，预算不足保持未验证', () => {
  const input = { inventory: [item('甲', 4)], machines: [machine('厂')], stockCaps: { 甲: 5 },
    recipes: [recipe('甲', 1, ['厂'], [], 3), recipe('乙', 1, ['厂'], [item('甲', 1), item('丙', 1)]), recipe('丙', 1, ['厂'])],
    orders: [order('甲单', [item('甲', 5)])] };
  const result = solve(input);
  assert.equal(result.status, 'optimal');
  assert.equal(result.upperBound, 5);
  assert.equal(result.timeline.filter(row => row.itemId === '丙').length, 2);
  const bounded = solve(input, { maxNodes: 1 });
  assert.equal(bounded.status, 'incomplete');
  assert.equal(bounded.stats.limitReached, true);
});

test('已有库存和在途超过上限仍可齐套，保留库存继续占仓', () => {
  const stocked = solve({ inventory: [item('甲', 6)], stockCaps: { 甲: 5 },
    orders: [order('订单', [item('甲', 6)], { consumeOnCompletion: false })] });
  assert.equal(stocked.status, 'optimal');
  assert.equal(stocked.upperBound, 0);
  const incoming = solve({ inventory: [item('甲', 2)], stockCaps: { 甲: 5 },
    incoming: [{ itemId: '甲', quantity: 4, readyAt: 3 }], orders: [order('订单', [item('甲', 6)])] });
  assert.equal(incoming.status, 'optimal');
  assert.equal(incoming.upperBound, 3);
});

test('开工前在途仓容模式允许末批跨上限并阻止继续开工', () => {
  const input = { inventory: [item('甲', 4)], machines: [machine('厂')], stockCaps: { 甲: 5 }, stockCapMode: 'start-projected',
    recipes: [recipe('甲', 1, ['厂'], [], 3)], orders: [order('订单', [item('甲', 7)], { consumeOnCompletion: false })] };
  const result = solve(input);
  assert.equal(result.status, 'optimal');
  assert.equal(result.upperBound, 1);
  assert.equal(result.timeline.length, 1);
  input.orders[0].requirements[0].quantity = 8;
  assert.equal(solve(input).status, 'infeasible');
  input.orders = [order('订单', [item('甲', 1)])];
  input.inventory = [];
  input.incoming = [{ itemId: '甲', quantity: 5, readyAt: 10 }];
  assert.equal(solve(input).upperBound, 10);
});

test('大订单下界按机器产能计算，单次下界计算不展开亿条任务', () => {
  const result = solve({ machines: [machine('厂')], recipes: [recipe('甲', 1, ['厂'])],
    orders: [order('订单', [item('甲', 100000000)])] }, { maxNodes: 1, maxMilliseconds: 10 });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.lowerBound, 100000000);
  assert.equal(result.stats.limitReached, true);
});

test('数量聚合及BOM乘法超出安全整数范围保持数据未验证', () => {
  const combined = solve({ inventory: [item('甲', Number.MAX_SAFE_INTEGER), item('甲', 1)], orders: [order('订单', [item('甲', 1)])] });
  assert.equal(combined.status, 'incomplete');
  const expanded = solve({ machines: [machine('厂')], recipes: [recipe('甲', 1, ['厂'], [item('原料', Number.MAX_SAFE_INTEGER)])],
    orders: [order('订单', [item('甲', 2)])] });
  assert.equal(expanded.status, 'incomplete');
});

test('128个固定种子实例与独立逐秒完整枚举的最短时间一致', () => {
  let seed = 104729;
  const random = maximum => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % maximum;
  };
  for (let index = 0; index < 128; index++) {
    const input = snapshot({ inventory: [item('甲', random(4)), item('原料', 2 + random(3))],
      machines: [machine('甲厂', random(2)), machine('乙厂', random(2))],
      incoming: random(3) === 0 ? [{ itemId: '甲', quantity: 1, readyAt: 2 + random(3) }] : [],
      stockCaps: { 甲: 2 + random(3), 乙: 2 }, stockCapMode: index % 2 ? 'start-projected' : 'reserved-output',
      recipes: [recipe('甲', 1 + random(2), ['甲厂', '乙厂'], [item('原料', 1)], 1 + random(2)),
        recipe('乙', 1 + random(2), ['甲厂'], [item('甲', 1)]), recipe('丙', 1, ['乙厂'], [item('甲', 1)])],
      orders: [order('甲单', [item('甲', 1 + random(3))], { consumeOnCompletion: random(3) !== 0 }),
        order('乙单', [item('乙', 1)], { deadline: 3 + random(6) })] });
    input.recipes[0].durationByMachine = { 乙厂: 1 + random(3) };
    if (index % 4 === 0) input.machines[1].availableUntil = 4 + random(4);
    const expected = referenceCompletion(input, 9);
    const actual = solve(input, { maxNodes: 300000, maxMilliseconds: 10000 });
    const context = JSON.stringify({ index, expected, actual, input });
    if (expected !== null) {
      assert.equal(actual.status, 'optimal', context);
      assert.equal(actual.upperBound, expected, context);
    } else {
      assert(actual.upperBound === null || actual.upperBound > 9, context);
    }
  }
});

test('高优先级最早齐套先于整体工期，输出逐层最优性界限', () => {
  const input = { machines: [machine('共用厂'), machine('下游厂')],
    recipes: [recipe('高级成品', 5, ['共用厂']), recipe('低级原件', 1, ['共用厂']), recipe('低级成品', 20, ['下游厂'], [item('低级原件', 1)])],
    orders: [order('高级', [item('高级成品', 1)], { priority: 0 }), order('低级', [item('低级成品', 1)], { priority: 2 })] };
  const result = solve(input);
  assert.equal(result.status, 'optimal');
  assert.equal(result.objective, 'priority-makespan');
  assert.deepEqual(result.objectiveUpperBound, [5, 26]);
  assert.deepEqual(result.objectiveLowerBound, [5, 26]);
  assert.equal(result.upperBound, 26);
  assert.equal(result.lowerBound, 20);
  assert.deepEqual(result.priorityBounds, [{ priority: 0, lowerBound: 5, upperBound: 5 }, { priority: 2, lowerBound: 26, upperBound: 26 }]);
  const unrestricted = solve({ ...input, orders: input.orders.map(row => ({ ...row, priority: 0 })) });
  assert.equal(unrestricted.upperBound, 21);
  assert.equal(unrestricted.objective, 'makespan');
  const bounded = solve(input, { maxNodes: 1 });
  assert.equal(bounded.status, 'best-known');
  assert.deepEqual(bounded.objectiveLowerBound, [5, 20]);
  assert.deepEqual(bounded.objectiveUpperBound, [5, 26]);
});

test('高优先需求递归提升上游，共用工厂互斥且下游继续并行', () => {
  const result = solve({ inventory: [item('原料', 2)], machines: [machine('共用厂'), machine('装配厂')],
    recipes: [recipe('零件', 4, ['共用厂'], [item('原料', 1)]), recipe('高级成品', 5, ['装配厂'], [item('零件', 1)]),
      recipe('低级成品', 1, ['共用厂'], [item('原料', 1)])],
    orders: [order('低级', [item('低级成品', 1)], { priority: 5 }), order('高级', [item('高级成品', 1)], { priority: 1 })] });
  assert.equal(result.status, 'optimal');
  assert.deepEqual(result.objectiveUpperBound, [9, 5]);
  assert.equal(result.timeline.find(job => job.itemId === '零件').priority, 1);
  assert.equal(result.timeline.find(job => job.itemId === '低级成品').start, 4);
  assert.equal(result.timeline.find(job => job.itemId === '高级成品').start, 4);
});

test('不同生产位的低优先级任务与高级需求同时开工', () => {
  const result = solve({ machines: [machine('甲厂'), machine('乙厂')], recipes: [recipe('甲', 3, ['甲厂']), recipe('乙', 8, ['乙厂'])],
    orders: [order('高', [item('甲', 1)], { priority: 0 }), order('低', [item('乙', 1)], { priority: 1 })] });
  assert.equal(result.status, 'optimal');
  assert.deepEqual(result.objectiveUpperBound, [3, 8]);
  assert.deepEqual(result.timeline.map(job => job.start), [0, 0]);
});

test('共用设备的短任务填等待窗口，长任务等待高级依赖到齐', () => {
  const input = { machines: [machine('厂')], incoming: [{ itemId: '原料', quantity: 1, readyAt: 5 }],
    recipes: [recipe('高级成品', 2, ['厂'], [item('原料', 1)]), recipe('低级成品', 3, ['厂'])],
    orders: [order('高', [item('高级成品', 1)], { priority: 0 }), order('低', [item('低级成品', 1)], { priority: 1 })] };
  const short = solve(input);
  assert.deepEqual(short.objectiveUpperBound, [7, 3]);
  assert.equal(short.timeline.find(job => job.itemId === '低级成品').start, 0);
  input.recipes[1].durationSeconds = 6;
  const long = solve(input);
  assert.deepEqual(long.objectiveUpperBound, [7, 13]);
  assert.equal(long.timeline.find(job => job.itemId === '低级成品').start, 7);
});

test('高级需求已由在途覆盖后，其余上游批次恢复低优先级', () => {
  const result = solve({ inventory: [item('原料', 1)], machines: [machine('原料厂'), machine('装配厂', 10)],
    incoming: [{ itemId: '高级成品', quantity: 1, readyAt: 10 }],
    recipes: [recipe('零件', 2, ['原料厂'], [item('原料', 1)]), recipe('高级成品', 4, ['装配厂'], [item('零件', 1)])],
    orders: [order('高', [item('高级成品', 1)], { priority: 0 }), order('低', [item('零件', 1)], { priority: 3 })] });
  assert.equal(result.status, 'optimal');
  assert.deepEqual(result.objectiveUpperBound, [10, 2]);
  assert.equal(result.timeline[0].priority, 3);
});

test('提前替代晚到在途的实际交付批次继承高级需求，早到在途继续覆盖高级', () => {
  const input = { machines: [machine('厂')], recipes: [recipe('甲', 5, ['厂'])],
    incoming: [{ itemId: '甲', quantity: 1, readyAt: 100 }],
    orders: [order('高', [item('甲', 1)], { priority: 0 }), order('低', [item('甲', 1)], { priority: 1 })] };
  const late = solve(input);
  assert.equal(late.status, 'optimal');
  assert.deepEqual(late.objectiveUpperBound, [5, 10]);
  assert.deepEqual(late.timeline.map(job => job.priority), [0, 1]);
  assert(late.timeline.every(job => !Object.hasOwn(job, 'sequence')));
  assert(late.orderCompletions.every(order => !Object.hasOwn(order, 'sequence')));
  input.incoming[0].readyAt = 1;
  const early = solve(input);
  assert.equal(early.status, 'optimal');
  assert.deepEqual(early.objectiveUpperBound, [1, 5]);
  assert.deepEqual(early.timeline.map(job => job.priority), [1]);
});

test('共享批次按高优先需求先分配，余量供后续需求且无需重复投产', () => {
  const result = solve({ inventory: [item('种子', 1)], machines: [machine('农田')],
    recipes: [recipe('作物', 3, ['农田'], [item('种子', 1)], 5)],
    orders: [order('高', [item('作物', 2)], { priority: 0 }), order('低', [item('作物', 3)], { priority: 1 })] });
  assert.equal(result.status, 'optimal');
  assert.deepEqual(result.objectiveUpperBound, [3, 3]);
  assert.equal(result.timeline.length, 1);
  assert.equal(result.timeline[0].priority, 0);
});

test('共享原料的临时使用可由并行补料恢复且不延迟高级需求', () => {
  const result = solve({ inventory: [item('原料', 1), item('矿石', 1)],
    machines: [machine('高级厂'), machine('低级厂'), machine('原料厂')],
    incoming: [{ itemId: '门件', quantity: 1, readyAt: 5 }],
    recipes: [recipe('原料', 3, ['原料厂'], [item('矿石', 1)]), recipe('高级成品', 1, ['高级厂'], [item('原料', 1), item('门件', 1)]),
      recipe('低级成品', 1, ['低级厂'], [item('原料', 1)])],
    orders: [order('高', [item('高级成品', 1)], { priority: 0 }), order('低', [item('低级成品', 1)], { priority: 1 })] });
  assert.equal(result.status, 'optimal');
  assert.deepEqual(result.objectiveUpperBound, [6, 1]);
});

test('非法优先级保持数据待确认，同级兼容总工期目标', () => {
  for (const priority of [-1, 0.5, '0', Infinity]) {
    assert.equal(solve({ inventory: [item('甲', 1)], orders: [order('订单', [item('甲', 1)], { priority })] }).status, 'incomplete');
  }
  const result = solve({ inventory: [item('甲', 1)], orders: [order('订单', [item('甲', 1)], { priority: 9 })] });
  assert.equal(result.objective, 'makespan');
  assert.deepEqual(result.priorityBounds, [{ priority: 9, lowerBound: 0, upperBound: 0 }]);
});

test('48个多优先级实例与独立逐秒枚举的词典序最优结果一致', () => {
  let seed = 8191;
  const random = maximum => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % maximum;
  };
  for (let index = 0; index < 48; index++) {
    const input = snapshot({ inventory: [item('甲', random(3)), item('原料', 2 + random(2))],
      machines: [machine('甲厂', random(2)), machine('乙厂', random(2))],
      incoming: random(3) === 0 ? [{ itemId: '甲', quantity: 1, readyAt: 2 + random(3) }] : [],
      stockCaps: { 甲: 2 + random(2), 乙: 2 }, stockCapMode: index % 2 ? 'start-projected' : 'reserved-output',
      recipes: [recipe('甲', 1 + random(2), ['甲厂', '乙厂'], [item('原料', 1)], 1 + random(2)),
        recipe('乙', 1 + random(2), ['甲厂'], [item('甲', 1)]), recipe('丙', 1, ['乙厂'], [item('甲', 1)])],
      orders: [order('甲单', [item('甲', 1 + random(2))], { priority: index % 2, deadline: 8, consumeOnCompletion: random(3) !== 0 }),
        order('乙单', [item('乙', 1)], { priority: (index + 1) % 2, deadline: 8 })] });
    input.recipes[0].durationByMachine = { 乙厂: 1 + random(3) };
    if (index % 4 === 0) input.machines[1].availableUntil = 4 + random(4);
    const expected = referenceCompletion(input, 8, true);
    const actual = solve(input, { maxNodes: 300000, maxMilliseconds: 10000 });
    const context = JSON.stringify({ index, expected, actual, input });
    assert.equal(actual.status, expected === null ? 'infeasible' : 'optimal', context);
    assert.deepEqual(actual.objectiveUpperBound, expected, context);
  }
});

console.log('订单联合排程专项 ' + passed + '/' + passed + ' 通过');
