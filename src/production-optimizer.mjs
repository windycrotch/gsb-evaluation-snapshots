// Exact, bounded scheduling for a fixed production snapshot. Existing work is
// represented by machine availability and incoming outputs whose costs are paid.
const DEFAULT_LIMITS = { maxNodes: 20000, maxMilliseconds: 100 };
const EPSILON = 1e-8;
const clock = () => performance.now();
const sum = values => values.reduce((total, value) => total + value, 0);
const positiveQuantity = value => Number.isSafeInteger(value) && value > 0;

function quantities(rows, label, errors) {
  const result = new Map();
  if (!Array.isArray(rows)) {
    errors.push(`${label}缺少完整数量列表`);
    return result;
  }
  for (const row of rows) {
    if (typeof row?.itemId !== 'string' || !row.itemId || !Number.isSafeInteger(row.quantity) || row.quantity < 0) {
      errors.push(`${label}包含无法确认的道具或数量`);
      continue;
    }
    const total = (result.get(row.itemId) ?? 0) + row.quantity;
    if (!Number.isSafeInteger(total)) errors.push(`${label}累计数量超出可精确计算范围`);
    result.set(row.itemId, total);
  }
  return result;
}

function prepare(input) {
  const errors = [...(input.missingReads ?? [])];
  if (input.complete !== true) errors.push('生产快照尚未确认完整');
  const inventory = quantities(input.inventory, '库存', errors);
  const machineIds = new Set();
  const machines = (input.machines ?? []).map(machine => {
    if (typeof machine.id !== 'string' || !machine.id || machineIds.has(machine.id)
      || !Number.isFinite(machine.availableAt) || machine.availableAt < 0) errors.push('加工设施或可用时间不完整');
    machineIds.add(machine.id);
    if (machine.availableUntil != null && (!Number.isFinite(machine.availableUntil) || machine.availableUntil < 0)) errors.push('加工设施开放期限未确认');
    return { ...machine };
  });
  if (!Array.isArray(input.machines)) errors.push('加工设施列表未读取');
  const recipeByItem = new Map();
  const recipes = (input.recipes ?? []).map((recipe, index) => {
    if (typeof recipe.id !== 'string' || !recipe.id || typeof recipe.itemId !== 'string' || !recipe.itemId
      || !positiveQuantity(recipe.outputQuantity)) errors.push('生产配方标识或产量未确认');
    if (recipeByItem.has(recipe.itemId)) errors.push(`${recipe.itemId}存在多配方，当前模型无法确认唯一生产路径`);
    const inputs = quantities(recipe.inputs, `${recipe.itemId}配方`, errors);
    const machineIndexes = [...new Set(recipe.machineIds ?? [])].map(id => machines.findIndex(machine => machine.id === id));
    if (machineIndexes.some(value => value < 0)) errors.push(`${recipe.itemId}引用未知加工设施`);
    const overrides = recipe.durationByMachine ?? {};
    if (typeof overrides !== 'object' || Array.isArray(overrides)) errors.push(`${recipe.itemId}分设施生产时长格式未确认`);
    for (const [id, duration] of Object.entries(overrides)) {
      if (!recipe.machineIds?.includes(id) || !Number.isFinite(duration) || duration <= 0) {
        errors.push(`${recipe.itemId}的${id}设施生产时长未确认`);
      }
    }
    const durations = new Map(machineIndexes.map(machine => [machine,
      Object.hasOwn(overrides, machines[machine]?.id) ? overrides[machines[machine]?.id] : recipe.durationSeconds]));
    const durationKnown = durations.size ? [...durations.values()].every(duration => Number.isFinite(duration) && duration > 0)
      : Number.isFinite(recipe.durationSeconds) && recipe.durationSeconds > 0;
    if (recipe.availableUntil != null && (!Number.isFinite(recipe.availableUntil) || recipe.availableUntil < 0)) errors.push(`${recipe.itemId}生产开放期限未确认`);
    const normalized = { ...recipe, index, inputs, machineIndexes, durations, durationKnown,
      usable: recipe.enabled !== false && durationKnown && machineIndexes.length > 0 };
    recipeByItem.set(recipe.itemId, normalized);
    return normalized;
  });
  if (!Array.isArray(input.recipes)) errors.push('配方列表未读取');
  const incoming = (input.incoming ?? []).map((entry, index) => {
    if (typeof entry.itemId !== 'string' || !entry.itemId || !positiveQuantity(entry.quantity)
      || !Number.isFinite(entry.readyAt) || entry.readyAt < 0) errors.push('已有生产的产量或完成时间未确认');
    return { itemId: entry.itemId, quantity: entry.quantity, time: entry.readyAt, fixed: true, id: entry.id ?? `incoming-${index}` };
  });
  if (!Array.isArray(input.incoming)) errors.push('已有生产列表未读取');
  const confirmedStock = new Map(inventory);
  for (const event of incoming) {
    const total = (confirmedStock.get(event.itemId) ?? 0) + event.quantity;
    if (!Number.isSafeInteger(total)) errors.push(`${event.itemId}库存与在途总量超出可精确计算范围`);
    confirmedStock.set(event.itemId, total);
  }
  const orderIds = new Set();
  const orders = (input.orders ?? []).map(order => {
    if (typeof order.id !== 'string' || !order.id || orderIds.has(order.id)) errors.push('订单标识缺失或重复');
    orderIds.add(order.id);
    if (order.deadline != null && !Number.isFinite(order.deadline)) errors.push(`${order.id}订单截止时间未确认`);
    const priority = order.priority ?? 0;
    if (!Number.isSafeInteger(priority) || priority < 0) errors.push(`${order.id}订单优先级未确认`);
    return { ...order, requirements: quantities(order.requirements, `${order.id}订单`, errors),
      priority: Number.isSafeInteger(priority) && priority >= 0 ? priority : 0,
      consumeOnCompletion: order.consumeOnCompletion !== false };
  });
  if (!Array.isArray(input.orders)) errors.push('订单列表未读取');
  const priorityLevels = [...new Set(orders.map(order => order.priority))].sort((a, b) => a - b);
  for (const order of orders) order.priorityIndex = priorityLevels.indexOf(order.priority);
  const caps = new Map();
  const stockCapMode = input.stockCapMode ?? 'reserved-output';
  if (!['reserved-output', 'start-projected'].includes(stockCapMode)) errors.push('仓容校验方式未确认');
  for (const [id, cap] of Object.entries(input.stockCaps ?? {})) {
    if (!Number.isSafeInteger(cap) || cap < 0) errors.push(`${id}仓容未确认`);
    else caps.set(id, cap);
  }
  const orderDemand = new Map();
  for (const order of orders) for (const [id, quantity] of order.requirements) {
    const total = (orderDemand.get(id) ?? 0) + quantity;
    if (!Number.isSafeInteger(total)) errors.push(`${id}累计订单数量超出可精确计算范围`);
    orderDemand.set(id, total);
  }
  const visiting = new Set(), visited = new Set(), postorder = [];
  const visit = id => {
    if (visiting.has(id)) { errors.push(`${id}生产依赖存在循环，当前模型无法证明最优`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const material of recipeByItem.get(id)?.inputs.keys() ?? []) visit(material);
    visiting.delete(id);
    visited.add(id);
    postorder.push(id);
  };
  for (const id of orderDemand.keys()) visit(id);
  // Extra downstream production can consume capped stock and release space.
  // Include those consumers and all of their inputs, even outside order BOMs.
  let changed = true;
  while (changed) {
    changed = false;
    for (const recipe of recipes) {
      if (visited.has(recipe.itemId) || recipe.enabled === false) continue;
      if ([...recipe.inputs].some(([id, quantity]) => quantity > 0 && caps.has(id) && visited.has(id))) {
        visit(recipe.itemId);
        changed = true;
      }
    }
  }
  const hasRelevantCaps = [...visited].some(id => caps.has(id));
  for (const recipe of recipes) {
    if (visited.has(recipe.itemId) && recipe.enabled !== false && recipe.machineIndexes.length && !recipe.durationKnown) {
      errors.push(`${recipe.itemId}所需或腾仓配方的生产时长未确认`);
    }
  }
  const items = [...new Set([...inventory.keys(), ...visited, ...incoming.map(entry => entry.itemId)])].sort();
  const data = { inventory, machines, recipes, recipeByItem, incoming, orders, priorityLevels, caps, stockCapMode, orderDemand,
    topological: postorder.reverse(), items, errors };
  data.maxBatches = expandDemand(data, orderDemand, inventory, false).batches;
  if (hasRelevantCaps) for (const recipe of recipes) {
    if (visited.has(recipe.itemId)) data.maxBatches[recipe.index] = Infinity;
  }
  data.errors = [...new Set(errors)];
  return data;
}

// Aggregate parents before rounding each batch. In an uncapped model these
// counts safely limit production while ignoring arrivals preserves early
// replacement schedules. With caps the counts are a heuristic, never a limit.
function expandDemand(data, requested, available, reportBlocked) {
  const demand = new Map(requested), batches = Array(data.recipes.length).fill(0), blocked = [];
  for (const id of data.topological) {
    const shortage = Math.max(0, (demand.get(id) ?? 0) - (available.get(id) ?? 0));
    if (!shortage) continue;
    const recipe = data.recipeByItem.get(id);
    if (!recipe?.usable) {
      if (reportBlocked) blocked.push({ itemId: id, missingQuantity: shortage,
        incomplete: !!recipe && recipe.enabled !== false && !recipe.durationKnown,
        reason: recipe?.blockedReason || (recipe && !recipe.durationKnown ? '生产时长未确认'
          : recipe ? '配方未解锁或当前没有可用加工设施' : '外部原料不足，快照中没有确定到货') });
      continue;
    }
    const count = Math.ceil(shortage / recipe.outputQuantity);
    batches[recipe.index] = count;
    for (const [material, quantity] of recipe.inputs) {
      const total = (demand.get(material) ?? 0) + count * quantity;
      if (!Number.isSafeInteger(total)) data.errors.push(`${material}配方展开数量超出可精确计算范围`);
      demand.set(material, total);
    }
  }
  return { batches, blocked, demand };
}

function initialState(data) {
  const stock = new Map(data.inventory), events = [];
  for (const event of data.incoming) {
    if (event.time <= EPSILON) stock.set(event.itemId, (stock.get(event.itemId) ?? 0) + event.quantity);
    else events.push(event);
  }
  return { time: 0, stock, held: new Map(), events,
    available: data.machines.map(machine => machine.availableAt),
    started: Array(data.recipes.length).fill(0), delivered: Array(data.orders.length).fill(false),
    timeline: [], orderCompletions: [], priorityCompletions: data.priorityLevels.map(() => 0) };
}

function remainingDemand(data, state, priority = null) {
  const demand = new Map();
  for (const [index, order] of data.orders.entries()) {
    if (state.delivered[index] || priority !== null && order.priority !== priority) continue;
    for (const [id, quantity] of order.requirements) demand.set(id, (demand.get(id) ?? 0) + quantity);
  }
  return demand;
}

function projectedStock(state) {
  const projected = new Map(state.stock);
  for (const event of state.events) projected.set(event.itemId, (projected.get(event.itemId) ?? 0) + event.quantity);
  return projected;
}

function copyState(state) {
  return { ...state, stock: new Map(state.stock), held: new Map(state.held), events: [...state.events],
    available: [...state.available], started: [...state.started], delivered: [...state.delivered],
    timeline: [...state.timeline], orderCompletions: [...state.orderCompletions], priorityCompletions: [...state.priorityCompletions] };
}

// Cumulative BOM expansion assigns existing stock and batch excess to the
// highest unfinished priority first. Once that tier is satisfied, its inherited
// production priority disappears instead of permanently lifting a whole recipe.
function productionPriorities(data, state, available) {
  const requested = new Map(), priorities = Array(data.recipes.length).fill(Infinity);
  let expanded = { batches: Array(data.recipes.length).fill(0), demand: new Map() };
  const reserved = [];
  for (const priority of data.priorityLevels) {
    for (const [id, quantity] of remainingDemand(data, state, priority)) requested.set(id, (requested.get(id) ?? 0) + quantity);
    expanded = expandDemand(data, requested, available, false);
    for (const recipe of data.recipes) if (expanded.batches[recipe.index] > 0 && priorities[recipe.index] === Infinity) priorities[recipe.index] = priority;
    reserved.push({ priority, demand: expanded.demand });
  }
  return { priorities, batches: expanded.batches, reserved };
}

function actionsAt(data, state, heuristic = false) {
  const actions = [];
  const projected = projectedStock(state);
  const needs = productionPriorities(data, state, projected);
  let currentNeeds = null;
  const nextEvent = Math.min(Infinity, ...state.events.map(event => event.time), ...state.available.filter(time => time > state.time + EPSILON));
  const keepsHigherStock = (inputs, priority) => needs.reserved.every(tier => tier.priority >= priority
    || [...inputs].every(([id, quantity]) => (state.stock.get(id) ?? 0) - quantity
      >= Math.min(state.stock.get(id) ?? 0, tier.demand.get(id) ?? 0)));
  for (const [index, order] of data.orders.entries()) {
    if (!state.delivered[index] && state.time <= (order.deadline ?? Infinity) + EPSILON
      && [...order.requirements].every(([id, quantity]) => (state.stock.get(id) ?? 0) >= quantity)
      && (!heuristic || keepsHigherStock(order.requirements, order.priority))) {
      actions.push({ kind: 'delivery', order: index, priority: order.priority });
    }
  }
  const desired = needs.batches;
  for (const recipe of data.recipes) {
    if (!recipe.usable || state.started[recipe.index] >= data.maxBatches[recipe.index]) continue;
    if (state.time > (recipe.availableUntil ?? Infinity) + EPSILON) continue;
    if (heuristic && !desired[recipe.index]) continue;
    if ([...recipe.inputs].some(([id, quantity]) => (state.stock.get(id) ?? 0) < quantity)) continue;
    if (!desired[recipe.index] && !currentNeeds) currentNeeds = productionPriorities(data, state, state.stock);
    const priority = desired[recipe.index] ? needs.priorities[recipe.index] : currentNeeds.priorities[recipe.index];
    if (heuristic && !keepsHigherStock(recipe.inputs, priority)) continue;
    const physical = (projected.get(recipe.itemId) ?? 0) + (state.held.get(recipe.itemId) ?? 0);
    const cap = data.caps.get(recipe.itemId) ?? Infinity;
    if (data.stockCapMode === 'start-projected' ? physical >= cap : physical + recipe.outputQuantity > cap) continue;
    for (const machine of recipe.machineIndexes) {
      const duration = recipe.durations.get(machine);
      // The incumbent keeps a shared machine free for the next higher-tier
      // event. Short tasks may fill the gap, and independent machines continue.
      // Exact search still considers every legal action, including deadline
      // trade-offs which this conservative incumbent may miss.
      if (heuristic && state.time + duration > nextEvent + EPSILON
        && data.recipes.some(other => needs.priorities[other.index] < priority && other.machineIndexes.includes(machine))) continue;
      if (state.available[machine] <= state.time + EPSILON
        && state.time + duration <= (data.machines[machine].availableUntil ?? Infinity) + EPSILON) {
        actions.push({ kind: 'production', recipe: recipe.index, machine, duration, priority, useful: desired[recipe.index] > 0 });
      }
    }
  }
  return actions.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.kind !== b.kind) return a.kind === 'delivery' ? -1 : 1;
    if (a.kind === 'delivery') return (data.orders[a.order].deadline ?? Infinity) - (data.orders[b.order].deadline ?? Infinity) || a.order - b.order;
    return Number(b.useful) - Number(a.useful)
      || a.duration - b.duration
      || a.recipe - b.recipe || a.machine - b.machine;
  });
}

