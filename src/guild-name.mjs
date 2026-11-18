import { exactAutomationId } from './automation-policy.mjs';

// 世界与硅矿共用游戏命名规则：自定义名称优先，空名使用当前场景出生主城名。
export function createGuildNameResolver(config, scenario, guilds) {
  const defaults = new Map(), names = new Map(), ambiguous = new Set();
  const cities = config?.tables?.[(scenario || 1) + '_CityCfg']?.data;
  for (const city of Array.isArray(cities) ? cities : []) {
    const name = typeof city?.name === 'string' ? city.name.trim() : '';
    if (Number.isSafeInteger(city?.guildIndex) && city.guildIndex > 0 && name) defaults.set(city.guildIndex, name);
  }
  for (const guild of Array.isArray(guilds) ? guilds : []) {
    const id = exactAutomationId(guild?.id), name = typeof guild?.name === 'string' ? guild.name.trim() : '';
    if (!id || !name) continue;
    const index = Number(BigInt(id) % 1000n);
    if (index <= 0) continue;
    if (names.has(index) && names.get(index) !== name) ambiguous.add(index);
    names.set(index, name);
  }
  // 矿位只带联盟编号；多个完整 ID 对应同一编号且名称冲突时，不任选自定义名。
  for (const index of ambiguous) names.delete(index);
  return index => {
    const custom = names.get(index), fallback = defaults.get(index);
    return { name: custom || fallback || null, defaultName: !custom && !!fallback };
  };
}
