import { normalizeAppointmentPriorities } from './appointment-priorities.mjs';

// Match AppointUtil.appointGroup: keep positions together by effect. Explicit
// local priorities override the game pins for this assignment only.
function orderedPositions(config, priorPosIds, priorities) {
  const rows = config?.tables?.AppointPosCfg?.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error('缺少 AppointPosCfg，无法读取职位');
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.effectId)) groups.set(row.effectId, []);
    groups.get(row.effectId).push(row);
  }
  const remaining = [...groups.values()].sort((a, b) => a[0].playerLevel - b[0].playerLevel);
  const pinned = [];
  const orderedEffects = priorities === undefined
    ? priorPosIds.filter((_, index) => index % 3 === 0).map(id => rows.find(row => row.posId === id)?.effectId)
    : normalizeAppointmentPriorities(priorities);
  for (const effect of orderedEffects) {
    const index = remaining.findIndex(group => group[0].effectId === effect);
    if (index !== -1) pinned.push(...remaining.splice(index, 1));
  }
  return [...pinned, ...remaining].flat();
}

export async function appointments(client, config, playerLevel, { assign = false, priorities, enabled = () => true } = {}) {
  if (!Number.isInteger(playerLevel) || playerLevel < 1) throw new Error('缺少角色等级，无法核对开放职位');
  const read = () => client.request('AppointInfoRequest', {}, 'AppointInfoResponse');
  const before = await read();
  const positions = orderedPositions(config, before.priorPosIds ?? [], priorities);
  const open = positions.filter(row => row.playerLevel <= playerLevel);
  let after = before;
  const skipped = assign && open.length > 0 && !enabled();
  if (assign && open.length && !skipped) {
    // The client's one-click button sends every group in priority order.
    // The server handles eligibility and chooses the heroes.
    await client.request('AutoAppointRequest', { posId: positions.map(row => row.posId) }, 'AppointInfoResponse');
    after = await read();
  }
  const heroAt = (info) => new Map((info.heroes ?? []).map(hero => [hero.posId, hero.heroId]));
  const previous = heroAt(before);
  const current = heroAt(after);
  const slots = open.map(row => ({ id: row.posId, effect: row.effectId, hero: current.get(row.posId) ?? null }));
  const changed = slots.filter(slot => (previous.get(slot.id) ?? null) !== slot.hero).length;
  const result = { slots, changed, occupied: slots.filter(slot => slot.hero).length };
  if (skipped) return { ...result, skipped: true, reason: '自动委任已关闭或暂停' };
  return result;
}
