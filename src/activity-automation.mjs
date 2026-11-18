// Activity gates preserve the saved action switches across periods.
export const activityAutomationFields = [
  { key: 'merchant.enabled', label: '海商王', taskKeys: ['merchantTrade', 'merchantRewards', 'tradeTasks'] },
  { key: 'weekOrder.enabled', label: '不差钱商人', taskKeys: ['weekOrderSubmit', 'weekOrderFinal'] },
  { key: 'heroRaid.enabled', label: '超凡英雄活动', taskKeys: ['heroRaid.enabled'] },
  { key: 'guildShip.enabled', label: '联盟商船', taskKeys: ['guildShip.enabled'] },
  { key: 'activityAutomation.weekPass', label: '勇士战令', taskKeys: ['weekPass'] },
  { key: 'activityAutomation.weekCharge', label: '累计充值', taskKeys: ['weekCharge'] },
  { key: 'activityAutomation.weekHeroStar', label: '英雄升星', taskKeys: ['weekHeroStar'] },
  { key: 'activityAutomation.weekLottery', label: '幸运转盘', taskKeys: ['weekGift', 'weekTimes', 'weekLotterySpin'] },
  { key: 'activityAutomation.weekChip', label: '芯片活动', taskKeys: ['weekChipFree'] },
  { key: 'activityAutomation.weekUnique', label: '周翻牌', taskKeys: ['weekUniqueFree'] },
  { key: 'activityAutomation.compass', label: '龙王罗盘', taskKeys: ['compassSpin', 'compassReward'] },
  { key: 'activityAutomation.edict', label: '酆都法旨', taskKeys: ['edict', 'edictPass'] },
  { key: 'activityAutomation.evilExpel', label: '驱邪除祟', taskKeys: ['evilExpel'] },
  { key: 'activityAutomation.festivalDaily', label: '每日签到与活跃', taskKeys: ['festivalSign', 'festivalActive', 'festivalActiveRewards'] },
  { key: 'activityAutomation.festivalGifts', label: '每日免费礼包', taskKeys: ['festivalGifts', 'festivalFreeGift', 'compassDaily', 'compassAdGift'] },
  { key: 'activityAutomation.river', label: '走江踏浪', taskKeys: ['riverScore', 'riverPass', 'riverHelp', 'snowballFree'] },
  { key: 'activityAutomation.newbie', label: '新手七日登录', taskKeys: ['newbieLogin'] },
  { key: 'activityAutomation.beauty', label: '海上风采大赛', taskKeys: ['beautyVotes', 'beautyGift'], fields: [
    { key: 'schedule.beautyVotes', label: '每天投给当前最高票选手', taskKeys: ['beautyVotes'],
      help: '限时活动，每天投够3票即停；已投票数计入目标，同票按编号升序选择。' },
    { key: 'schedule.beautyGift', label: '领取每日投票礼包', taskKeys: ['beautyGift'],
      help: '活动开放期间，当天累计投够3票后领取一次；与自动投票分别控制。' },
  ] },
  { key: 'activityAutomation.fish', label: '钓鱼图鉴', taskKeys: ['fishBook'] },
  { key: 'activityAutomation.vip', label: 'VIP 每日奖励', taskKeys: ['vipDaily', 'vipDailyGift'] },
  { key: 'activityAutomation.pirates', label: '海盗战报奖励', taskKeys: ['campaignReports', 'battleReportRewards'] },
  { key: 'activityAutomation.openRank', label: '开服冲榜', taskKeys: ['openRankRewards', 'pirateRankRewards', 'warRankRewards'] },
];

export const activityAutomationSettingFields = activityAutomationFields.flatMap(control => [control, ...(control.fields ?? [])]);

export const activityAutomationDefaults = Object.fromEntries(activityAutomationFields
  .filter(field => field.key.startsWith('activityAutomation.')).map(field => [field.key.split('.')[1], false]));

const controls = new Map(activityAutomationFields.map(field => [field.key, field]));
const taskControls = new Map(activityAutomationFields.flatMap(field => field.taskKeys.map(key => [key, field])));
const weeklyControls = {
  1: 'activityAutomation.weekPass', 2: 'activityAutomation.weekCharge', 3: 'activityAutomation.weekHeroStar',
  4: 'activityAutomation.weekLottery', 5: 'weekOrder.enabled',
  6: 'activityAutomation.weekChip', 7: 'activityAutomation.weekUnique',
};
const linkageControls = {
  6: 'activityAutomation.festivalGifts', 10: 'activityAutomation.festivalGifts', 11: 'activityAutomation.festivalDaily',
  27: 'activityAutomation.river', 28: 'activityAutomation.compass', 29: 'activityAutomation.edict', 30: 'activityAutomation.evilExpel',
};

export function activityAutomationControl(row) {
  if (!row || typeof row !== 'object') return null;
  const source = row.sourceId ?? row.id;
  const id = typeof source === 'string' ? source : '';
  if (id === 'merchant') return controls.get('merchant.enabled');
  if (id === 'guildShip') return controls.get('guildShip.enabled');
  if (id === 'hero-raid' || id.startsWith('hero-raid:') || row.type === 'heroRaid') return controls.get('heroRaid.enabled');
  if (row.weekType != null) return controls.get(weeklyControls[row.weekType]) ?? null;
  if (id === 'rich-merchant') return controls.get('weekOrder.enabled');
  if (id.startsWith('weekly:')) return controls.get(weeklyControls[id.split(':')[1]]) ?? null;
  if (id.startsWith('linkage:')) return controls.get(linkageControls[id.split(':').at(-1)]) ?? null;
  if (id.startsWith('newbie:')) return controls.get('activityAutomation.newbie');
  if (id === 'openrank' || id.startsWith('openrank:')) return controls.get('activityAutomation.openRank');
  const key = { beauty: 'beauty', fish: 'fish', vip: 'vip', pirates: 'pirates' }[id];
  return key ? controls.get('activityAutomation.' + key) : null;
}

function controlEnabled(settings, key) {
  const [group, field] = key.split('.');
  const value = settings?.[group]?.[field];
  return ['heroRaid.enabled', 'guildShip.enabled'].includes(key) ? value === true : value !== false;
}

export function weeklyActivityEnabled(settings, type) {
  const key = weeklyControls[type];
  return !key || controlEnabled(settings, key);
}

export function activityTaskEnabled(settings, key) {
  if (key === 'weekSupplyFree') return [4, 6, 7].some(type => weeklyActivityEnabled(settings, type));
  const control = taskControls.get(key);
  return !control || controlEnabled(settings, control.key);
}

export function activityProductionEnabled(settings, source) {
  if (source === 'merchant') return controlEnabled(settings, 'weekOrder.enabled');
  if (source === 'heroRaid') return settings?.heroRaid?.enabled !== false;
  return true;
}
