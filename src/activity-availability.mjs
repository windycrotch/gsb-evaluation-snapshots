// 官方 2026-11-04 活动预告：联动执行活动截至 11-11，满减商店另至 11-13。
// https://game.xiaomi.com/viewpoint/1672495402_1793764138459_100
// 只管理配置可见性和实际调度，不删除任务或修改用户保存的历史开关。
export const activityRetirements = [{
  id: 'linkage-lsr-202611',
  label: '酆都诡事、龙王罗盘与走江踏浪',
  retiredAt: Date.parse('2026-11-12T00:00:00+08:00'),
  // 每组是同一期活动内需要同时开放的子活动；组与组之间为任选其一。
  tasks: {
    riverScore: [[27]], riverPass: [[27]], riverHelp: [[27]],
    edictPass: [[29]], compassDaily: [[28, 10]], compassAdGift: [[28, 10]],
    compassSpin: [[28]], festivalSign: [[11]], festivalFreeGift: [[6]],
    festivalActive: [[11]], festivalGifts: [[6], [10]], snowballFree: [[27]],
    festivalActiveRewards: [[11]], evilExpel: [[30]], edict: [[29]], compassReward: [[28]],
  },
}];

const taskRules = new Map(activityRetirements.flatMap(rule =>
  Object.entries(rule.tasks).map(([key, alternatives]) => [key, { retiredAt: rule.retiredAt, alternatives }])));

// 时间戳通常是 number；也接收协议解码留下的 int64，拒绝失真或无效数值。
function integer(value) {
  if (Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const result = Number(value);
    return Number.isSafeInteger(result) ? result : null;
  }
  if (Number.isInteger(value?.low) && Number.isInteger(value.high)) {
    const high = value.unsigned ? value.high >>> 0 : value.high;
    const result = Number((BigInt(high) << 32n) + BigInt(value.low >>> 0));
    return Number.isSafeInteger(result) ? result : null;
  }
  return null;
}

function optionalTime(value, fallback) {
  if (value == null) return fallback;
  const time = integer(value);
  return time === 0 ? fallback : time;
}

const linkageRewardTasks = new Set(['festivalSign', 'festivalFreeGift', 'festivalActive', 'festivalActiveRewards']);
export function festivalTaskWindow(row, sub) {
  const start = integer(row?.startTime), end = integer(row?.endTime);
  const parentOpen = optionalTime(row?.openTime, start);
  const parentClose = optionalTime(row?.closeTime, end);
  const open = optionalTime(sub?.openTime, parentOpen), close = optionalTime(sub?.closeTime, end);
  if (!(start > 0 && end > start && parentOpen > 0 && parentClose > parentOpen && open > 0 && close > open)) return null;
  const startTime = Math.max(start, parentOpen, open), endTime = Math.min(end, parentClose, close);
  return endTime > startTime ? { startTime, endTime } : null;
}

function hasOpenFestival(client, taskKey, alternatives, now) {
  return (Array.isArray(client?.festivals) ? client.festivals : []).some(row => {
    const subs = Array.isArray(row?.subActivity) ? row.subActivity : [];
    const namedLinkage = row?.type === '捞尸人联动活动';
    // 6/10/11 是多个节日共用的子类型，不能据此认定联动复开。
    // 此身份规则与 claimLinkageFree / claimFestivalActive 保持一致。
    const linked = namedLinkage || subs.some(sub => [28, 29, 30].includes(integer(sub?.subActivityType)));
    if (linkageRewardTasks.has(taskKey) && !linked) return false;
    const openTypes = new Set(subs.filter(sub => {
      if (!sub || typeof sub !== 'object') return false;
      const window = festivalTaskWindow(row, sub, taskKey);
      return window && window.startTime <= now && now < window.endTime;
    }).map(sub => integer(sub.subActivityType)));
    return alternatives.some(required => {
      // 旧 festivalGifts 的自选礼包仅有已核验的命名配置表；别名只接管 6 的联动特惠。
      if (taskKey === 'festivalGifts' && !namedLinkage && !(linked && required.includes(6))) return false;
      return required.every(type => openTypes.has(type));
    });
  });
}

export function isActivityTaskAvailable(taskKey, client = null) {
  const rule = taskRules.get(taskKey);
  if (!rule) return true;
  const offset = Number.isFinite(client?.serverClockOffsetMs) ? client.serverClockOffsetMs : 0;
  const now = Date.now() + offset;
  return !client && now < rule.retiredAt || hasOpenFestival(client, taskKey, rule.alternatives, now / 1000);
}

const weeklyTasks = {
  1: ['weekPass'], 2: ['weekCharge'], 3: ['weekHeroStar'],
  4: ['weekGift', 'weekTimes', 'weekLotterySpin'], 5: ['weekOrderSubmit', 'weekOrderFinal'],
  6: ['weekChipFree', 'weekSupplyFree'], 7: ['weekUniqueFree', 'weekSupplyFree'],
};
const timedTasks = {
  tradeWindow: ['merchantTrade', 'merchantRewards', 'tradeTasks'],
  beautyWindow: ['beautyGift', 'beautyVotes'],
};
export const activityTimeTasks = [...new Set([
  ...taskRules.keys(), ...Object.values(weeklyTasks).flat(), ...Object.values(timedTasks).flat(), 'newbieLogin',
])];

// Only live connection snapshots supply execution deadlines. The display archive
// never feeds this clock, and a valid child window is clipped to its parent.
export function nextActivityBoundary(client, enabled = () => true, after = Date.now()) {
  const offset = Number.isFinite(client?.serverClockOffsetMs) ? client.serverClockOffsetMs : 0;
  let next = Infinity;
  const add = (start, end) => {
    if (!(start > 0 && end > start)) return;
    for (const seconds of [start, end]) {
      const at = seconds * 1000 - offset;
      if (Number.isSafeInteger(at) && at > after) next = Math.min(next, at);
    }
  };
  for (const row of Array.isArray(client?.festivals) ? client.festivals : []) {
    const subs = Array.isArray(row?.subActivity) ? row.subActivity : [];
    for (const [key, rule] of taskRules) {
      if (!enabled(key)) continue;
      const types = new Set(rule.alternatives.flat());
      for (const sub of subs) {
        if (!types.has(integer(sub?.subActivityType))) continue;
        const window = festivalTaskWindow(row, sub, key);
        if (window) add(window.startTime, window.endTime);
      }
    }
  }
  for (const row of Array.isArray(client?.weekActivities) ? client.weekActivities : []) {
    if ((weeklyTasks[integer(row?.type)] ?? []).some(enabled)) add(integer(row.startTime), integer(row.endTime));
  }
  for (const [field, keys] of Object.entries(timedTasks)) {
    if (keys.some(enabled)) add(integer(client?.[field]?.startTime), integer(client?.[field]?.endTime));
  }
  if (enabled('newbieLogin')) {
    const start = integer(client?.newbieActivity?.startTime);
    const end = optionalTime(client?.newbieActivity?.finishTime, Infinity);
    if (start > 0 && end > start) add(start, Math.min(Math.floor((start + 28800) / 86400) * 86400 - 28800 + 7 * 86400, end));
  }
  return next;
}

export function activityAvailability(client = null) {
  const hiddenTasks = [...taskRules.keys()].filter(key => !isActivityTaskAvailable(key, client));
  const hiddenFields = hiddenTasks.map(key => 'schedule.' + key);
  if (hiddenTasks.includes('compassSpin')) hiddenFields.push('eventActions.compassThreshold', 'eventActions.compassDrawCount');
  return { hiddenTasks, hiddenFields };
}
