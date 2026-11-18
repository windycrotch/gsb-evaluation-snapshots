// SCSpeedUp(type=4) 是全角色共用的维修累计分钟，不是逐舰队或逐玩法计数。
// 推送可能晚于舰队/资源变化；先投影本地已发送分钟，再接受只增不减的服务端值。
const watchers = new WeakMap();
const nowDay = client => Math.floor(((Date.now() + (client.serverClockOffsetMs || 0)) / 1000 + 28800) / 86400);
const valid = n => Number.isSafeInteger(n) && n >= 0;

export function watchFleetRepairPricing(client) {
  if (watchers.has(client)) return watchers.get(client);
  let day = nowDay(client), epoch = 0, reported = null, projected = null, unknownBase = false;
  const tickets = new WeakSet();
  const reset = () => { day = nowDay(client); epoch++; reported = projected = null; unknownBase = false; };
  const refresh = () => { if (day !== nowDay(client)) reset(); };
  const watcher = {
    minutes() { refresh(); return unknownBase ? null : projected; },
    reserve(minutes) {
      refresh();
      if (!valid(minutes) || minutes < 1) throw Error('维修加速计费分钟未确认');
      const counted = projected !== null && !unknownBase && valid(projected + minutes);
      if (counted) projected += minutes;
      else unknownBase = true; // 无基线的发送不能靠后续无关联编号推送推算精确费用。
      const ticket = { epoch, minutes, counted }; tickets.add(ticket); return ticket;
    },
    cancel(ticket) {
      refresh();
      if (!ticket || !tickets.delete(ticket) || ticket.epoch !== epoch) return;
      // 只能撤销明确未发送/拒绝的本地投影，不能撤销服务器已报告的分钟。
      if (ticket.counted && projected !== null) projected = Math.max(reported ?? 0, projected - ticket.minutes);
    },
  };
  client.on?.('message', ({ name, body }) => {
    if (name !== 'SCSpeedUp') return;
    refresh();
    for (const row of body?.data ?? []) if (row.type === 4 && valid(row.minutes)) {
      reported = Math.max(reported ?? 0, row.minutes);
      if (!unknownBase) projected = Math.max(projected ?? 0, reported);
    }
  });
  client.on?.('close', reset);
  watchers.set(client, watcher); return watcher;
}

// 未知请求跨重连仍可能影响共享档位；累计推送没有请求编号，按最高档预留。
// 传入当前区服的账本记录，不能让其他角色/区服的未知记录污染本次报价。
export function conservativeRepairMinutes(minutes, records) {
  return Object.values(records).some(record => !record.confirmed &&
    (record.details?.kind === 'fleetSpeed' && record.details.mode === 'repair' ||
      record.details?.kind === 'siliconSpeed' && record.details.repair)) ? null : minutes;
}
