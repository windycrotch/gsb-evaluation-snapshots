// IDs and labels match AppointPosCfg.effectId and AppointEffectCfg.desc.
export const APPOINTMENT_PRIORITIES = Object.freeze([
  { id: '生产时间', label: '生产时间减少' },
  { id: '训练产量', label: '训练营产量提高' },
  { id: '贸易时间', label: '贸易时间减少' },
  { id: '建造速度', label: '建造速度提高' },
  { id: '种田时间', label: '种田时间减少' },
  { id: '宠物培育速度', label: '海兽培育速度提高' },
  { id: '锻造时间', label: '锻造时间减少' },
].map(Object.freeze));

export const DEFAULT_APPOINTMENT_PRIORITIES = Object.freeze(APPOINTMENT_PRIORITIES.map(item => item.id));

// Keep saved choices in place and append effects absent from older settings.
export function normalizeAppointmentPriorities(value) {
  const saved = Array.isArray(value) ? value : [];
  return [...new Set([
    ...saved.filter(id => DEFAULT_APPOINTMENT_PRIORITIES.includes(id)),
    ...DEFAULT_APPOINTMENT_PRIORITIES,
  ])];
}
