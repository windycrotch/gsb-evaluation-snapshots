import { exactAutomationId, AutomationSkip } from './automation-policy.mjs';
import { toNumber } from './client.mjs';

// CrossRank is the daily competition. WeekInfo describes unrelated weekly packs.
export const WEEKLY_SUBJECTS = {
  6: { kind: 'farm', label: '种田发育' }, 3: { kind: 'pet', label: '海兽培养' },
  4: { kind: 'antique', label: '藏品培养' }, 1: { kind: 'order', label: '基地订单' },
  2: { kind: 'forge', label: '装备打造' }, 5: { kind: 'hero', label: '英雄培养' },
};
const nowOf = client => (Date.now() + (client.serverClockOffsetMs || 0)) / 1000;
const dayOf = seconds => Math.floor((seconds + 28800) / 86400);
const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const valid = value => Number.isSafeInteger(value) && value >= 0;
// Managed actions run only through the competition runner. This also closes
// legacy/fast-loop paths while waiting for another weekday or score reset.
const managedCache = new WeakMap();
export function weeklyLegacyTaskAllowed(settings, key) {
  const p = settings?.weeklyActivity;
  if (!p?.enabled) return true;
  if (p.farmEnabled && key === 'guildOrders') return false;
  if (p.petEnabled && ['petCollect', 'petBreed'].includes(key)) return false;
  if (p.heroEnabled && ['ticketRecruit', 'heroGrowth'].includes(key)) return false;
  if (p.orderEnabled && ['cargo', 'adSpeedUpProduce'].includes(key)) return false;
  return true;
}
export function weeklyManagedSettings(settings) {
  const p = settings?.weeklyActivity;
  if (!p?.enabled) return settings;
  if (managedCache.has(settings)) return managedCache.get(settings);
  const next = structuredClone(settings);
  if (p.farmEnabled) {
    next.farm.enabled = false;
    next.alliance.recruit = false;
    next.schedule.guildOrders = false;
  }
  if (p.petEnabled) {
    next.pet.enabled = false;
    next.schedule.petCollect = next.schedule.petBreed = false;
  }
  if (p.antiqueEnabled) next.antique.enabled = false;
  if (p.orderEnabled) {
    next.resident.enabled = false;
    next.cargo.enabled = false;
    next.factory.speedUp = false;
    next.factory.speedUpSources = [];
    next.schedule.adSpeedUpProduce = false;
  }
  // 原生模式由游戏持续执行，周活动的积分目标不能控制它。
  if (p.forgeEnabled && !settings.forge.nativeAuto) next.forge.enabled = false;
  if (p.heroEnabled) {
    next.loop.heroes = false;
    next.schedule.ticketRecruit = false;
  }
  managedCache.set(settings, next);
  return next;
}

export function weeklyExecutionSettings(settings, kind) {
  const next = structuredClone(settings), p = next.weeklyActivity;
  next.loop.world = true;
  if (kind === 'farm') {
    next.farm.enabled = true;
    next.farm.speedUp = p.farmSpeedUp;
  } else if (kind === 'pet') {
    next.pet.enabled = next.pet.claim = next.pet.breed = true;
  } else if (kind === 'antique') next.antique.enabled = true;
  else if (kind === 'order') next.resident.enabled = true;
  else if (kind === 'forge') next.forge.enabled = true;
  else if (kind === 'hero') next.loop.heroes = next.heroes.enabled = true;
  return next;
}

function unlocked(client, config, player) {
  const level = rows(config, 'ModuleOpenCfg').find(row => row.moduleId === '每日跨服比拼')?.playerLevel;
  if (!valid(level) || !valid(player?.level) || player.level < level) return false;
  const world = exactAutomationId(player.worldId);
  const season = world ? Number(BigInt(world) / 1000000n % 1000n) : 0;
  if (season > 1) return true;
  const minimum = rows(config, 'CrossRankParamCfg').find(row => row.paramName === '每日跨服比拼开启')?.paramValue;
  return season === 1 && valid(minimum) && minimum > 0 && valid(player.worldOpenTime) && player.worldOpenTime > 0
    && dayOf(nowOf(client)) - dayOf(player.worldOpenTime) + 1 >= minimum;
}

