// 网页与终端共用人类可读名称；同名账号用序号区分，不把内部 ID 当显示名。
export function createLogAccountLabels(accounts) {
  const names = accounts.map(account => String(account.label || account.lastSeen?.nickname || '未命名账号'));
  const totals = new Map(), positions = new Map();
  for (const name of names) totals.set(name, (totals.get(name) || 0) + 1);
  return new Map(accounts.map((account, index) => {
    const name = names[index], position = (positions.get(name) || 0) + 1;
    positions.set(name, position);
    return [account.id, totals.get(name) > 1 ? name + '（' + position + '）' : name];
  }));
}
