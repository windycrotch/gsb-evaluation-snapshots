import { SettingsError, settingsCatalog } from './automation-settings.mjs';
import { cityWarUsesGlobalStrategy } from './city-war-settings.mjs';

// A missing table is not an empty catalog. Small offline snapshots and read-only
// probes may omit tables; an explicitly supplied empty table is authoritative.
const collections = {
  buildings: { tables: ['BuildingCfg', 'BuildingUnlockCfg'], fields: ['building.disabledTypes'] },
  factories: { tables: ['BuildingCfg', 'BuildingUnlockCfg', 'BuildingProduceCfg'], fields: ['factory.disabledTypes'] },
  materials: { tables: ['ItemCfg', 'ResourceCfg'], fields: ['factory.speedUpItems', 'resident.blockedMaterials',
    'museum.factorMaterials', 'treasure.rewardItems', 'treasure.fallbackMediumRewardPriority', 'treasure.fallbackSmallRewardPriority',
    'alliance.allowedMaterials', 'alliance.blockedMaterials', 'alliance.requestMaterials', 'guildShip.rewardItems',
    'guildShip.disabledMaterials', 'guildFort.materials'] },
  maps: { tables: ['MuseumExpeditionStageCfg'], fields: ['museum.maps'] },
  heroes: { tables: ['HeroCfg'], fields: ['heroes.heroIds'] },
  petSpecies: { tables: ['PetBreedCfg'], fields: ['pet.species'] },
  expeditionFleets: { tables: ['BuildingUnlockCfg'], fields: ['treasure.fleetIds', 'cityWar.fleetIds',
    'cityWar.defenceFleetIds', 'radar.fleetIds', 'worldBoss.fleetIds', 'pirateHunt.fleetIds'] },
  pirateTypes: { tables: ['WorldPirateCfg'], fields: ['pirateHunt.types'] },
  forgeBuildings: { tables: ['BuildingUnlockCfg'], fields: ['forge.buildingIds'] },
  forgeRecipes: { tables: ['BuildingEquipMakeCfg'], fields: ['forge.recipeIds'] },
  guildTech: { tables: ['GuildTechCfg'], fields: ['alliance.techIds'] },
};
const catalogCache = new WeakMap();
const at = (settings, field) => field.split('.').reduce((value, key) => value?.[key], settings);

// Inventory and cost checks can await several server reads. Recheck immediately
// after they reserve a ticket, before returning it to the sender. If the runtime
// changed meanwhile, explicitly cancel that unsent ticket and release its budget.
export function guardRuntimeActions(guard, assertRuntime) {
  return {
    ...guard,
    async before(step, ...args) {
      assertRuntime();
      const ticket = await guard.before(step, ...args);
      try {
        assertRuntime();
        return ticket;
      } catch (error) {
        await guard.cancel(step, ticket, { notSent: true, error });
        throw error;
      }
    },
  };
}

export function validateRuntimeSettings(settings, config) {
  if (!settings || !config?.tables) return;
  const tables = config.tables;
  const has = name => Array.isArray(tables[name]?.data);
  let catalog = catalogCache.get(config);
  if (!catalog) {
    catalog = settingsCatalog(config);
    catalogCache.set(config, catalog);
  }
  const errors = {};
  function check(field, values, allowed) {
    if (!Array.isArray(values)) return;
    const missing = values.filter(value => !allowed.has(String(value)));
    if (missing.length) errors[field] = '当前游戏配置中已不存在：' + missing.join('、') + '，请重新选择';
  }
  for (const [name, rule] of Object.entries(collections)) {
    if (!rule.tables.every(has)) continue;
    const allowed = new Set(catalog[name].map(row => String(row.value)));
    for (const field of rule.fields) check(field, at(settings, field), allowed);
    if (name === 'expeditionFleets') {
      for (const [index, fleet] of (settings.silicon?.fleets ?? []).entries()) {
        if (fleet.enabled) check('silicon.fleets.' + index + '.id', [fleet.id], allowed);
      }
    }
  }
  if (has('FarmlandPlantCfg')) check('farm.crops', settings.farm?.crops?.map(row => row.id), new Set(catalog.crops.map(row => row.value)));
  function cities(field, refs) {
    if (!Array.isArray(refs)) return;
    const scenarios = has('WorldScenarioCfg') ? new Set(tables.WorldScenarioCfg.data.map(row => String(row.id))) : null;
    const missing = refs.filter(ref => {
      const [scenario, city] = String(ref).split(':');
      return scenarios && !scenarios.has(scenario) || has(scenario + '_CityCfg')
        && !tables[scenario + '_CityCfg'].data.some(row => String(row.id) === city);
    });
    if (missing.length) errors[field] = '当前游戏配置中已不存在城市：' + missing.join('、') + '，请重新选择';
  }
  // Only inspect effective target lists. Cached custom targets stay editable
  // but cannot block execution while that fleet follows the global strategy.
  const inheritedTargets = new Set();
  for (const id of settings.cityWar?.fleetIds ?? []) {
    if (!cityWarUsesGlobalStrategy(settings.cityWar, id)) continue;
    inheritedTargets.add(settings.cityWar.defenceFleetIds?.includes(id) ? 'defenceCityRefs' : 'cityRefs');
  }
  for (const field of inheritedTargets) cities('cityWar.' + field, settings.cityWar[field]);
  for (const [id, strategy] of Object.entries(settings.cityWar?.fleetStrategies ?? {})) {
    if (cityWarUsesGlobalStrategy(settings.cityWar, id)) continue;
    cities('cityWar.fleetStrategies.' + id + '.cityRefs', strategy.cityRefs);
    cities('cityWar.fleetStrategies.' + id + '.defenceCityRefs', strategy.defenceCityRefs);
  }
  if (Object.keys(errors).length) {
    const error = new SettingsError(errors);
    error.code = 'SETTINGS_STALE';
    error.message = '挂机设置与当前游戏配置不兼容（' + Object.keys(errors).join('、') + '），已停止执行，请重新选择失效选项后保存';
    throw error;
  }
}
