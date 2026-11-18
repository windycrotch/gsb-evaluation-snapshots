let productionPlanOwner = null;
let productionPlanVersion = 0;
let productionPlanBusy = false;

bindConsoleSlice('productionPlan', { productionPlanOwner, productionPlanBusy }, state => {
  productionPlanOwner = state.productionPlanOwner;
  productionPlanBusy = state.productionPlanBusy;
});

function resetProductionPlan() {
  productionPlanVersion++;
  setConsoleValue('productionPlan', 'productionPlanOwner', null);
  setConsoleValue('productionPlan', 'productionPlanBusy', false);
  clear($('production-plan-result'));
  $('production-plan-status').textContent = '连接后可计算';
}

function productionPlanTime(value) {
  if (!Number.isFinite(value)) return '待确认';
  return new Date(value * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function productionPlanDuration(value) {
  if (!Number.isFinite(value)) return '待确认';
  const seconds = Math.max(0, Math.ceil(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return (hours ? hours + '小时' : '') + (minutes ? minutes + '分' : '') + seconds % 60 + '秒';
}

function renderProductionPlan(data) {
  const box = clear($('production-plan-result'));
  box.appendChild(el('p', null, data.statusLabel));
  const priorityPolicy = data.priorityPolicy || (data.objective === 'priority-makespan'
    ? '先优化最高优先级需求的齐套时间，再依次优化后续优先级。'
    : null);
  if (priorityPolicy) box.appendChild(el('p', 'dim', priorityPolicy));
  if (data.completionAt != null) {
    const completionLabel = data.scope === 'configured-demands' ? '全部需求预计齐套 '
      : data.scope === 'feasible-demands' ? '参与排产的需求预计齐套 '
      : data.scope === 'feasible-orders' ? '可行订单预计齐套 ' : '全部订单预计齐套 ';
    box.appendChild(el('p', null, completionLabel
      + productionPlanTime(data.completionAt) + '，用时 ' + productionPlanDuration(data.upperBound)));
  }
  if (data.lowerBound != null && data.upperBound != null && data.lowerBound !== data.upperBound) {
    box.appendChild(el('p', 'dim', (data.objective === 'priority-makespan' ? '总工期下界 ' : '工期下界 ')
      + productionPlanDuration(data.lowerBound)
      + '，当前方案 ' + productionPlanDuration(data.upperBound)));
  }
  if (data.priorityBounds?.length) {
    box.appendChild(el('h3', null, '分层齐套时间'));
    box.appendChild(el('p', 'dim', '后续级别的最优时间以更高级别已达到最优为条件。'));
    box.appendChild(table(['优先级', '优先级约束下界', '方案用时'], data.priorityBounds.map(level => [
      level.label || '第' + (level.priority + 1) + '级',
      productionPlanDuration(level.lowerBound),
      productionPlanDuration(level.upperBound),
    ])));
  }
  box.appendChild(el('p', 'dim', '状态快照 ' + productionPlanTime(data.snapshotTime) + ' · 北京时间'));
  const notes = [...new Set([...(data.notes || []), ...(data.missingReads || []), ...(data.assumptions || [])])];
  if (notes.length) {
    const list = el('ul', 'dim');
    for (const note of notes) list.appendChild(el('li', null, note));
    box.appendChild(list);
  }
  if (data.orders?.length) {
    box.appendChild(el('h3', null, ['configured-demands', 'feasible-demands'].includes(data.scope) ? '需求齐套时间' : '订单齐套时间'));
    box.appendChild(table(['目标', '优先级', '需求', '预计齐套', '计算状态'], data.orders.map(order => [
      order.label || order.id,
      order.priorityLabel || '同级',
      (order.requirements || []).map(item => (item.name || item.id) + ' ×' + item.num).join('、'),
      order.skipped ? '已跳过排产' : order.completionAt == null ? '待确认' : productionPlanTime(order.completionAt),
      order.reason || order.statusLabel,
    ])));
  }
  if (data.timeline?.length) {
    const details = el('details');
    details.appendChild(el('summary', null, '生产顺序，共 ' + data.timeline.length + ' 批'));
    details.appendChild(table(['设施', '产物', '优先级', '投料', '开始', '完成', '时长依据'], data.timeline.map(job => [
      job.machineName || job.machineId,
      (job.productName || job.itemId) + ' ×' + job.quantity,
      (job.priorityLabel || (job.kind === 'existing' ? '已排队' : '同级'))
        + (job.inheritedPriority ? ' · 上游继承' : ''),
      job.kind === 'existing' ? '已投料' : (job.inputs || []).map(item => (item.name || item.itemId) + ' ×' + item.quantity).join('、'),
      productionPlanTime(job.startAt),
      productionPlanTime(job.finishAt),
      job.timingLabel || '模型计算',
    ])));
    box.appendChild(details);
  }
}

$('production-plan-refresh').onclick = async () => {
  const account = current;
  if (!account || !snapshot.connected || snapshot.paused || disconnected.has(account)) return;
  const version = ++productionPlanVersion;
  setConsoleValue('productionPlan', 'productionPlanOwner', account);
  setConsoleValue('productionPlan', 'productionPlanBusy', true);
  clear($('production-plan-result'));
  $('production-plan-refresh').disabled = true;
  $('production-plan-status').textContent = '读取需求与优先级并计算中…';
  try {
    const data = await call('/api/world/production-plan');
    if (version !== productionPlanVersion || account !== current || !snapshot.connected || disconnected.has(account) || snapshot.paused) return;
    renderProductionPlan(data);
    $('production-plan-status').textContent = '本次计算完成';
  } catch (error) {
    if (version !== productionPlanVersion || account !== current) return;
    $('production-plan-status').textContent = '计算失败，可重新读取';
    reportError(error);
  } finally {
    if (version === productionPlanVersion) {
      setConsoleValue('productionPlan', 'productionPlanBusy', false);
      $('production-plan-refresh').disabled = !snapshot.connected || snapshot.paused || disconnected.has(current);
    }
  }
};
