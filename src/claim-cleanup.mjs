import { AutomationSkip, exactAutomationId, automationWireId } from './automation-policy.mjs';

const activeClients = new WeakSet();
const activeRecords = new Set();
const zero = value => value === 0 || value === '0' || (value?.low === 0 && value?.high === 0);
const baseLevel = value => value === 0 || value === 1;

function markUsed(used, uid) {
  if (zero(uid)) return;
  const id = exactAutomationId(uid);
  if (!id) throw Error('占用标识未同步');
  used.add(id);
}

function inventoryMap(rows) {
  if (!Array.isArray(rows)) throw Error('库存未同步');
  const inventory = new Map();
  for (const row of rows) {
    const id = exactAutomationId(row.uid);
    if (!id || inventory.has(id)) throw Error('库存标识不完整');
    inventory.set(id, row);
  }
  return inventory;
}

async function eligibleItems(read, config, equipment, qualities) {
  const used = new Set();
  let inventory, definitions;
  if (equipment) {
    const heroes = (await read('AllHero')).heroes;
    if (!Array.isArray(heroes) || !heroes.length) throw Error('英雄列表未同步');
    for (const hero of heroes) {
      if (!Array.isArray(hero.equips)) throw Error('装备归属未同步');
      for (const item of hero.equips) markUsed(used, item.uid);
    }
    inventory = inventoryMap((await read('Equips')).equip);
    definitions = new Map(config.tables.EquipCfg.data.map(row => [row.id, row.quality]));
  } else {
    const buildings = (await read('OnWater')).building;
    if (!Array.isArray(buildings) || !buildings.length) throw Error('海兽值守未同步');
    for (const building of buildings) {
      if (building.petServe) markUsed(used, building.petServe.petUid);
      if (building.fleet?.formation) markUsed(used, building.fleet.formation.petUid);
    }
    const main = (await read('GetFormation', { module: 1 })).formation;
    if (main) markUsed(used, main.petUid);
    // 当前协议没有 LeagueFormationRequest，本人的编队由 LeagueInfoResponse 返回。
    const teams = (await read('LeagueInfo')).ownFormations;
    if (!Array.isArray(teams)) throw Error('积分赛编队未同步');
    for (const team of teams) markUsed(used, team.petUid);
    inventory = inventoryMap((await read('AllPet')).pets);
    definitions = new Map(config.tables.PetBreedCfg.data.map(row => [row.petId, row.quality]));
  }
  const eligible = new Set();
  for (const [id, item] of inventory) {
    const quality = definitions.get(equipment ? item.equipId : item.petId);
    if (!qualities.includes(quality) || used.has(id) || !baseLevel(item.level) || item.rerollAttrs?.length) continue;
    if (equipment) {
      if (item.refineLv === 0 && !(item.attr ?? []).some(attr => attr.rating > 0)) eligible.add(id);
      continue;
    }
    // 蓝紫橙海兽的 0–5 星由培育随机获得。红色出生为 0 星，升星属于养成。
    const naturalStar = Number.isInteger(item.star) && item.star >= 0 && item.star <= 5 && (quality !== 'RED' || item.star === 0);
    if (naturalStar && item.grade === 0 && !item.extAttrs?.length && !item.extAttrs2?.length
      && !item.profFeed?.some(feed => feed.attrFeed?.some(attr => attr.times > 0))) eligible.add(id);
  }
  return { inventory, eligible };
}