function applyAction(data, state, action) {
  const next = copyState(state);
  const sequence = state.timeline.length + state.orderCompletions.length;
  if (action.kind === 'delivery') {
    const order = data.orders[action.order];
    for (const [id, quantity] of order.requirements) {
      next.stock.set(id, (next.stock.get(id) ?? 0) - quantity);
      if (!order.consumeOnCompletion) next.held.set(id, (next.held.get(id) ?? 0) + quantity);
    }
    next.delivered[action.order] = true;
    next.priorityCompletions[order.priorityIndex] = Math.max(next.priorityCompletions[order.priorityIndex], state.time);
    next.orderCompletions.push({ orderId: order.id, completedAt: state.time, sequence,
      priority: order.priority, consumeOnCompletion: order.consumeOnCompletion, deadline: order.deadline ?? null });
    return next;
  }
  const recipe = data.recipes[action.recipe];
  for (const [id, quantity] of recipe.inputs) next.stock.set(id, (next.stock.get(id) ?? 0) - quantity);
  const end = state.time + recipe.durations.get(action.machine);
  next.available[action.machine] = end;
  next.started[recipe.index]++;
  next.events.push({ itemId: recipe.itemId, quantity: recipe.outputQuantity, time: end, fixed: false });
  next.timeline.push({ kind: 'production', recipeId: recipe.id, machineId: data.machines[action.machine].id,
    itemId: recipe.itemId, quantity: recipe.outputQuantity, start: state.time, end, sequence,
    inputs: [...recipe.inputs].map(([itemId, quantity]) => ({ itemId, quantity })) });
  return next;
}

