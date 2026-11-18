import { exactAutomationId } from './automation-policy.mjs';
import { createGuildNameResolver } from './guild-name.mjs';
import { siliconOpeningReason } from './silicon-mining.mjs';

const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const serverNow = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const identity = player => [player?.worldId, player?.playerId, player?.guildId].map(exactAutomationId).join(':');
function quantity(value) {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return integer(number) ? number : null;
}
function rewardInfo(value) {
  if (!value || !integer(value.myRewardTimes) || !integer(value.maxRewardTimes) || !integer(value.rewardResetTime, 1)) return null;
  return { claimed: value.myRewardTimes, max: value.maxRewardTimes, resetAt: value.rewardResetTime,
    remaining: Math.max(0, value.maxRewardTimes - value.myRewardTimes) };
}

// 独立只读视图：不依赖自动化开关、汽油余额或合服派遣条件，不生成或执行动作。
export async function readSiliconOverview(client, protocol, config, player, { enabled = () => true } = {}) {
  const view = { checkedAt: serverNow(client), reason: '', notes: [], reward: null, fights: null,
    fleetsSynced: false, fleets: [], mines: [] };
  view.reason = siliconOpeningReason(config, player, view.checkedAt);
  if (view.reason) return view;
  const owner = identity(player), ownGuild = Number(BigInt(exactAutomationId(player.guildId) ?? '0') % 1000n);
  const check = () => {
    if (!enabled() || !client.connected || identity(player) !== owner) throw Error('账号连接或角色已变化，请重新读取硅矿');
  };
  const get = async (name, body = {}) => {
    check();
    if (!protocol?.[name + 'Request'] || !protocol?.[name + 'Response']) throw Error('当前协议未提供硅矿信息');
    const result = await client.request(name + 'Request', body, name + 'Response', 8000);
    check();
    return result;
  };
  const safe = async (name, label) => {
    try { return await get(name); }
    catch { check(); view.notes.push(label + '未同步，可稍后刷新'); return null; }
  };
  const [list, reward, own, guildList] = await Promise.all([
    safe('ChipMineList', '矿区列表'), safe('ChipMineReward', '奖励额度'), safe('MyFleets', '舰队状态'),
    safe('AllGuildAbstraction', '联盟名称'),
  ]);
  const guildName = createGuildNameResolver(config, player.scenarioId, guildList?.guilds);
  view.reward = rewardInfo(reward?.rewardInfo);
  let cycleChanged = false;
  const types = config?.tables?.ChipMineCfg?.data ?? [];
  const seen = new Set();
  for (const raw of Array.isArray(list?.chipMines) ? list.chipMines : []) {
    const type = types.find(row => row.qualityIndex === raw.color && ['BLUE', 'PURPLE', 'ORANGE'].includes(row.quality));
    if (!type || !integer(raw.gridId, 1) || seen.has(raw.gridId)) { view.notes.push('部分矿区信息不完整'); continue; }
    seen.add(raw.gridId);
    const mine = { gridId: raw.gridId, tier: type.quality, name: type.name, personal: type.quality === 'BLUE',
      positionCount: null, occupied: null, empty: null, positions: [], reason: '',
      rewards: (type.reward ?? []).filter(row => Array.isArray(row) && typeof row[0] === 'string' && integer(row[1], 1))
        .map(([id, num]) => ({ name: config.materialName?.(id) || id, num })) };
    view.mines.push(mine);
    // ChipMineResponse 没有 gridId；与客户端一致，逐矿读取，不能并发配对。
    try {
      const detail = await get('ChipMine', { gridId: raw.gridId });
      if (!Array.isArray(detail?.occupiedPositions) || !integer(detail.positionNum) || !integer(detail.occupiedNum)
        || !integer(detail.fightTimes) || !integer(detail.maxFightTimes)) throw Error('矿位信息不完整');
      const currentReward = rewardInfo(detail.rewardInfo);
      if (currentReward) {
        if (view.reward && currentReward.resetAt !== view.reward.resetAt) cycleChanged = true;
        else view.reward = { ...currentReward, claimed: Math.max(view.reward?.claimed ?? 0, currentReward.claimed),
          max: Math.min(view.reward?.max ?? currentReward.max, currentReward.max) };
      }
      view.fights = { used: Math.max(view.fights?.used ?? 0, detail.fightTimes),
        max: Math.min(view.fights?.max ?? detail.maxFightTimes, detail.maxFightTimes) };
      const positions = detail.occupiedPositions.filter(position => position.player).map((position, offset) => {
        const p = position.player, power = quantity(p.power);
        if (!integer(position.index) || !integer(p.guildIdx) || !integer(p.rewardTimes) || power === null
          || typeof p.nickname !== 'string') throw Error('占领玩家信息不完整');
        const guild = guildName(p.guildIdx);
        return { index: position.index, displayIndex: mine.personal ? offset : position.index,
          player: { nickname: p.nickname, power, guildIdx: p.guildIdx, guildName: p.guildIdx === 0 ? '无联盟' : guild.name,
            guildDefaultName: guild.defaultName,
            rewardTimes: p.rewardTimes, fleetId: p.fleetId || '',
            relation: p.fleetId ? 'self' : ownGuild > 0 && p.guildIdx === ownGuild ? 'ally' : 'other' } };
      });
      const capacity = mine.personal ? 3 : detail.positionNum;
      if (positions.some(position => position.displayIndex >= capacity)
        || new Set(positions.map(position => position.index)).size !== positions.length
        || !mine.personal && (detail.occupiedNum > capacity || positions.length !== detail.occupiedNum)) throw Error('矿位数量发生变化，请刷新');
      mine.positionCount = capacity;
      mine.occupied = mine.personal ? positions.length : detail.occupiedNum;
      mine.empty = capacity - mine.occupied;
      mine.positions = positions;
    } catch (error) { check(); mine.reason = error.message; }
  }
  if (cycleChanged) { view.reward = null; view.notes.push('读取期间奖励周期发生变化，请刷新确认新周期额度'); }
  if (view.reward) view.reward.remaining = Math.max(0, view.reward.max - view.reward.claimed);
  if (view.fights) view.fights.remaining = Math.max(0, view.fights.max - view.fights.used);
  if (!view.reward) view.notes.push('奖励额度未同步，不推测已领取次数');
  if (!view.mines.length) view.reason = Array.isArray(list?.chipMines) ? '当前没有可展示的硅矿' : '矿区列表未同步，请稍后刷新';
  view.mines.sort((a, b) => ['BLUE', 'PURPLE', 'ORANGE'].indexOf(a.tier) - ['BLUE', 'PURPLE', 'ORANGE'].indexOf(b.tier) || a.gridId - b.gridId);
  view.fleetsSynced = Array.isArray(own?.fleets);
  view.fleets = (view.fleetsSynced ? own.fleets : []).filter(fleet => /^\d+远征船$/.test(fleet.buildingId)).map(fleet => {
    const slot = view.mines.filter(mine => !mine.reason).flatMap(mine => mine.positions.map(position => ({ mine, position })))
      .find(row => row.position.player.fleetId === fleet.buildingId);
    const target = view.mines.find(mine => mine.gridId === fleet.targetGridIdx);
    const mining = fleet.state === 5 && !!fleet.chipWar;
    const status = mining ? '采矿中' : ({ 1: fleet.curGridIdx ? '驻守中' : '空闲', 2: target ? '前往硅矿' : '行军中', 3: '战斗中', 4: '维修中', 5: '排队中' })[fleet.state] || '状态未同步';
    const timerKind = mining ? 'reward' : fleet.state === 2 ? 'arrival' : fleet.state === 4 ? 'repair' : null;
    const end = mining ? fleet.chipWar?.rewardTs : fleet.state === 2 ? fleet.moveEndTs : fleet.state === 4 ? fleet.repairing?.endTs : null;
    return { id: fleet.buildingId, name: fleet.buildingId.replace('远征船', '号舰队'), status, mining,
      mineId: slot?.mine.gridId ?? target?.gridId ?? null, mineName: slot?.mine.name ?? target?.name ?? null,
      slot: slot ? slot.position.displayIndex + 1 : null, power: quantity(fleet.power),
      durability: quantity(fleet.durability), maxDura: quantity(fleet.maxDura),
      collected: slot?.position.player.rewardTimes ?? null,
      retreatAllowed: slot && mining && fleet.curGridIdx === slot.mine.gridId ? slot.position.player.rewardTimes > 0 : null,
      timerKind, endAt: integer(end, 1) ? end : null };
  });
  check();
  view.checkedAt = serverNow(client);
  view.notes = [...new Set(view.notes)];
  return view;
}