// 兼容原领取后入口，也可由每轮检查调用。重试始终限定原来的精确 UID。
export async function cleanupAfterClaim(client, config, settings, ledger, kind, enabled) {
  const equipment = kind === 'forge';
  const prefix = equipment ? 'equip-dispose:' : 'pet-release:';
  const group = settings[kind];
  const toggle = equipment ? 'decompose' : 'release';
  const choice = equipment ? 'decomposeQualities' : 'releaseQualities';
  if (!group?.[toggle] || !group[choice]?.length || !ledger || !enabled() || activeClients.has(client)) return null;
  const qualities = [...group[choice]];
  const epoch = client.connectionEpoch, socket = client.socket, login = client.login;
  const active = () => enabled() && client.connected && client.connectionEpoch === epoch
    && client.socket === socket && client.login === login && settings[kind] === group
    && group[toggle] && JSON.stringify(group[choice]) === JSON.stringify(qualities);
  const label = equipment ? '装备自动分解' : '海兽自动放生';
  const inventoryName = equipment ? 'Equips' : 'AllPet';
  const inventoryField = equipment ? 'equip' : 'pets';
  const held = new Set();
  const records = Object.entries(ledger.keyRecords()).filter(([key, record]) => key.startsWith(prefix) && !record.confirmed);
  const previousKeys = new Set(records.map(([key]) => key));
  const blocked = new Set();
  for (const [key, record] of records) {
    if (activeRecords.has(record.id)) blocked.add(key.slice(prefix.length));
    else { activeRecords.add(record.id); held.add(record.id); }
  }
  const read = async (name, body = {}) => {
    if (!active()) throw new AutomationSkip('清理已暂停或账号连接、设置已变化');
    const reply = await client.request(name + 'Request', body, name + 'Response', 8000);
    if (!active()) throw new AutomationSkip('清理已暂停或账号连接、设置已变化');
    return reply;
  };
  let reconciled = 0, protectedCount = 0;
  const reconcile = inventory => {
    for (const [key, record] of Object.entries(ledger.keyRecords())) {
      if (!key.startsWith(prefix) || record.confirmed || inventory.has(key.slice(prefix.length))
        || (activeRecords.has(record.id) && !held.has(record.id))) continue;
      // UID 不复用，保留已确认标记，避免旧库存短暂回显后重新发送。
      ledger.resolveKey(key, true, { ...record.details, uid: key.slice(prefix.length), reason: '原 UID 已不在完整库存，清理结果已确认' });
      if (previousKeys.has(key)) reconciled++;
    }
  };
  const recoveryNote = () => [reconciled ? `原 UID 已不在库存，核销 ${reconciled} 项旧记录` : '',
    protectedCount ? `按当前占用、品质或养成状态保留 ${protectedCount} 项，解除旧记录` : ''].filter(Boolean).join('，');
  activeClients.add(client);
  try {
    if (records.length) reconcile(inventoryMap((await read(inventoryName))[inventoryField]));
    const before = await eligibleItems(read, config, equipment, qualities);
    const fresh = await eligibleItems(read, config, equipment, qualities);
    reconcile(fresh.inventory);
    const currentRecords = ledger.keyRecords();
    for (const [key, record] of Object.entries(currentRecords)) {
      if (!key.startsWith(prefix) || record.confirmed || !fresh.inventory.has(key.slice(prefix.length))
        || (activeRecords.has(record.id) && !held.has(record.id))) continue;
      const id = key.slice(prefix.length);
      if (before.eligible.has(id) && fresh.eligible.has(id)) continue;
      ledger.cancel({ id: record.id });
      protectedCount++;
    }
    const ids = [...before.eligible].filter(id => fresh.eligible.has(id) && !blocked.has(id));
    const entries = [];
    try {
      for (const id of ids) {
        const key = prefix + id;
        const record = ledger.keyRecords()[key];
        if (record?.confirmed || (record && activeRecords.has(record.id) && !held.has(record.id))) continue;
        const details = { kind: equipment ? 'equipDispose' : 'petRelease', uid: id,
          attempts: (Number.isSafeInteger(record?.details?.attempts) ? record.details.attempts : 0) + 1,
          reason: record ? '原 UID 仍在库存，两次复核均可处理，重试原 UID' : '两次复核均可处理',
          lastAttemptAt: Date.now() };
        const reused = Boolean(record);
        const ticket = reused ? { id: record.id } : ledger.reserve({}, {}, {}, { uniqueKey: key, details });
        if (reused) ledger.updateKeyDetails(key, details);
        activeRecords.add(ticket.id); held.add(ticket.id);
        entries.push({ id, key, ticket, reused, details });
      }
    } catch (error) {
      for (const entry of entries) if (!entry.reused) ledger.cancel(entry.ticket);
      throw error;
    }
    if (!active()) {
      for (const entry of entries) if (!entry.reused) ledger.cancel(entry.ticket);
      return null;
    }
    if (!entries.length) return recoveryNote() ? { label, ok: true, status: 'confirmed', note: recoveryNote() } : null;
    const name = equipment ? 'DecomposeEquipRequest' : 'FreePetRequest';
    const bodyIds = entries.map(entry => automationWireId(entry.id));
    let writePending = true;
    try {
      if (equipment) await client.request(name, { uid: bodyIds }, 'DecomposeEquipResponse', 8000);
      else await client.sendWatch(name, { petUid: bodyIds }, { window: 600 });
      writePending = false;
      const remaining = inventoryMap((await read(inventoryName))[inventoryField]);
      const confirmed = entries.filter(entry => !remaining.has(entry.id)).length;
      reconcile(remaining);
      return { label, ok: confirmed === entries.length, status: confirmed === entries.length ? 'confirmed' : 'unknown',
        note: [`库存核对 ${confirmed}/${entries.length}`, entries.some(entry => entry.reused) ? '已复核并重试原 UID' : '', recoveryNote()].filter(Boolean).join('，') };
    } catch (error) {
      const notSent = writePending && error.notSent === true;
      const rejected = writePending && error.prompt && error.request === name;
      if (notSent || rejected) {
        for (const entry of entries) {
          if (!entry.reused) ledger.cancel(entry.ticket);
          else ledger.updateKeyDetails(entry.key, { ...entry.details, reason: notSent ? '本次重试明确未发送，保留上次待确认记录' : '本次重试被拒绝，保留上次待确认记录' });
        }
        return { label, ok: false, status: notSent ? 'not-sent' : 'rejected', error: error.message, note: recoveryNote() };
      }
      return { label, ok: false, status: 'unknown', error: '结果待确认，保留原 UID 记录，后续读取库存复核', note: recoveryNote() };
    }
  } catch (error) {
    return { label, ok: false, ...(error.code === 'AUTOMATION_SKIP' ? { skipped: true } : {}), error: error.message };
  } finally {
    activeClients.delete(client);
    for (const id of held) activeRecords.delete(id);
  }
}