function advance(state) {
  const future = [...state.events.map(event => event.time), ...state.available].filter(time => time > state.time + EPSILON);
  if (!future.length) return null;
  const next = copyState(state);
  next.time = Math.min(...future);
  next.events = [];
  for (const event of state.events) {
    if (event.time <= next.time + EPSILON) next.stock.set(event.itemId, (next.stock.get(event.itemId) ?? 0) + event.quantity);
    else next.events.push(event);
  }
  return next;
}

function stateKey(data, state) {
  return JSON.stringify([state.time, data.items.map(id => state.stock.get(id) ?? 0),
    data.items.map(id => state.held.get(id) ?? 0), state.available.map(time => Math.max(time, state.time)),
    state.started, state.delivered, state.events.map(event => [event.time, event.itemId, event.quantity])
      .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]) || a[2] - b[2]), state.priorityCompletions]);
}

// Each direct item gets all its machines to itself and ignores material costs.
// This optimistic supply time is a valid lower bound despite shared facilities.
function lowerBound(data, state, demand = remainingDemand(data, state)) {
  let bound = demand.size ? state.time : 0;
  for (const [id, quantity] of demand) {
    const missing = quantity - (state.stock.get(id) ?? 0);
    if (missing <= 0) continue;
    const supply = state.events.filter(event => event.itemId === id);
    const recipe = data.recipeByItem.get(id);
    const lanes = [];
    const maximum = recipe?.usable ? data.maxBatches[recipe.index] - state.started[recipe.index] : 0;
    if (recipe?.usable) {
      const needed = Math.min(maximum, Math.ceil(missing / recipe.outputQuantity));
      for (const machine of recipe.machineIndexes) {
        const start = Math.max(state.time, state.available[machine]);
        const duration = recipe.durations.get(machine);
        const byStart = Math.floor(((recipe.availableUntil ?? Infinity) - start + EPSILON) / duration) + 1;
        const byEnd = Math.floor(((data.machines[machine].availableUntil ?? Infinity) - start + EPSILON) / duration);
        const count = Math.max(0, Math.min(needed, byStart, byEnd));
        if (count) lanes.push({ start, duration, count });
      }
    }
    const enoughBy = time => {
      let needed = missing;
      for (const event of supply) if (event.time <= time) needed -= event.quantity;
      if (needed <= 0) return true;
      if (!recipe?.usable) return false;
      let batches = Math.ceil(needed / recipe.outputQuantity);
      if (batches > maximum) return false;
      for (const lane of lanes) {
        batches -= Math.max(0, Math.min(lane.count, Math.floor((time - lane.start + EPSILON) / lane.duration)));
        if (batches <= 0) return true;
      }
      return false;
    };
    let low = state.time;
    let high = Math.max(low, ...supply.map(event => event.time), ...lanes.map(lane => lane.start + lane.count * lane.duration));
    if (!enoughBy(high)) return Infinity;
    // Count batches analytically so large valid order quantities do not make
    // a bound calculation exceed the search budget or allocate one row each.
    for (let iteration = 0; iteration < 64 && high - low > EPSILON; iteration++) {
      const middle = low + (high - low) / 2;
      if (middle === low || middle === high) break;
      if (enoughBy(middle)) high = middle;
      else low = middle;
    }
    // low is optimistic. The next actual supply event is still a lower bound
    // and retains exact event times for the common integral-duration model.
    let ready = Infinity;
    for (const event of supply) if (event.time > low) ready = Math.min(ready, event.time);
    for (const lane of lanes) {
      const batch = Math.max(1, Math.floor((low - lane.start) / lane.duration) + 1);
      if (batch <= lane.count) ready = Math.min(ready, lane.start + batch * lane.duration);
    }
    if (!Number.isFinite(ready)) ready = low;
    bound = Math.max(bound, ready);
  }
  return bound;
}

