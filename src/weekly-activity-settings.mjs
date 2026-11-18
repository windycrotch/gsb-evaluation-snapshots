// 军备竞赛全天参与；开启活动不重置养成目标或消费预算。
export const WEEKLY_ACTIVITY_KINDS = ['farm', 'pet', 'antique', 'order', 'forge', 'hero'];

export const WEEKLY_ACTIVITY_DEFAULTS = {
  enabled: false,
  ...Object.fromEntries(WEEKLY_ACTIVITY_KINDS.flatMap(kind => [
    [kind + 'Enabled', false], [kind + 'Stop', 'allDay'], [kind + 'Score', 0],
  ])),
  farmRecruitTimes: 10,
  farmSpeedUp: false,
  petQualityOrder: 'asc',
  forgeQualityOrder: 'asc',
};

export const WEEKLY_ACTIVITY_CONSTRAINTS = {
  ...Object.fromEntries(WEEKLY_ACTIVITY_KINDS.flatMap(kind => [
    ['weeklyActivity.' + kind + 'Stop', { kind: 'choice', values: ['allDay', 'score'] }],
    ['weeklyActivity.' + kind + 'Score', { kind: 'number', min: 0, max: 1000000000 }],
  ])),
  'weeklyActivity.farmRecruitTimes': { kind: 'number', min: 0, max: 1000 },
  'weeklyActivity.petQualityOrder': { kind: 'choice', values: ['asc', 'desc'] },
  'weeklyActivity.forgeQualityOrder': { kind: 'choice', values: ['asc', 'desc'] },
};

export function validateWeeklyActivitySettings(settings, errors) {
  for (const kind of WEEKLY_ACTIVITY_KINDS) {
    const prefix = 'weeklyActivity.' + kind;
    if (settings.enabled && settings[kind + 'Enabled'] && settings[kind + 'Stop'] === 'score'
      && !(settings[kind + 'Score'] > 0)) {
      errors[prefix + 'Score'] = '按积分停止时，请填写大于 0 的目标积分';
    }
  }
}

// Accept previously saved/imported windows, but never let them restrict the
// all-day schedule or survive the next save/export.
export function migrateWeeklyActivitySettings(settings) {
  const next = { ...settings };
  for (const kind of WEEKLY_ACTIVITY_KINDS) {
    delete next[kind + 'Start'];
    delete next[kind + 'End'];
    if (next[kind + 'Stop'] === 'time') next[kind + 'Stop'] = 'allDay';
  }
  return next;
}