export async function createWeeklyActivityContext(client, config, player, { getSettings, enabled = () => true, report = () => {} }) {
  const source = getSettings(), pref = source?.weeklyActivity;
  const waiting = reason => { report({ label: '军备竞赛', skipped: true, reason }); return null; };
  if (!pref?.enabled || !enabled() || client.connected === false) return null;
  if (!Object.values(WEEKLY_SUBJECTS).some(({ kind }) => pref[kind + 'Enabled'])) return waiting('尚未选择参与的每日活动');
  if (!unlocked(client, config, player)) return waiting('军备竞赛尚未开放或开放条件未同步');
  const read = () => client.request('CrossRankInfoRequest', {}, 'CrossRankInfoResponse');
  const initial = await read(), subject = WEEKLY_SUBJECTS[initial?.subjectId];
  if (!subject) return waiting(initial?.subjectId === 7 ? '今日城战杀敌，按世界中的联盟城战配置执行' : '今日活动主题尚未同步');
  const { kind, label } = subject;
  if (!pref[kind + 'Enabled']) return waiting('今日' + label + '未开启');
  const startedDay = dayOf(nowOf(client));
  const playerId = exactAutomationId(player?.playerId), worldId = exactAutomationId(player?.worldId);
  const identityCurrent = () => playerId && worldId && playerId === exactAutomationId(player?.playerId) && worldId === exactAutomationId(player?.worldId);
  let stopped = false;
  const current = () => !stopped && enabled() && client.connected !== false && getSettings() === source && identityCurrent()
    && dayOf(nowOf(client)) === startedDay;
  function reason(state) {
    if (!current()) return '活动日期或配置已变更，或挂机已暂停';
    if (state?.grouping !== false || !valid(state.roomLevel) || state.roomLevel < 1
      || state.subjectId !== initial.subjectId || !Number.isFinite(state.settleTime) || state.settleTime <= nowOf(client)
      || state.settleTime !== initial.settleTime) return '活动分组、主题或结算时间已变化，等待下一轮';
    if (pref[kind + 'Stop'] === 'score') {
      const target = pref[kind + 'Score'];
      const mine = Array.isArray(state.rankList) ? state.rankList.filter(row => exactAutomationId(row.playerId) === playerId) : [];
      const score = mine.length === 1 ? toNumber(mine[0].score) : NaN;
      if (!valid(target) || target < 1 || !valid(score)) return '无法确认本人积分或目标积分，暂停消费';
      if (score >= target) return label + '已达目标积分（' + score + '/' + target + '）';
    }
    return null;
  }
  const blocked = reason(initial);
  if (blocked) return waiting(blocked);
  const settings = weeklyExecutionSettings(source, kind);
  return { kind, label, settings, getSettings: () => settings, enabled: current, report,
    async beforeAction() {
      try {
        const blocked = !current() ? '活动已暂停或日期已变化' : reason(await read());
        if (blocked) throw new AutomationSkip(blocked);
      } catch (error) {
        stopped = true;
        throw Object.assign(error, { notSent: true, code: 'AUTOMATION_SKIP' });
      }
    },
  };
}

// Recheck the daily subject at Beijing midnight, even with a long loop interval.
export function nextWeeklyActivityBoundary(client, settings, afterMs = Date.now()) {
  const p = settings?.weeklyActivity;
  if (!p?.enabled) return Infinity;
  const offset = client.serverClockOffsetMs || 0, seconds = (afterMs + offset) / 1000;
  const midnight = dayOf(seconds) * 86400 - 28800;
  return (midnight + 86400) * 1000 - offset;
}
