import { toNumber } from './client.mjs';
import { uidText } from './hero-equipment.mjs';
import { iconEntry } from './art.mjs';

const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const plain = value => object(value) && Object.getPrototypeOf(value) === Object.prototype;
const qualityNames = { BLUE: '蓝色', PURPLE: '紫色', ORANGE: '橙色', RED: '红色' };

function text(value, title, maximum = 120) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(title + '不能为空');
  if (value.length > maximum) throw new Error(title + '最多 ' + maximum + ' 个字符');
  return value.trim();
}

function fields(value, allowed, title) {
  if (!plain(value)) throw new Error(title + '必须是 JSON 对象');
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(title + '包含未知字段 ' + unknown);
}

function petUid(value) {
  if (value == null || value === '0' || value === 0
    || object(value) && value.low === 0 && value.high === 0) return '0';
  const uid = uidText(value);
  if (!uid) throw new Error('海兽编号无效');
  return uid;
}

export function normalizeFormation(formation, { allowEmpty = false } = {}) {
  // Game replies contain generated protobuf instances. JSON-only checks belong
  // to settings validation, while this reader also accepts those instances.
  if (!object(formation) || !Number.isSafeInteger(formation.presetId) || formation.presetId < 1
    || !Array.isArray(formation.heroPositions)) throw new Error('阵容数据无效');
  if (!allowEmpty && !formation.heroPositions.length) throw new Error('阵容至少需要一名英雄');
  if (formation.heroPositions.length > 100) throw new Error('阵容英雄数量不能超过 100');
  const heroes = new Set(), positions = new Set();
  const heroPositions = formation.heroPositions.map(slot => {
    const heroId = text(slot?.heroId, '英雄编号');
    const x = slot?.pos?.x, y = slot?.pos?.y;
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) throw new Error('英雄站位无效');
    if (heroes.has(heroId)) throw new Error('阵容中存在重复英雄');
    const position = x + ',' + y;
    if (positions.has(position)) throw new Error('同一站位不能安排两名英雄');
    heroes.add(heroId);
    positions.add(position);
    return { heroId, pos: { x, y } };
  });
  return { presetId: formation.presetId, heroPositions, petUid: petUid(formation.petUid) };
}

export function formationSignature(formation) {
  const normalized = normalizeFormation(formation, { allowEmpty: true });
  const positions = normalized.heroPositions.map(slot => [slot.heroId, slot.pos.x, slot.pos.y]);
  positions.sort((left, right) => left[0].localeCompare(right[0]));
  return JSON.stringify([normalized.presetId, normalized.petUid, positions]);
}

export function validateLineupSettings(group = {}) {
  fields(group, ['presets', 'mainlinePresetId', 'trialPresets'], '阵容设置');
  const source = group.presets === undefined ? [] : group.presets;
  if (!Array.isArray(source)) throw new Error('保存的阵容必须是列表');
  const ids = new Set();
  const presets = source.map(preset => {
    fields(preset, ['id', 'name', 'formation'], '保存的阵容');
    const id = text(preset.id, '阵容编号');
    if (ids.has(id)) throw new Error('阵容编号重复');
    ids.add(id);
    fields(preset.formation, ['presetId', 'heroPositions', 'petUid'], '阵容内容');
    const formation = normalizeFormation(preset.formation);
    for (const slot of preset.formation.heroPositions) {
      fields(slot, ['heroId', 'pos'], '英雄站位');
      fields(slot.pos, ['x', 'y'], '站位坐标');
    }
    return { id, name: text(preset.name, '阵容名称', 60), formation };
  });
  const mainlinePresetId = group.mainlinePresetId === undefined ? '' : group.mainlinePresetId;
  if (typeof mainlinePresetId !== 'string' || mainlinePresetId.length > 120 || mainlinePresetId && !ids.has(mainlinePresetId)) {
    throw new Error('主线选择的阵容已不存在');
  }
  const bindings = group.trialPresets === undefined ? [] : group.trialPresets;
  if (!Array.isArray(bindings)) throw new Error('副本阵容配置必须是列表');
  const raids = new Set();
  const trialPresets = bindings.map(binding => {
    fields(binding, ['raidId', 'presetId'], '副本阵容绑定');
    const raidId = text(binding.raidId, '副本编号');
    const presetId = text(binding.presetId, '副本阵容编号');
    if (!/^[1-9]\d*$/.test(raidId) || !Number.isSafeInteger(Number(raidId))) throw new Error('副本编号无效');
    if (raids.has(raidId)) throw new Error('副本阵容配置重复');
    if (!ids.has(presetId)) throw new Error('副本选择的阵容已不存在');
    raids.add(raidId);
    return { raidId, presetId };
  });
  return { presets, mainlinePresetId, trialPresets };
}

export function validateFleetLineupBindings(bindings, presets) {
  if (!Array.isArray(bindings) || bindings.length > 10) throw new Error('舰队阵容配置必须是最多 10 项的列表');
  const fleets = new Set(), ids = new Set(presets.map(preset => preset.id));
  return bindings.map(binding => {
    fields(binding, ['buildingId', 'presetId'], '舰队阵容绑定');
    const buildingId = text(binding.buildingId, '舰队编号'), presetId = text(binding.presetId, '舰队阵容编号');
    if (!/^[1-9]\d*远征船$/.test(buildingId)) throw new Error('舰队编号无效');
    if (fleets.has(buildingId)) throw new Error('舰队阵容配置重复');
    if (!ids.has(presetId)) throw new Error('舰队选择的阵容已不存在');
    fleets.add(buildingId);
    return { buildingId, presetId };
  });
}

function requireList(value, title) {
  if (!Array.isArray(value)) throw new Error('无法读取' + title);
  return value;
}

