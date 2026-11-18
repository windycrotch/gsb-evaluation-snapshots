import { setTimeout as wait } from 'node:timers/promises';
import { rewardData } from './missing-rewards.mjs';

// 很短的维修可能在首次读回时已经到期，不能只接受 endTs > 当前时间。
export function fleetRepairConfirmed(fleet, details, now) {
  if (!fleet || !Number.isSafeInteger(details.beforeDurability)) return false;
  if (Number.isSafeInteger(fleet.durability) && fleet.durability > details.beforeDurability) return true;
  const r = fleet.repairing;
  return fleet.state === 4 && (r?.endTs > now ||
    Number.isSafeInteger(r?.startTs) && Number.isSafeInteger(r?.endTs) && r.endTs >= r.startTs &&
    Number.isSafeInteger(details.sentAt) && r.startTs >= details.sentAt - 2 &&
    Number.isSafeInteger(r.endDura) && r.endDura > details.beforeDurability);
}

// 只重复查询，不重复提交维修；监听写入期间推送，避免瞬时状态被读回覆盖。
export async function sendRepairAndConfirm(client, step, { enabled = () => true, now, sleep = wait, seed = () => {} } = {}) {
  let observed = null;
  const inspect = list => {
    if (!Array.isArray(list)) return;
    const matches = list.map(rewardData).filter(f => f.buildingId === step.buildingId);
    if (matches.length === 1 && fleetRepairConfirmed(matches[0], step, now())) observed = matches[0];
  };
  const listener = ({ name, body }) => { if (name === 'SCMyFleetUpdate') inspect(body?.fleets); };
  client.on?.('message', listener);
  try {
    try { await client.sendWatch('RepairFleetRequest', step.body, { window: 600 }); }
    catch(error) { error.repairRejected = !!((error.prompt || error.notSent) && error.request === 'RepairFleetRequest'); throw error; }
    for (const delay of [0, 500, 1000, 1500]) {
      if (delay) await sleep(delay);
      if (!enabled() || !client.connected) return null;
      let after;
      try { after = rewardData(await client.request('MyFleetsRequest', {}, 'MyFleetsResponse', 8000)); }
      catch(error) { if(observed && enabled())return observed;throw error; }
      seed(after.fleets); inspect(after.fleets);
      if (observed) return observed;
    }
    return null;
  } finally { client.off?.('message', listener); }
}