function objectiveLowerBound(data, state) {
  return data.priorityLevels.map((priority, index) => Math.max(state.priorityCompletions[index],
    lowerBound(data, state, remainingDemand(data, state, priority))));
}

function compareObjectives(left, right) {
  for (let index = 0; index < left.length; index++) {
    if (left[index] < right[index] - EPSILON) return -1;
    if (left[index] > right[index] + EPSILON) return 1;
  }
  return 0;
}

// Attribute the selected schedule using actual availability and consumption.
// A late pre-existing arrival must not hide a new batch delivered to a high
// priority order, while an earlier paid arrival already covers that demand.
function attributedTimeline(data, state) {
  const stock = new Map();
  const add = (itemId, quantity, source) => {
    const lots = stock.get(itemId) ?? [];
    if (quantity > 0) lots.push({ quantity, source });
    stock.set(itemId, lots);
  };
  for (const [id, quantity] of data.inventory) add(id, quantity, null);
  const arrivals = [...data.incoming.map(event => ({ ...event, source: null })),
    ...state.timeline.map((job, source) => ({ itemId: job.itemId, quantity: job.quantity, time: job.end, source }))]
    .sort((a, b) => a.time - b.time);
  const operations = [...state.timeline.map((job, index) => ({ ...job, index, time: job.start })),
    ...state.orderCompletions.map(order => ({ ...order, kind: 'delivery', time: order.completedAt }))]
    .sort((a, b) => a.time - b.time || a.sequence - b.sequence);
  const dependencies = state.timeline.map(() => new Set());
  const priorities = state.timeline.map(() => Infinity);
  const consume = inputs => {
    const sources = new Set();
    for (const [id, required] of inputs) {
      const lots = stock.get(id) ?? [];
      let remaining = required;
      while (remaining > 0 && lots.length) {
        const lot = lots[0], taken = Math.min(remaining, lot.quantity);
        if (lot.source !== null) sources.add(lot.source);
        remaining -= taken;
        lot.quantity -= taken;
        if (lot.quantity === 0) lots.shift();
      }
    }
    return sources;
  };
  const inherit = (source, priority) => {
    if (priorities[source] <= priority) return;
    priorities[source] = priority;
    for (const input of dependencies[source]) inherit(input, priority);
  };
  let arrived = 0;
  for (const operation of operations) {
    while (arrived < arrivals.length && arrivals[arrived].time <= operation.time + EPSILON) {
      const event = arrivals[arrived++];
      add(event.itemId, event.quantity, event.source);
    }
    if (operation.kind === 'production') dependencies[operation.index] = consume(operation.inputs.map(input => [input.itemId, input.quantity]));
    else {
      const order = data.orders.find(order => order.id === operation.orderId);
      for (const source of consume(order.requirements)) inherit(source, order.priority);
    }
  }
  return state.timeline.map(({ sequence, ...job }, index) => ({ ...job, priority: Number.isFinite(priorities[index]) ? priorities[index] : null }));
}

