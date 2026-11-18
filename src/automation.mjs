// All tasks start disabled. Only explicit saved choices enable an account's
// schedule; adding a task must never silently opt existing accounts into it.
// 只限制钓具强化的金币支出，其他挂机任务不使用此预算。
export const defaultFishingGoldReserve = 10_000;
export const defaultCompassSpinCount = 10;
export const maxCompassSpinCount = 999;

// 旧字段仅兼容导入，统一停用，不能在新模块关闭后恢复执行。
// 装备由 forge.enabled 控制；联盟募兵、互助由 alliance.enabled 及对应细项控制；巨轮由 treasure.enabled 控制。
export const migratedAutomationTasks = new Set(['museumCollect', 'museumExplore', 'petCollect', 'petBreed', 'radarAuto', 'radarRepair', 'museumRevenue', 'museumAchievements', 'worldBossDamage']);
export const retiredAutomationTasks = new Set(['equipmentCollect', 'equipmentCraft', 'guildOrders', 'guildAidCollect', 'guildAidHelp', 'treasureLoot', ...migratedAutomationTasks]);

export const automationTasks = [
  ['armsRaceRewards', '自动领奖', '周期活动', false],
  ['riverScore', '走江踏浪积分奖励', '限时活动', false],
  ['riverPass', '走江战令已达成奖励', '限时活动', false],
  ['riverHelp', '走江助力免费及免广告礼包', '限时活动', false],
  ['edictPass', '酆都法旨战令已达成奖励', '限时活动', false],
  ['compassDaily', '龙王罗盘每日免费礼包', '限时活动', false],
  ['compassAdGift', '龙王罗盘每日广告礼包', '限时活动', false],
  ['compassSpin', '龙王罗盘自动抽取', '限时活动', false],
  ['merchantTrade', '海商王自动买入、走商与卖出', '周期活动', false],
  ['merchantRewards', '海商王战令、联盟任务与利润礼包', '周期活动', false],
  ['beautyVotes', '风采大赛每日投给最高票选手', '限时活动', false],
  ['beautyGift', '风采大赛每日投票礼包', '限时活动', false],
  ['diveEnhance', '潜水船坞强化与升级', '船只', false],
  ['autoDive', '潜水打捞原料', '船只', false],
  ['salvageEnhance', '拾荒船强化与升级', '船只', false],
  ['autoSalvage', '拾荒船自动拾荒', '船只', false],
  ['cargo', '贸易港交货与收货', '海面', false],
  ['farm', '农田种植与收获', '海面', false],
  ['guildWelfare', '领取联盟福利礼包', '联盟', false],
  ['guildTitleReward', '联盟每日职级礼包', '联盟', false],
  ['worldOnline', '世界在线奖励', '联盟', false],
  ['tradeTasks', '海商王联盟任务', '周期活动', false],
  ['guildAidCollect', '联盟互助收取', '联盟', false],
  ['seasonTasks', '赛季任务奖励', '周期活动', false],
  ['seasonChest', '赛季宝箱用钥匙开启（每轮最多 5 箱）', '周期活动', false],
  ['crossRankDaily', '跨服排行每日奖励', '周期活动', false],
  ['passStageRewards', '闯关基金奖励', '领奖', false],
  ['guildAidHelp', '响应联盟互助', '联盟', false],
  ['treasureLoot', '万吨巨轮派遣', '世界', false],
  ['heroGrowth', '主线英雄自动养成', '英雄', false],
  ['stageAuto', '主线自动推图', '挑战', false],
  ['guildOrders', '联盟订单自动执行', '联盟', false],
  ['equipmentCollect', '装备制造自动领取', '英雄', false],
  ['equipmentCraft', '装备制造自动续产', '英雄', false],
  ['worldOnlineRewards', '领取城战在线奖励', '联盟', false],
  ['weekHeroStar', '升星达标奖励', '周期活动', false],
  ['festivalSign', '酆都诡事每日签到（不补签）', '限时活动', false],
  ['festivalFreeGift', '酆都诡事每日免费特惠', '限时活动', false],
  ['festivalActive', '联动活动活跃档位奖励', '限时活动', false],
  ['festivalGifts', '联动活动每日免费礼包', '限时活动', false],
  ['snowballFree', '走江踏浪免费礼包与通行证奖励', '限时活动', false],
  ['weekLotterySpin', '周抽奖使用周转盘币（每轮最多 10 次）', '周期活动', false],
  ['weekCharge', '累计充值已达标奖励', '周期活动', false],
  ['weekChipFree', '芯片活动免费礼包', '周期活动', false],
  ['weekUniqueFree', '周翻牌免费礼包', '周期活动', false],
  ['weekOrderFinal', '不差钱商人最终奖励', '周期活动', false],
  ['weekOrderSubmit', '不差钱商人自动完成订单', '周期活动', false],
  ['vipDaily', 'VIP 每日免费奖励', '领奖', false],
  ['campaignReports', '战报奖励（海盗战斗等）', '领奖', false],
  ['openRankRewards', '开服冲榜积分奖励', '领奖', false],
  ['pirateRankRewards', '剿匪榜达标奖励', '领奖', false],
  ['warRankRewards', '杀敌榜达标奖励', '领奖', false],
  ['festivalActiveRewards', '酆都诡事签到活跃奖励', '限时活动', false],
  ['worldBossRewards', '世界Boss伤害达标奖励', '挑战', false],
  ['battleReportRewards', '邮件战报一键领取', '领奖', false],
  ['weekSupplyFree', '周活动补给免费礼包', '周期活动', false],
  ['leagueCollect', '积分赛累计收集', '挑战', false],
  ['leaguePassRewards', '积分赛战令奖励', '挑战', false],
  ['limitedFreeGifts', '商城限购免费礼包', '领奖', false],
  ['vipDailyGift', 'VIP每日免费礼包', '领奖', false],
  ['heroAdRecruit', '英雄免广告招募（按今日剩余次数）', '招募', false],
  ['antiqueAdRecruit', '藏品免广告招募（按今日剩余次数）', '招募', false],
  ['weekTimes', '周抽奖次数奖励', '周期活动', false],
  ['evilExpel', '驱邪除祟与累计奖励', '限时活动', false],
  ['edict', '酆都法旨自动解符（每轮最多使用 1 份贡品）', '限时活动', false],
  ['compassReward', '龙王罗盘已达标积分奖励', '限时活动', false],
  ['floaters', '海面原料漂浮物拾取', '海面', false],
  ['antiqueFloaters', '海面藏品宝箱打捞', '海面', false],
  ['fishBook', '钓鱼图鉴奖励', '领奖', false],
  ['comicDrama', '漫剧观看与每日奖励', '领奖', false],
  ['tournamentDailyGift', '擂台赛每日礼包', '挑战', false],
  ['autoFish', '自动钓鱼（钓具 2 级，每轮一竿）', '钓鱼', false],
  ['fishEnhance', '钓具强化与升级（每轮一次）', '钓鱼', false],
  ['freeAntiqueRecruit', '藏品免费招募', '藏品', false],
  ['antiqueRecruitRewards', '藏品累计招募档位领奖', '藏品', false],
  ['newbieLogin', '新手七日登录奖励', '领奖', false],
  ['weekPass', '勇士战令任务与档位奖励', '周期活动', false],
  ['weekGift', '幸运转盘免费好运券礼包', '周期活动', false],
  ['tasks', '任务与成就奖励', '领奖', false],
  ['dailyRewards', '每日任务奖励', '领奖', false],
  ['chests', '活跃宝箱', '领奖', false],
  ['gift', '每日免费赠礼', '领奖', false],
  ['adShop', '广告商店资源', '领奖', false],
  ['mail', '邮件附件', '领奖', false],
  ['afk', '闯关挂机收益（满额领取）', '领奖', false],
  ['afkAd', '闯关挂机广告收益', '领奖', false],
  ['freeRecruit', '英雄免费招募', '日常', false],
  ['heroRecruitRewards', '英雄累计招募档位领奖', '招募', false],
  ['freeGold', '免费点金', '日常', false],
  ['ticketRecruit', '英雄招募券单抽', '日常', false],
  ['arena', '竞技场挑战', '日常', false],
  ['trialSweep', '试炼每日首轮免费扫荡', '挑战', false],
  ['trialPaidSweep', '试炼钻石扫荡', '挑战', false],
  ['trialAdSweep', '试炼免广告扫荡', '挑战', false],
  ['pirate', '海盗日常扫荡', '日常', false],
  ['paidGold', '钻石点金', '日常', false],
  ['shop', '折扣店购买', '日常', false],
  ['collect', '收取产物', '海面', false],
  ['finishUpgrade', '建筑竣工', '海面', false],
  ['build', '空位建造', '海面', false],
  ['buildSupply', '为待建建筑补产材料', '海面', false],
  ['finishOrder', '交居民订单', '海面', false],
  ['startProduce', '工厂排产', '海面', false],
  ['upgrade', '余料升级建筑', '海面', false],
  ['speedUp', '使用加速器', '海面', false],
  ['adSpeedUpProduce', '工厂生产广告加速', '海面', false],
  ['adSpeedUpBuilding', '建筑升级广告加速', '海面', false],
  ['adSpeedUpMuseum', '博物馆展柜广告加速', '海面', false],
  ['denyOrder', '拒单重刷', '海面', false],
].map(([key, label, group, initial]) => ({ key, label, group, initial }));

export function taskSettings(saved = {}) {
  // 旧、新世界 Boss 领奖开关原先按“任一开启”执行，读取旧任务时保留此选择。
  if (saved?.worldBossDamage === true) saved = { ...saved, worldBossRewards: true };
  return Object.fromEntries(automationTasks.map(({ key, initial }) =>
    [key, retiredAutomationTasks.has(key) ? false : typeof saved?.[key] === 'boolean' ? saved[key] : initial]));
}

export function worldTaskKey(kind) {
  if (kind === 'gainFactory' || kind === 'collectProduct') return 'collect';
  if (kind === 'speedUpUpgrade' || kind === 'speedUpProduce') return 'speedUp';
  return kind;
}

export function dailyTaskKey(id, action) {
  switch (id) {
    case 1002: return action.body.way === 1 ? 'freeRecruit' : 'ticketRecruit';
    case 1005: return 'arena';
    case 1006: return action.body.free ? 'freeGold' : 'paidGold';
    case 1007: return 'shop';
    case 1010: return 'pirate';
    default: return null;
  }
}