function description(template, values = []) {
  return String(template ?? '').replace(/\{(\d+)\}/g, (match, index) => values[index] ?? match);
}

export function getLineupCatalog(config) {
  const heads = new Map(rows(config, 'HeadImageCfg').map(head => [head.heroId, head.icon]));
  const skins = new Map(rows(config, 'HeroSkinCfg').map(skin => [skin.heroId, skin]));
  const items = new Map(rows(config, 'ItemCfg').map(item => [item.id, item]));
  const heroes = rows(config, 'HeroCfg').map(hero => ({
    heroId: hero.id, name: hero.name || hero.id,
    career: hero.career ?? '', faction: hero.faction ?? '', quality: hero.quality ?? '',
    // Use the caller's configuration snapshot. heroIcon() uses global config.
    icon: iconEntry(skins.get(hero.id)?.headId) ?? iconEntry(heads.get(hero.id)) ?? iconEntry(items.get(hero.id + '碎片')?.pic),
  }));
  const positions = rows(config, 'FormationTypePositionCfg');
  const definitions = positions.length ? [{ id: 1, name: '基础阵型' }, ...rows(config, 'FormationTypeUnlockCfg')] : [];
  const formations = definitions.map(definition => ({
    presetId: definition.id, name: definition.name,
    positions: positions.filter(position => position.id === definition.id).map(position => ({ x: position.position[0], y: position.position[1] })),
    effect: description(definition.activeDesc, definition.activeDescParams),
    unlockEffect: description(definition.unlockDesc, definition.unlockDescParams), icon: iconEntry('formation_type_' + definition.id),
  }));
  return { heroes, formations };
}

export async function readLineupEditor(client, config, player) {
  // PromptResponse has no request ID. Keep these reads sequential.
  const formationReply = await client.request('GetFormationRequest', { module: 1 }, 'GetFormationResponse');
  const heroReply = await client.request('AllHeroRequest', {}, 'AllHeroResponse');
  const presetReply = await client.request('MyFormationPresetRequest', {}, 'MyFormationPresetResponse');
  // V76 LoginProxy reads AllPetRequest unconditionally during login.
  // ModuleOpenCfg has no pet module. An unreadable inventory must remain an error.
  const petReply = await client.request('AllPetRequest', {}, 'AllPetResponse');
  const roster = requireList(heroReply.heroes, '英雄列表');
  const unlocked = new Set(requireList(presetReply.ids, '已解锁阵型'));
  unlocked.add(1);
  const petList = requireList(petReply.pets, '海兽列表');
  const formation = normalizeFormation(formationReply.formation, { allowEmpty: true });
  const catalog = getLineupCatalog(config);
  const heroConfig = new Map(catalog.heroes.map(hero => [hero.heroId, hero]));
  const heroes = roster.map(hero => {
    const definition = heroConfig.get(hero.heroId);
    if (!definition) throw new Error('缺少英雄配置 ' + hero.heroId);
    return { ...definition, name: hero.showName || definition.name, level: hero.level ?? 0, power: toNumber(hero.power ?? 0) };
  });
  const positions = rows(config, 'FormationTypePositionCfg');
  if (!positions.length || !rows(config, 'FormationHeroNumCfg').length) throw new Error('缺少阵型站位或人数配置');
  const formations = catalog.formations.map(definition => ({ ...definition, unlocked: unlocked.has(definition.presetId) }));
  const breeds = new Map(rows(config, 'PetBreedCfg').map(pet => [pet.petId, pet]));
  const species = new Map(rows(config, 'PetSpeciesCfg').map(pet => [pet.spId, pet]));
  const pets = petList.map(pet => {
    const uid = uidText(pet.uid);
    if (!uid) throw new Error('海兽编号无效');
    const breed = breeds.get(pet.petId);
    const definition = species.get(breed?.spId);
    const quality = breed?.quality ?? '';
    const star = pet.star ?? 0, level = pet.level ?? 0;
    if (!Number.isSafeInteger(star) || star < 0 || !Number.isSafeInteger(level) || level < 0) throw new Error('海兽星级或等级无效');
    const speciesName = definition?.name || pet.petId;
    const details = [qualityNames[quality] || quality, star + '星', level + '级'].filter(Boolean).join(' · ');
    return { uid, petId: pet.petId, quality, star, level, name: speciesName + '（' + details + '）', icon: iconEntry(definition?.icon) };
  });
  const capacity = rows(config, 'FormationHeroNumCfg').reduce((maximum, row) =>
    player?.mainlineStage > row.mainlineStage ? Math.max(maximum, row.heroNum) : maximum, 0);
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('无法确认当前可上阵人数');
  return { formation, heroes, formations, pets, capacity };
}

export function validateEditorFormation(formation, editor) {
  const normalized = normalizeFormation(formation);
  const definition = editor.formations.find(entry => entry.presetId === normalized.presetId);
  if (!definition) throw new Error('找不到所选阵型');
  if (!definition.unlocked) throw new Error('所选阵型尚未解锁');
  if (normalized.heroPositions.length > editor.capacity) throw new Error('上阵英雄超过当前人数上限');
  const roster = new Set(editor.heroes.map(hero => hero.heroId));
  const positions = new Set(definition.positions.map(position => position.x + ',' + position.y));
  for (const slot of normalized.heroPositions) {
    if (!roster.has(slot.heroId)) throw new Error('尚未拥有英雄 ' + slot.heroId);
    if (!positions.has(slot.pos.x + ',' + slot.pos.y)) throw new Error('英雄站位不属于所选阵型');
  }
  if (normalized.petUid !== '0' && !editor.pets.some(pet => pet.uid === normalized.petUid)) {
    throw new Error('所选海兽已不存在');
  }
  return normalized;
}