function blockers(data) {
  const available = new Map(data.inventory);
  for (const event of data.incoming) available.set(event.itemId, (available.get(event.itemId) ?? 0) + event.quantity);
  const blocked = expandDemand(data, data.orderDemand, available, true).blocked;
  // Existing stock and already-paid arrivals may exceed a production cap. A
  // start-only cap can also be crossed by the last legal production batch.
  const maximumStock = id => Math.max(available.get(id) ?? 0, (data.caps.get(id) ?? Infinity)
    + (data.stockCapMode === 'start-projected' ? (data.recipeByItem.get(id)?.outputQuantity ?? 1) - 1 : 0));
  const held = new Map();
  for (const order of data.orders) if (order.deadline != null && order.deadline < -EPSILON) {
    blocked.push({ orderId: order.id, reason: '订单已超过硬截止时间', deadline: order.deadline });
  }
  for (const order of data.orders) for (const [id, quantity] of order.requirements) {
    if (quantity > maximumStock(id)) blocked.push({ orderId: order.id, itemId: id,
      reason: '单个订单齐套数量超过该产物可达仓存上限', missingQuantity: quantity - maximumStock(id) });
    if (!order.consumeOnCompletion) held.set(id, (held.get(id) ?? 0) + quantity);
  }
  for (const [id, quantity] of held) if (quantity > maximumStock(id)) {
    blocked.push({ itemId: id, reason: '需保留的订单产物总量超过可达仓存上限', missingQuantity: quantity - maximumStock(id) });
  }
  return blocked;
}

