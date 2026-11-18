const text = value => typeof value === 'string' && value.trim().length > 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isFinite(value) && value > 0;
const material = value => Array.isArray(value) && value.length === 2 && text(value[0]) && count(value[1]);
const materials = value => Array.isArray(value) && value.every(material);

// 仅约束自动消费与预留依赖的字段，新增游戏字段由读取方按需使用。
export const GAMEPLAY_CONFIG_CONTRACTS = {
  ResourceCfg: { id: text },
  ItemCfg: { id: text },
  ModuleOpenCfg: { moduleId: text, playerLevel: count },
  BuildingProduceCfg: { buildType: text, itemId: text, unlockLevel: count, produceTime: positive, costItem: materials },
  FarmlandPlantCfg: { id: text, time: positive, produceNum: positive, material },
  MuseumExpeditionStageCfg: { stageId: count, exploreTime: positive },
  MuseumExploreTimeFactorCfg: { factor: positive, playerLevel: count },
  MuseumExpeditionTeamCfg: { teamCount: count, playerLevel: count },
};

export function validateGameplayConfig(tables) {
  for (const [name, fields] of Object.entries(GAMEPLAY_CONFIG_CONTRACTS)) {
    const rows = tables[name]?.data;
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('配置校验失败，缺少有效表 ' + name);
    for (const [index, row] of rows.entries()) {
      for (const [field, valid] of Object.entries(fields)) {
        if (!valid(row?.[field])) throw new Error(`配置校验失败，${name}[${index}].${field} 缺失或类型、取值无效`);
      }
    }
  }
}
