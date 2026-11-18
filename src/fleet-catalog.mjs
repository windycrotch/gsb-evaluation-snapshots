import { exactAutomationId } from './automation-policy.mjs';

// 解锁配置只用于校验历史设置；界面只能展示服务器确认已建成的舰队。
export function observeOwnedFleets(session, fleets, { complete = false } = {}) {
  const worldId = exactAutomationId(session.player?.worldId), playerId = exactAutomationId(session.player?.playerId);
  if (!worldId || !playerId || !Array.isArray(fleets)) return false;
  const ids = fleets.filter(f => /^[1-9]\d*远征船$/.test(f?.buildingId) &&
    (!f.owner || exactAutomationId(f.owner.playerId) === playerId)).map(f => f.buildingId);
  const previous = session.ownedFleets;
  if (!complete && (!previous || previous.worldId !== worldId || previous.playerId !== playerId)) return false;
  session.ownedFleets = { worldId, playerId, ids: [...new Set(complete ? ids : [...previous.ids, ...ids])],
    checkedAt: complete ? Date.now() : previous.checkedAt };
  return true;
}

export function ownedFleetCatalog(session, catalog) {
  const state = session.ownedFleets, known = !!state && (!session.player || state.worldId === exactAutomationId(session.player.worldId) &&
    state.playerId === exactAutomationId(session.player.playerId));
  const ids = known ? state.ids : [];
  return { ...catalog, expeditionFleets: ids.slice().sort((a,b)=>parseInt(a)-parseInt(b)).map(id =>
    catalog.expeditionFleets.find(row=>row.value===id) ?? {value:id,label:'远征舰队 '+id.replace('远征船','')+' 队'}),
    fleetAvailability: { known, stale: !session.client?.connected, checkedAt: known ? state.checkedAt : null } };
}
