const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const qualityIndices = { GREEN: 0, BLUE: 1, PURPLE: 2, ORANGE: 3, RED: 4 };

// Offline client evidence: BuildTeamPop._heroMatchCondition adds exclusive
// stars to hero stars and checks quality, career and faction. Matching grants
// heroEvalScore; it is a recommendation, not a requirement for dispatch.
function recommendationKnown(condition) {
  return integer(condition?.heroStar) && integer(condition?.heroQualityIndex)
    && typeof condition?.careerLimit === 'string' && typeof condition?.factionLimit === 'string';
}

function heroRecommendationKnown(hero, heroConfig, condition) {
  const quality = heroConfig && (qualityIndices[heroConfig.quality] ?? heroConfig.qualityIndex);
  return recommendationKnown(condition) && !!heroConfig && integer(hero?.star ?? 0)
    && integer(hero?.exclusive?.star ?? 0) && integer(quality)
    && (!condition.careerLimit || typeof heroConfig.career === 'string')
    && (!condition.factionLimit || typeof heroConfig.faction === 'string');
}

export function matchesMuseumRecommendation(hero, heroConfig, condition) {
  if (!recommendationKnown(condition) || !heroConfig) return false;
  const star = hero?.star ?? 0, exclusiveStar = hero?.exclusive?.star ?? 0;
  const quality = qualityIndices[heroConfig.quality] ?? heroConfig.qualityIndex;
  return integer(star) && integer(exclusiveStar) && integer(quality)
    && star + exclusiveStar >= condition.heroStar && quality >= condition.heroQualityIndex
    && (!condition.careerLimit || heroConfig.career === condition.careerLimit)
    && (!condition.factionLimit || heroConfig.faction === condition.factionLimit);
}

// MuseumHeroSelectPop orders available heroes by recommendation first, then
// their existing power order, and fills the remaining slots with other heroes.
// Callers include both active expeditions and unconfirmed/planned dispatches
// in busyHeroIds so a hero cannot be allocated twice in the same round.
export function selectMuseumHeroes(stage, heroes, config, busyHeroIds = new Set()) {
  const conditions = rows(config, 'MuseumExpeditionConditionCfg')
    .filter(row => row.conditionId === stage.expedition?.conditionId);
  const condition = conditions.length === 1 ? conditions[0] : null;
  const requiredCount = integer(condition?.heroCount, 1) ? condition.heroCount : 0;
  const result = { heroIds: [], requiredCount, recommendedCount: 0, allRecommended: false,
    conditionKnown: requiredCount > 0, recommendationKnown: recommendationKnown(condition), ready: false, reason: '' };
  if (!requiredCount) return { ...result, reason: '未确认本次探险所需英雄人数' };
  if (!Array.isArray(heroes)) return { ...result, reason: '未取得完整英雄名单' };
  const seen = new Set(), busy = new Set(busyHeroIds), candidates = [];
  for (const hero of heroes) {
    if (typeof hero?.heroId !== 'string' || !hero.heroId || seen.has(hero.heroId))
      return { ...result, reason: '英雄名单含重复或缺失编号' };
    seen.add(hero.heroId);
    if (busy.has(hero.heroId)) continue;
    const configs = rows(config, 'HeroCfg').filter(row => row.id === hero.heroId);
    candidates.push({ heroId: hero.heroId,
      recommendationKnown: configs.length === 1 && heroRecommendationKnown(hero, configs[0], condition),
      recommended: configs.length === 1 && matchesMuseumRecommendation(hero, configs[0], condition),
      power: Number.isFinite(hero.power) && hero.power >= 0 ? hero.power : 0 });
  }
  candidates.sort((a, b) => Number(b.recommended) - Number(a.recommended) || b.power - a.power || a.heroId.localeCompare(b.heroId));
  const selected = candidates.slice(0, requiredCount);
  result.heroIds = selected.map(hero => hero.heroId);
  result.recommendedCount = selected.filter(hero => hero.recommended).length;
  result.ready = selected.length === requiredCount;
  result.allRecommended = result.ready && result.recommendedCount === requiredCount;
  // A full confirmed recommended team is enough. Otherwise missing hero
  // metadata must not be confused with a confirmed zero-recommendation team.
  result.recommendationKnown = result.recommendationKnown
    && (result.allRecommended || candidates.every(hero => hero.recommendationKnown));
  if (!result.ready) result.reason = '没有足够的空闲英雄';
  return result;
}

// The client unlocks the listed factors at their configured player levels.
// Keep the discrete values: Math.min(selected, maximum) could invent an
// unavailable intermediate factor when the table contains a gap.
export function availableMuseumFactors(config, playerLevel) {
  if (!integer(playerLevel)) return [];
  return [...new Set(rows(config, 'MuseumExploreTimeFactorCfg')
    .filter(row => integer(row.factor, 1) && integer(row.playerLevel) && row.playerLevel <= playerLevel)
    .map(row => row.factor))].sort((a, b) => a - b);
}

export function museumExploreFactor(stage, snapshot, config, settings, team) {
  const preference = settings.museum, mode = preference.factorMode ?? 'materials';
  const assets = stage.expedition?.cost?.asset;
  const costs = Array.isArray(assets) ? assets.map(item => Array.isArray(item)
    ? { id: item[0], num: Number(item[1]) } : { id: item?.id, num: Number(item?.num) }) : [];
  const have = id => typeof snapshot.world?.have === 'function' ? snapshot.world.have(id)
    : snapshot.world?.stock?.get(id) ?? 0;
  const matched = mode === 'materials' && !!preference.materialFactor && costs.some(item =>
    (preference.factorMaterials ?? []).includes(item.id) || (preference.stockThreshold > 0 && have(item.id) <= preference.stockThreshold));
  let selected = matched ? preference.matchedFactor : preference.factor;
  if (mode === 'recommended') {
    const busy = new Set((snapshot.museum?.exploreStages ?? [])
      .filter(item => item.expedition?.endTime > 0).flatMap(item => item.expedition.heroIds ?? []));
    const selectedTeam = team ?? selectMuseumHeroes(stage, snapshot.heroes, config, busy);
    if (!selectedTeam.ready) return { mode, factor: 0, matched: false, costs,
      reason: selectedTeam.reason || '没有足够的空闲英雄' };
    if (!selectedTeam.recommendationKnown) return { mode, factor: 0, matched: false, costs,
      reason: '未确认推荐英雄条件或英雄资料，等待同步后再派遣' };
    // These user-selected factors are tool settings, not a game-defined
    // mapping from recommendation score to duration or rewards.
    if (selectedTeam.allRecommended) selected = preference.fullRecommendedFactor ?? 3;
    else if (selectedTeam.recommendedCount > 0) selected = preference.partialRecommendedFactor ?? 2;
    else if (preference.noRecommendedFallback === true) selected = preference.noRecommendedFactor ?? 1;
    else return { mode, factor: 0, matched: false, costs, reason: '没有可用的推荐英雄，已关闭无推荐英雄时兜底' };
  } else if (mode !== 'materials') {
    return { mode, factor: 0, matched: false, costs, reason: '未识别的探宝倍数模式' };
  }
  const factors = availableMuseumFactors(config, snapshot.player?.level);
  const allowed = integer(selected, 1) ? factors.filter(factor => factor <= selected) : [];
  const factor = allowed.length ? allowed[allowed.length - 1] : 0;
  return { mode, factor, matched, costs, reason: factor ? '' : '未确认可用的探宝倍数' };
}