/**
 * Optimize all supplied orders together, without changing fixed work or using
 * upgrades or acceleration. Times are seconds relative to snapshotTime.
 * Order deadlines are hard constraints. Priorities are lexicographic tiers of
 * their latest order completion. Equal priorities minimize joint makespan.
 * Per-machine duration overrides fall back to durationSeconds when omitted.
 * Stock caps either reserve every output or check projected stock at each start.
 * A single recipe per item and an acyclic production graph are required for an
 * optimality proof. Unsupported or unread state is reported as incomplete.
 */
export function optimizeProductionSchedule(input, options = {}) {
  const startedAt = clock();
  const limits = { ...DEFAULT_LIMITS, ...options };
  const data = prepare(input ?? {});
  const result = { status: 'incomplete', scope: 'all-orders', snapshotTime: input?.snapshotTime ?? null,
    lowerBound: null, upperBound: null, timeline: [], orderCompletions: [], blockedOrders: [],
    reasons: [], objective: data.priorityLevels.length > 1 ? 'priority-makespan' : 'makespan', deadlinesEnforced: true,
    priorityLevels: data.priorityLevels, objectiveLowerBound: null, objectiveUpperBound: null,
    priorityBounds: data.priorityLevels.map(priority => ({ priority, lowerBound: null, upperBound: null })),
    assumptions: ['固定快照、当前设施与资源', '已有加工固定完成时间', '每种产物单配方、依赖无环', '不含新升级与付费加速'],
    stats: { nodes: 0, elapsedMilliseconds: 0, exhausted: false, limitReached: false } };
  const finish = () => { result.stats.elapsedMilliseconds = clock() - startedAt; return result; };
  result.assumptions.push(data.stockCapMode === 'start-projected'
    ? '开工前核验库存、待收、在途及已保留订单数量，允许本批越过上限'
    : '库存、待收、在途及已保留订单产出共同预占仓容');
  if (data.priorityLevels.length > 1) result.assumptions.push('先最小化最高优先级齐套时间，再依次最小化后续优先级齐套时间');
  if (!Number.isSafeInteger(limits.maxNodes) || limits.maxNodes < 1
    || !Number.isFinite(limits.maxMilliseconds) || limits.maxMilliseconds <= 0) {
    result.reasons = ['搜索预算无效'];
    return finish();
  }
  if (data.errors.length) { result.reasons = data.errors; return finish(); }
  const blocked = blockers(data);
  if (blocked.length) {
    result.status = blocked.some(entry => entry.incomplete) ? 'incomplete' : 'infeasible';
    result.blockedOrders = blocked;
    result.reasons = [...new Set(blocked.map(entry => entry.reason))];
    result.stats.exhausted = result.status === 'infeasible';
    return finish();
  }
  const initial = initialState(data);
  const rootBound = lowerBound(data, initial);
  const rootObjective = objectiveLowerBound(data, initial);
  result.lowerBound = Number.isFinite(rootBound) ? rootBound : null;
  result.objectiveLowerBound = rootObjective.map(value => Number.isFinite(value) ? value : null);
  result.priorityBounds.forEach((tier, index) => { tier.lowerBound = result.objectiveLowerBound[index]; });
  let best = null;
  const expired = () => clock() - startedAt >= limits.maxMilliseconds;
  const complete = state => state.delivered.every(Boolean);
  const missedDeadline = state => data.orders.some((order, index) => !state.delivered[index]
    && state.time > (order.deadline ?? Infinity) + EPSILON);
  // Obtain a feasible incumbent before spending the remaining budget proving it.
  let greedy = initial;
  const greedyLimit = Math.min(10000, Math.max(100, sum(data.maxBatches) * 3 + data.orders.length * 2 + data.incoming.length));
  for (let step = 0; step < greedyLimit && !expired() && !data.errors.length; step++) {
    if (missedDeadline(greedy)) break;
    if (complete(greedy)) { best = greedy; break; }
    const action = actionsAt(data, greedy, true)[0];
    const next = action ? applyAction(data, greedy, action) : advance(greedy);
    if (!next) break;
    greedy = next;
  }
  const stack = [initial], visited = new Set();
  while (stack.length && result.stats.nodes < limits.maxNodes && !expired() && !data.errors.length) {
    const state = stack.pop();
    result.stats.nodes++;
    if (missedDeadline(state)) continue;
    if (complete(state)) {
      if (!best || compareObjectives(state.priorityCompletions, best.priorityCompletions) < 0) best = state;
      continue;
    }
    if (best && compareObjectives(objectiveLowerBound(data, state), best.priorityCompletions) >= 0) continue;
    const key = stateKey(data, state);
    if (visited.has(key)) continue;
    visited.add(key);
    const next = advance(state);
    if (next) stack.push(next);
    const actions = actionsAt(data, state);
    for (let index = actions.length - 1; index >= 0; index--) stack.push(applyAction(data, state, actions[index]));
  }
  if (data.errors.length) { result.reasons = [...new Set(data.errors)]; return finish(); }
  const proven = !stack.length || !!best && compareObjectives(rootObjective, best.priorityCompletions) >= 0;
  result.stats.exhausted = proven;
  result.stats.limitReached = !proven;
  if (best) {
    result.status = proven ? 'optimal' : 'best-known';
    result.upperBound = best.time;
    result.objectiveUpperBound = [...best.priorityCompletions];
    if (proven) {
      result.objectiveLowerBound = [...best.priorityCompletions];
      if (data.priorityLevels.length <= 1) result.lowerBound = best.time;
    }
    result.priorityBounds.forEach((tier, index) => {
      tier.lowerBound = result.objectiveLowerBound[index];
      tier.upperBound = result.objectiveUpperBound[index];
    });
    result.timeline = attributedTimeline(data, best).sort((a, b) => a.start - b.start || a.machineId.localeCompare(b.machineId));
    result.orderCompletions = best.orderCompletions.map(({ sequence, ...order }) => order)
      .sort((a, b) => a.completedAt - b.completedAt || a.orderId.localeCompare(b.orderId));
    if (!proven) result.reasons = ['搜索预算已用完，已获得可行排程及有效下界'];
  } else {
    result.status = proven ? 'infeasible' : 'incomplete';
    result.reasons = [proven ? '在当前资源、固定加工、仓容及订单截止约束下无法完成全部订单' : '搜索预算已用完，尚未找到可行排程'];
  }
  return finish();
}
