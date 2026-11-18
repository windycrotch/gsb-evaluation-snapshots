// 原生自动锻造只同步游戏开关，不下单或管理原生消耗。
export const nativeForgeKey = (snapshot, buildingId) =>
  'forgeNative:' + snapshot.worldId + ':' + /^([1-9]\d*)装备厂$/.exec(buildingId)?.[1] + ':' + snapshot.playerId;

export async function readNativeForgeAccess(client, protocol, config, now) {
  try {
    if (!protocol.MonthCardRequest || !protocol.MonthCardResponse) throw new Error('当前协议缺少月卡读取能力');
    const cards = await client.request('MonthCardRequest', {}, 'MonthCardResponse', 8000);
    if (!Array.isArray(cards?.cardItem)) throw new Error('月卡状态未完整同步');
    const seen = new Set();
    let effect = 0;
    for (const card of cards.cardItem) {
      if (!Number.isSafeInteger(card.endTime) || seen.has(card.type)) throw new Error('月卡有效期或类型未确认');
      seen.add(card.type);
      if (card.endTime !== -1 && card.endTime <= now) continue;
      const id = card.type === protocol.MonthCardType?.MONTH_CARD_NORMAL ? '普通月卡'
        : card.type === protocol.MonthCardType?.MONTH_CARD_SENIOR ? '高级月卡' : null;
      const row = config?.tables?.MonthCardCfg?.data?.find(row => id && row.id === id);
      if (!Array.isArray(row?.effectList)) throw new Error('有效月卡权益配置未确认');
      for (const pair of row.effectList) if (pair?.[0] === '装备工厂自动锻造') {
        if (!Number.isFinite(pair[1]) || pair[1] < 0) throw new Error('自动锻造月卡权益未确认');
        effect += pair[1];
      }
    }
    return effect > 0 ? '' : '缺少有效的装备工厂自动锻造月卡权益';
  } catch (error) { return '原生自动锻造不可开启：' + error.message; }
}

export function ownedNativeForgeRecords(snapshot, keys) {
  return Object.entries(keys).filter(([key, record]) => record.details?.kind === 'forgeNative'
    && key === nativeForgeKey(snapshot, record.details.buildingId)
    && record.details.playerId === snapshot.playerId && record.details.worldId === snapshot.worldId);
}

export function reconcileNativeForge(snapshot, ledger) {
  if (snapshot.reason) return;
  for (const [key, record] of ownedNativeForgeRecords(snapshot, ledger.keyRecords())) {
    const building = snapshot.buildings.find(row => row.buildingId === record.details.buildingId);
    if (!building) continue;
    if (building.auto === true && !record.confirmed) ledger.resolveKey(key, true);
    // An unknown enable stays locked until observed on, or an explicit disable
    // is sent and confirmed. A confirmed enable may be retired after manual off.
    else if (building.auto === false && record.confirmed) ledger.releaseCompletedKey(key);
  }
}

export async function runNativeForgeStep(client, protocol, snapshot, step, ledger, read, current) {
  if (!protocol.SetBuildingAutoWorkRequest) throw new Error('当前协议缺少原生自动锻造开关');
  let ticket;
  if (step.body.isOn) ticket = ledger.reserve({}, {}, {}, { uniqueKey: step.uniqueKey,
    details: { kind: 'forgeNative', buildingId: step.buildingId, playerId: snapshot.playerId, worldId: snapshot.worldId, isOn: true } });
  if (!current()) { if (ticket) ledger.cancel(ticket); return { step, ok: false, skipped: true, status: 'cancelled' }; }
  let writePending = true;
  try {
    await client.sendWatch('SetBuildingAutoWorkRequest', step.body, { window: 600 });
    writePending = false;
    if (!current()) throw new Error('连接或配置已变化，等待下轮回读');
    const after = await read();
    const building = after.buildings.find(row => row.buildingId === step.buildingId);
    const confirmed = current() && !after.reason && building?.auto === step.body.isOn;
    if (confirmed) {
      ledger.resolveKey(step.uniqueKey, true);
      if (!step.body.isOn) ledger.releaseCompletedKey(step.uniqueKey);
    }
    return { step, ok: confirmed, sent: true, status: confirmed ? 'confirmed' : 'unknown', note: confirmed
      ? (step.body.isOn ? '已确认开启游戏原生自动锻造，领取与制作由游戏处理' : '已确认关闭游戏原生自动锻造，下轮按工具配置检查')
      : '原生自动锻造开关结果待确认，暂停工具领取、下单和分解' };
  } catch (error) {
    const refused = writePending && (error.notSent === true || error.prompt && error.request === 'SetBuildingAutoWorkRequest');
    if (refused && ticket) ledger.cancel(ticket);
    return { step, ok: false, skipped: error.notSent === true && writePending,
      status: refused ? (error.notSent ? 'cancelled' : 'rejected') : 'unknown', error: error.message };
  }
}
