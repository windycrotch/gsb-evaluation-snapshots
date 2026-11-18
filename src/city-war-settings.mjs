// 每支舰队可跟随全局攻守目标或使用独立策略；切回全局时仍保留独立值。
export const CITY_WAR_STRATEGY_FIELDS = ['targetMode', 'targetPriority', 'cityRefs',
  'defenceTargetMode', 'defenceTargetPriority', 'defenceCityRefs'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const fleetId = value => typeof value === 'string' && value.length <= 120 && /^[1-9]\d*远征船$/.test(value);
const cityRef = value => typeof value === 'string' && /^[1-9]\d{0,3}:[1-9]\d{0,5}$/.test(value);

export function cityWarUsesGlobalStrategy(preferences, id) {
  const override = preferences?.fleetStrategies;
  return !plain(override) || !Object.hasOwn(override, id) || override[id]?.strategyMode === 'global';
}

export function cityWarFleetStrategy(preferences, id) {
  if (!cityWarUsesGlobalStrategy(preferences, id)) return structuredClone(preferences.fleetStrategies[id]);
  return {
    targetMode: preferences?.targetMode ?? 'alliance',
    targetPriority: preferences?.targetPriority ?? 'fewestAllied',
    cityRefs: [...(preferences?.cityRefs ?? [])],
    defenceTargetMode: preferences?.defenceTargetMode ?? preferences?.targetMode ?? 'alliance',
    defenceTargetPriority: preferences?.defenceTargetPriority ?? preferences?.targetPriority ?? 'fewestAllied',
    defenceCityRefs: [...(preferences?.defenceCityRefs ?? preferences?.cityRefs ?? [])],
  };
}

export function validateCityWarFleetStrategies(value, errors, catalog) {
  const base = 'cityWar.fleetStrategies';
  if (!plain(value) || Object.keys(value).length > 10) {
    errors[base] = '舰队策略必须为最多 10 支舰队的配置对象'; return {};
  }
  const output = {};
  const allowedCities = catalog && new Set((catalog.cityTargets ?? []).map(row => String(row.value)));
  for (const [id, item] of Object.entries(value)) {
    const prefix = base + '.' + id;
    if (!fleetId(id)) { errors[prefix] = '请选择有效的远征舰队'; continue; }
    if (!plain(item)) { errors[prefix] = '舰队策略必须是对象'; continue; }
    const row = cityWarFleetStrategy({}, id);
    for (const key of Object.keys(item)) if (!CITY_WAR_STRATEGY_FIELDS.includes(key) && key !== 'strategyMode') errors[prefix + '.' + key] = '不支持的舰队策略设置';
    // 旧的独立条目没有模式字段，继续视为独立，不自动改成跟随全局。
    if (Object.hasOwn(item, 'strategyMode')) {
      if (!['global', 'custom'].includes(item.strategyMode)) errors[prefix + '.strategyMode'] = '请选择跟随全局或独立策略';
      else row.strategyMode = item.strategyMode;
    }
    for (const key of CITY_WAR_STRATEGY_FIELDS) {
      const path = prefix + '.' + key, field = item[key];
      if (!Object.hasOwn(item, key)) { errors[path] = '缺少此设置项'; continue; }
      if (key.endsWith('Mode')) {
        if (!['alliance', 'selected'].includes(field)) errors[path] = '请选择有效的目标来源';
        else row[key] = field;
      } else if (key.endsWith('Priority')) {
        if (!['fewestAllied', 'original'].includes(field)) errors[path] = '请选择有效的目标优先策略';
        else row[key] = field;
      } else if (!Array.isArray(field) || field.length > 100 || field.some(ref => !cityRef(ref)) || new Set(field).size !== field.length) {
        errors[path] = '城市选项必须为不重复的有效场景和城市编号列表';
      } else {
        row[key] = [...field];
        if (item.strategyMode !== 'global' && allowedCities && field.some(ref => !allowedCities.has(ref))) errors[path] = '包含当前游戏配置中不存在的选项，请重新选择';
      }
    }
    output[id] = row;
  }
  return output;
}
