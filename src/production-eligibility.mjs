const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const quantity = value => Number.isSafeInteger(value) && value >= 0;

function amounts(entries) {
  if (!Array.isArray(entries)) return null;
  const result = [];
  for (const entry of entries) {
    const id = Array.isArray(entry) ? entry[0] : entry?.id ?? entry?.itemId;
    const num = Array.isArray(entry) ? entry[1] : entry?.num ?? entry?.quantity;
    if (typeof id !== 'string' || !id || !quantity(num)) return null;
    if (num > 0) result.push({ id, num });
  }
  return result;
}

/** Check factory unlocks and disabled facilities against the current snapshot. */
export function createProductionEligibility(config, { buildings, settings, stock, incoming = new Map() }) {
  const factories = new Map(rows(config, 'BuildingProduceCfg').map(recipe => [recipe.itemId, recipe]));
  const crops = new Map(rows(config, 'FarmlandPlantCfg').map(recipe => [recipe.id, recipe]));
  const types = [...new Set([...factories.values()].map(recipe => recipe.buildType).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  const buildingTypes = new Map(rows(config, 'BuildingUnlockCfg').map(building => [building.buildingId, building.buildingType]));
  const facilities = (Array.isArray(buildings) ? buildings : []).map(building => {
    const id = building?.buildingId ?? building?.id;
    const type = building?.type ?? buildingTypes.get(id) ?? (typeof id === 'string' ? types.find(value => id.endsWith(value)) : null);
    return { ...building, id, type };
  });
  const disabled = new Set(settings?.factory?.disabledTypes ?? []);
  let available = new Map();
  let stateKnown = Array.isArray(buildings) && stock instanceof Map && incoming instanceof Map;
  for (const balances of [stock, incoming]) {
    if (!(balances instanceof Map)) continue;
    for (const [id, num] of balances) {
      if (typeof id !== 'string' || !id || !quantity(num)) {
        stateKnown = false;
        continue;
      }
      const total = (available.get(id) ?? 0) + num;
      if (!quantity(total)) { stateKnown = false; continue; }
      available.set(id, total);
    }
  }

  const factoryBlocker = recipe => {
    if (!recipe.buildType || !quantity(recipe.unlockLevel)) return null;
    if (settings?.factory?.enabled === false) return '工厂生产已禁用';
    const matching = facilities.filter(building => building.type === recipe.buildType);
    const enabled = matching.filter(building => building.enabled !== false
      && !disabled.has(building.type) && !disabled.has(building.buildingId ?? building.id));
    if (enabled.some(building => quantity(building.level) && building.level > 0 && building.level >= recipe.unlockLevel)) return '';
    if (disabled.has(recipe.buildType) || matching.length && !enabled.length) return '所需工厂已禁用';
    // Unknown building state stays with the existing incomplete-data checks.
    if (enabled.some(building => !quantity(building.level)) || facilities.some(building => !building.type && !building.id)) return null;
    if (!matching.some(building => building.level > 0)) return '所需工厂尚未建成';
    return '所需工厂等级未达到或已禁用';
  };

  return (requirements, { reserve = false } = {}) => {
    const requested = amounts(requirements);
    if (!stateKnown || !requested) return [];
    const remaining = new Map(available);
    const blockers = new Map();
    let complete = true;
    const consume = (id, num, visiting) => {
      const held = remaining.get(id) ?? 0;
      const used = Math.min(held, num);
      remaining.set(id, held - used);
      const missing = num - used;
      if (!missing) return;
      if (visiting.has(id)) { complete = false; return; }
      const factory = factories.get(id);
      const crop = crops.get(id);
      if (!factory && !crop) return;
      if (factory) {
        const reason = factoryBlocker(factory);
        if (reason === null) { complete = false; return; }
        if (reason) { blockers.set(id, { itemId: id, reason }); return; }
      }
      const output = factory ? 1 : crop.produceNum;
      const costs = amounts(factory ? factory.costItem ?? [] : [crop.material]);
      if (!quantity(output) || output === 0 || !costs) { complete = false; return; }
      const batches = Math.ceil(missing / output);
      const produced = batches * output;
      if (!quantity(produced) || costs.some(cost => !quantity(cost.num * batches))) { complete = false; return; }
      const next = new Set(visiting).add(id);
      for (const cost of costs) consume(cost.id, cost.num * batches, next);
      remaining.set(id, (remaining.get(id) ?? 0) + produced - missing);
    };
    for (const item of requested) consume(item.id, item.num, new Set());
    if (!complete) return [];
    if (!blockers.size && reserve) available = remaining;
    return [...blockers.values()];
  };
}
