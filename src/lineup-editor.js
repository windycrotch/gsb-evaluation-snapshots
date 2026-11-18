// Saved formations and editor drafts belong to an account, including in-flight requests.
const savedLineupAccounts = new Map();
let lineupModal = null;

function savedLineupState(account) {
  if (!savedLineupAccounts.has(account)) savedLineupAccounts.set(account, {
    saved: null, editor: null, drafts: new Map(), activeDraft: null,
    readSerial: 0, editorSerial: 0, loading: false, saving: false, readError: '',
    message: '', error: false,
    bindingPending: new Map(), bindingSave: null, bindingError: '',
    selectedHeroId: null, query: '', faction: '', career: '', ui: null,
  });
  return savedLineupAccounts.get(account);
}

function lineupRequest(path, account, body) {
  return call(path + '?account=' + encodeURIComponent(account), body === undefined ? undefined
    : { method: 'POST', body: JSON.stringify({ ...body, confirm: true }) });
}

function configuredLineupId(account, key) {
  const state = savedLineupState(account);
  if (state.bindingPending.has(key)) return state.bindingPending.get(key).value;
  return key === 'mainline' ? state.saved?.mainlinePresetId || ''
    : state.saved?.trialPresets?.find(binding => 'trial:' + binding.raidId === key)?.presetId || '';
}

function selectedLineupId(mode, raidId) {
  return configuredLineupId(current, mode === 'trial' ? 'trial:' + raidId : 'mainline');
}

function paintLineupChoiceStatus(node, state) {
  node.textContent = state.bindingPending.size ? '正在保存阵容选择…' : state.bindingError;
  node.hidden = !node.textContent;
  node.className = state.bindingError && !state.bindingPending.size ? 'warn' : 'dim';
}

function createLineupChoiceStatus(account) {
  const node = el('span'); node.dataset.lineupChoiceStatus = account;
  node.setAttribute('role', 'status');
  paintLineupChoiceStatus(node, savedLineupState(account));
  return node;
}

function saveChallengeLineup(account, key, value) {
  if (!account || account !== current) return Promise.resolve();
  const state = savedLineupState(account);
  state.bindingPending.set(key, { value }); state.bindingError = '';
  updateManualLineupSelects(account);
  if (state.bindingSave) return state.bindingSave;
  const job = (async () => {
    while (state.bindingPending.size) {
      const changes = new Map(state.bindingPending);
      try {
        // Merge only the changed choices into the latest account configuration.
        // Serialize saves so changing another trial cannot overwrite an in-flight choice.
        for (let attempt = 0; attempt < 2; attempt++) {
          const latest = await lineupRequest('/api/lineup-presets', account);
          adoptSavedLineups(state, latest);
          let mainlinePresetId = latest.mainlinePresetId || '';
          const trials = new Map((latest.trialPresets || []).map(binding => [binding.raidId, binding.presetId]));
          for (const [mode, choice] of changes) {
            if (mode === 'mainline') mainlinePresetId = choice.value;
            else if (choice.value) trials.set(mode.slice(6), choice.value);
            else trials.delete(mode.slice(6));
          }
          try {
            const data = await lineupRequest('/api/lineup-presets/bind', account, {
              revision: latest.revision, mainlinePresetId,
              trialPresets: [...trials].map(([raidId, presetId]) => ({ raidId, presetId })),
            });
            adoptSavedLineups(state, data);
            state.bindingError = '';
            break;
          } catch (error) {
            if (!error.fields?.revision || attempt === 1) throw error;
          }
        }
      } catch (error) {
        // A lost response may still have saved successfully. Re-read before rolling back the UI.
        try { adoptSavedLineups(state, await lineupRequest('/api/lineup-presets', account)); } catch {}
        state.bindingError = '阵容选择保存失败：' + error.message + '。请重新选择后重试。';
      }
      for (const [mode, choice] of changes) {
        if (state.bindingPending.get(mode) === choice) state.bindingPending.delete(mode);
      }
      if (account === current) updateManualLineupSelects(account);
    }
  })();
  state.bindingSave = job.finally(() => { state.bindingSave = null; });
  return state.bindingSave;
}

function fillLineupSelect(select, presets, value) {
  select.replaceChildren();
  select.add(new Option('使用游戏当前阵容', ''));
  for (const preset of presets) select.add(new Option(preset.name, preset.id));
  if (value && !presets.some(preset => preset.id === value)) {
    select.add(new Option('已删除的阵容，请重新选择', value));
  }
  select.value = value;
  select.lineupPreviewUpdate?.();
}

function createLineupPreviewButton(account, select) {
  const button = smallButton('查看');
  button.setAttribute('aria-label', '查看所选阵容');
  const update = () => {
    const exists = savedLineupState(account).saved?.presets.some(preset => preset.id === select.value);
    button.disabled = account !== current || !select.value || !exists;
    button.title = select.value && !exists ? '该阵容已删除，请重新选择' : '';
  };
  select.addEventListener('change', update);
  select.lineupPreviewUpdate = update;
  button.onclick = () => { if (!button.disabled) void openSavedLineupViewer(account, select.value); };
  update();
  return button;
}

function createLineupSelect(account, mode, raidId) {
  const select = el('select', 'saved-lineup-select');
  const key = mode === 'trial' ? 'trial:' + raidId : 'mainline';
  select.dataset.lineupAccount = account;
  select.dataset.lineupMode = key;
  select.setAttribute('aria-label', mode === 'trial' ? '试炼挑战阵容' : '主线挑战阵容');
  fillLineupSelect(select, savedLineupState(account).saved?.presets || [], configuredLineupId(account, key));
  select.onchange = () => saveChallengeLineup(account, key, select.value);
  return select;
}

function updateManualLineupSelects(account) {
  const state = savedLineupState(account), presets = state.saved?.presets || [];
  for (const select of document.querySelectorAll('select[data-lineup-mode]')) {
    if (select.dataset.lineupAccount !== account) continue;
    fillLineupSelect(select, presets, configuredLineupId(account, select.dataset.lineupMode));
  }
  for (const node of document.querySelectorAll('[data-lineup-choice-status]')) {
    if (node.dataset.lineupChoiceStatus === account) paintLineupChoiceStatus(node, state);
  }
}

function adoptSavedLineups(state, data) {
  if (state.saved && data.revision < state.saved.revision) return;
  state.saved = data;
}

async function refreshSavedLineups(account = current) {
  lineupAccountChanged();
  const host = $('saved-lineup-view');
  if (!host) return;
  if (!account) { delete host.dataset.owner; host.textContent = '请先选择账号'; return; }
  const state = savedLineupState(account), serial = ++state.readSerial;
  if (host.dataset.owner !== account) {
    host.dataset.owner = account;
    renderSavedLineups(account);
  }
  try {
    const data = await lineupRequest('/api/lineup-presets', account);
    if (serial !== state.readSerial) return;
    const clearedReadError = state.readError && state.message === state.readError;
    if (clearedReadError) { state.message = ''; state.error = false; }
    state.readError = '';
    const unchanged = JSON.stringify(state.saved) === JSON.stringify(data);
    const contentUnchanged = state.saved && ['presets', 'catalog', 'mainlinePresetId', 'trialPresets']
      .every(key => JSON.stringify(state.saved[key]) === JSON.stringify(data[key]));
    adoptSavedLineups(state, data);
    if (account !== current) return;
    if (!contentUnchanged) updateManualLineupSelects(account);
    if (!unchanged || clearedReadError) {
      if (contentUnchanged && !clearedReadError && state.recoveryHost && host.contains(state.recoveryHost)) {
        clear(state.recoveryHost);
        renderLineupRecovery(state.recoveryHost, state, account);
      } else renderSavedLineups(account);
    }
  } catch (error) {
    if (serial !== state.readSerial || account !== current) return;
    state.message = state.readError = error.message; state.error = true;
    renderSavedLineups(account);
  }
}

function lineupSummary(formation, state) {
  if (!formation) return '尚未读取';
  const catalog = state.editor || state.saved?.catalog;
  const heroes = new Map((catalog?.heroes || []).map(hero => [hero.heroId, hero.name]));
  const type = catalog?.formations?.find(item => item.presetId === formation.presetId);
  const names = (formation.heroPositions || []).map(item => heroes.get(item.heroId) || item.heroId);
  const petUid = String(formation.petUid || '0');
  const pet = petUid !== '0' && state.editor?.pets?.find(item => String(item.uid) === petUid);
  return [type?.name || '阵型 ' + formation.presetId, names.join('、') || '空阵容',
    pet ? pet.name : petUid !== '0' ? '携带海兽' : ''].filter(Boolean).join(' · ');
}

async function mutateSavedLineups(account, path, body) {
  const state = savedLineupState(account);
  if (state.saving || account !== current) return null;
  const recovering = path.endsWith('/recover');
  state.saving = true; state.message = recovering ? '正在核对阵容恢复…' : '正在保存…'; state.error = false;
  ++state.readSerial;
  renderSavedLineups(account);
  redrawLineupEditor(state, account);
  try {
    const data = await lineupRequest(path, account, { revision: state.saved?.revision ?? 0, ...body });
    adoptSavedLineups(state, data);
    state.message = recovering ? '已完成阵容核对' : '';
    if (account === current) updateManualLineupSelects(account);
    return data;
  } catch (error) {
    state.message = error.message; state.error = true;
    return null;
  } finally {
    state.saving = false;
    if (account === current) { renderSavedLineups(account); redrawLineupEditor(state, account); }
  }
}

async function captureSavedLineup(account) {
  const state = savedLineupState(account);
  const name = await accountDialog('保存游戏当前阵容', '为当前游戏阵容取一个名称', state.captureName || '当前阵容');
  if (name === null || account !== current) return;
  state.captureName = name;
  if (!name.trim()) { state.message = '请输入阵容名称'; state.error = true; renderSavedLineups(account); return; }
  await mutateSavedLineups(account, '/api/lineup-presets/capture', { name: name.trim() });
}

function renderLineupRecovery(host, state, account) {
  const recovery = state.saved?.recovery;
  if (!recovery || recovery.pending === false || recovery.phase === 'idle') return;
  const section = el('section', 'saved-lineup-recovery');
  section.setAttribute('aria-label', '阵容恢复');
  const phases = { switching: '正在切换阵容', battling: '使用所选阵容挑战中', restoring: '正在还原阵容', conflict: '阵容恢复需要处理', pending: '阵容待恢复' };
  section.append(el('strong', '', phases[recovery.phase] || '阵容待恢复'), el('p', '', recovery.reason || recovery.message || '挑战结束后核对并还原原始阵容。'));
  const original = recovery.original || recovery.before;
  const target = recovery.target;
  if (original) section.append(el('p', 'dim', '原阵容 · ' + lineupSummary(original, state)));
  if (target) section.append(el('p', 'dim', '挑战阵容 · ' + lineupSummary(target, state)));
  const actions = el('div', 'bar');
  const resolve = (label, resolution) => {
    const button = smallButton(label); button.disabled = state.saving;
    button.onclick = () => mutateSavedLineups(account, '/api/lineup-presets/recover', {
      resolution, expectedTransactionId: recovery.transactionId || recovery.id,
    });
    return button;
  };
  actions.append(resolve('重试恢复', 'auto'));
  if (recovery.conflict || recovery.status === 'conflict' || recovery.phase === 'conflict') {
    actions.append(resolve('恢复原始阵容', 'restore'), resolve('保留游戏当前阵容', 'keep'));
  }
  section.append(actions); host.append(section);
}

function renderSavedLineups(account) {
  if (account !== current) return;
  const host = $('saved-lineup-view');
  if (!host) return;
  const state = savedLineupState(account);
  const active = host.contains(document.activeElement) ? document.activeElement : null;
  const focusLabel = active?.getAttribute('aria-label');
  const selection = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  clear(host); host.dataset.owner = account;
  const toolbar = el('div', 'bar');
  const create = smallButton('新建阵容'), capture = smallButton('保存游戏当前阵容');
  create.id = 'saved-lineup-create';
  create.setAttribute('aria-label', '新建阵容');
  create.disabled = capture.disabled = state.saving || !state.saved;
  create.onclick = () => openSavedLineupEditor(account);
  capture.onclick = () => captureSavedLineup(account);
  toolbar.append(create, capture); host.append(toolbar);
  const status = el('p', state.error ? 'warn' : 'dim', state.message || (state.saved ? '' : '正在读取已保存阵容…'));
  status.setAttribute('role', 'status');
  if (status.textContent) host.append(status);
  state.recoveryHost = el('div', 'saved-lineup-recovery-host');
  renderLineupRecovery(state.recoveryHost, state, account);
  host.append(state.recoveryHost);
  const list = el('div', 'saved-lineup-list');
  for (const preset of state.saved?.presets || []) {
    const row = el('div', 'saved-lineup-row'), info = el('div'); row.dataset.lineupPreset = preset.id;
    info.append(el('strong', '', preset.name), el('p', 'dim', lineupSummary(preset.formation, state)));
    const actions = el('div', 'bar'), view = smallButton('查看'), edit = smallButton('编辑'), remove = smallButton('删除', true);
    view.setAttribute('aria-label', '查看阵容 ' + preset.name);
    view.onclick = () => openSavedLineupViewer(account, preset.id);
    edit.disabled = remove.disabled = state.saving;
    edit.setAttribute('aria-label', '编辑阵容 ' + preset.name);
    remove.setAttribute('aria-label', '删除阵容 ' + preset.name);
    edit.onclick = () => openSavedLineupEditor(account, preset);
    remove.onclick = () => openConfirm('删除阵容', [el('p', '', '删除「' + preset.name + '」并清除它的自动挑战绑定。')], async () => {
      if (account !== current) return;
      const data = await mutateSavedLineups(account, '/api/lineup-presets/delete', { id: preset.id });
      if (!data) return;
      state.drafts.delete(preset.id);
      if (state.activeDraft === preset.id) state.activeDraft = null;
      adoptSavedLineups(state, data);
      if (account === current) renderSavedLineups(account);
    });
    actions.append(view, edit, remove); row.append(info, actions); list.append(row);
  }
  if (state.saved && !state.saved.presets.length) list.append(el('p', 'dim', '保存一套阵容后，可在主线和各试炼中选择。'));
  host.append(list);
  if (focusLabel) {
    const target = [...host.querySelectorAll('[aria-label]')].find(item => item.getAttribute('aria-label') === focusLabel);
    target?.focus({ preventScroll: true });
    if (selection && target?.setSelectionRange) target.setSelectionRange(...selection);
  }
}

function closeLineupDialog(restoreFocus = true) {
  const modal = lineupModal;
  if (!modal) return;
  lineupModal = null;
  if (modal.mode === 'editor') {
    const state = savedLineupState(modal.account);
    state.activeDraft = null; state.ui = null;
  }
  modal.dialog.close(); modal.dialog.remove();
  document.body.classList.remove('lineup-modal-open');
  if (!restoreFocus || modal.account !== current) return;
  const row = [...document.querySelectorAll('[data-lineup-preset]')].find(item => item.dataset.lineupPreset === modal.presetId);
  const fallback = row?.querySelector(modal.mode === 'viewer' ? 'button[aria-label^="查看阵容"]' : 'button[aria-label^="编辑阵容"]') || $('saved-lineup-create');
  (modal.returnFocus?.isConnected ? modal.returnFocus : fallback)?.focus({ preventScroll: true });
}

function lineupAccountChanged() {
  if (lineupModal && lineupModal.account !== current) closeLineupDialog(false);
}

function openLineupDialog(account, mode, presetId) {
  const returnFocus = document.activeElement;
  closeLineupDialog(false);
  const dialog = el('dialog', 'lineup-dialog'); dialog.id = 'saved-lineup-dialog';
  dialog.dataset.lineupMode = mode;
  dialog.setAttribute('aria-labelledby', 'lineup-dialog-title');
  const body = el('div', 'lineup-dialog-body'); dialog.append(body);
  const modal = { dialog, body, account, mode, presetId, returnFocus };
  lineupModal = modal;
  dialog.oncancel = event => { event.preventDefault(); closeLineupDialog(); };
  dialog.onclose = () => { if (lineupModal === modal) closeLineupDialog(); };
  document.body.append(dialog); document.body.classList.add('lineup-modal-open');
  return modal;
}

function lineupDialogCloseButton(mode) {
  const close = smallButton('关闭');
  close.setAttribute('aria-label', mode === 'viewer' ? '关闭阵容查看' : '关闭阵容编辑器');
  close.onclick = () => closeLineupDialog();
  return close;
}

async function openSavedLineupEditor(account, preset) {
  if (account !== current) return;
  const state = savedLineupState(account), key = preset?.id || 'new';
  if (!state.drafts.has(key)) state.drafts.set(key, {
    id: preset?.id, name: preset?.name || '',
    formation: structuredClone(preset?.formation || { presetId: 1, heroPositions: [], petUid: '0' }),
    dirty: false,
  });
  const modal = openLineupDialog(account, 'editor', preset?.id);
  state.activeDraft = key; state.selectedHeroId = null;
  renderLineupEditor(modal.body, state, account); modal.dialog.showModal();
  if (!state.editor) await loadLineupEditorData(account);
}

async function loadLineupEditorData(account) {
  const state = savedLineupState(account), serial = ++state.editorSerial;
  state.loading = true; state.editorError = '';
  if (account === current) redrawLineupEditor(state, account);
  try {
    const data = await lineupRequest('/api/lineup-editor', account);
    if (serial !== state.editorSerial) return;
    state.editor = data;
    if (Array.isArray(data.presets)) {
      const { presets, mainlinePresetId, trialPresets, revision, recovery, trialRaids } = data;
      adoptSavedLineups(state, { ...state.saved, presets, revision, recovery,
        mainlinePresetId: mainlinePresetId ?? state.saved?.mainlinePresetId ?? '',
        trialPresets: trialPresets ?? state.saved?.trialPresets ?? [],
        trialRaids: trialRaids ?? state.saved?.trialRaids ?? [] });
    }
    if (account === current) updateManualLineupSelects(account);
  } catch (error) {
    if (serial === state.editorSerial) state.editorError = error.message;
  } finally {
    if (serial === state.editorSerial) {
      state.loading = false;
      if (account === current) { renderSavedLineups(account); redrawLineupEditor(state, account); }
    }
  }
}

async function openSavedLineupViewer(account, presetId) {
  if (account !== current || !presetId) return;
  const modal = openLineupDialog(account, 'viewer', presetId);
  const loading = el('section', 'lineup-editor lineup-viewer');
  const heading = el('div', 'lineup-editor-heading'), title = el('h3', '', '查看阵容');
  title.id = 'lineup-dialog-title';
  heading.append(title, lineupDialogCloseButton('viewer'));
  loading.append(heading, el('p', 'lineup-viewer-message', '正在读取已保存阵容…'));
  modal.body.append(loading); modal.dialog.showModal();
  try {
    const data = await lineupRequest('/api/lineup-presets', account);
    if (lineupModal !== modal || account !== current) return;
    const state = savedLineupState(account);
    adoptSavedLineups(state, data);
    renderSavedLineups(account); updateManualLineupSelects(account);
    const preset = state.saved.presets.find(item => item.id === presetId);
    if (!preset) throw new Error('该阵容已删除，请重新选择');
    clear(modal.body); renderLineupViewer(modal.body, state, preset, account);
  } catch (error) {
    if (lineupModal !== modal || account !== current) return;
    loading.lastElementChild.textContent = error.message;
  }
}

function renderLineupViewer(host, state, preset, account) {
  const catalog = state.saved?.catalog || { heroes: [], formations: [] };
  const formation = preset.formation;
  const root = el('section', 'lineup-editor lineup-viewer'); root.id = 'saved-lineup-viewer';
  const heading = el('div', 'lineup-editor-heading'), title = el('h3', '', preset.name);
  title.id = 'lineup-dialog-title'; heading.append(title, lineupDialogCloseButton('viewer')); root.append(heading);
  const workspace = el('div', 'lineup-workspace'), battlefield = el('div', 'lineup-battlefield');
  const count = el('div', 'lineup-board-heading');
  count.append(el('span', '', '已上阵 ' + formation.heroPositions.length), el('span', '', '敌方 →'));
  const board = el('div', 'lineup-board'); board.setAttribute('aria-label', '已保存的英雄站位');
  battlefield.append(count, board);
  const details = el('div', 'lineup-viewer-details');
  const type = catalog.formations?.find(item => item.presetId === formation.presetId);
  const typeHeading = el('div', 'lineup-viewer-type');
  if (type?.icon) typeHeading.append(iconEl(type.icon, 48, type.name));
  typeHeading.append(el('h4', '', type?.name || '阵型 ' + formation.presetId)); details.append(typeHeading);
  if (type?.effect) details.append(el('p', 'lineup-effect', type.effect));
  if (type?.unlockEffect) details.append(el('p', 'lineup-muted', type.unlockEffect));
  const heroes = el('ul', 'lineup-viewer-heroes');
  for (const position of formation.heroPositions) {
    const hero = catalog.heroes?.find(item => item.heroId === position.heroId) || { name: position.heroId };
    const item = el('li'); item.append(lineupPortrait(hero, 40), el('span', '', hero.name)); heroes.append(item);
  }
  details.append(heroes); workspace.append(battlefield, details); root.append(workspace);
  const petField = el('div', 'lineup-pet-field'); petField.append(el('span', '', '出战海兽'));
  const petUid = String(formation.petUid || '0');
  const pet = state.editor?.pets?.find(item => String(item.uid) === petUid);
  if (pet) petField.append(iconEl(pet.icon, 44, pet.name));
  petField.append(el('span', '', pet ? pet.name : petUid === '0' ? '不携带海兽' : '海兽 UID ' + petUid));
  root.append(petField);
  const footer = el('div', 'lineup-viewer-footer'), close = smallButton('关闭');
  close.onclick = () => closeLineupDialog(); footer.append(close); root.append(footer);
  const viewerState = { editor: catalog, drafts: new Map([[preset.id, preset]]), activeDraft: preset.id, ui: { root, board } };
  drawLineupBoard(viewerState, account, true); host.append(root);
}

function currentLineupDraft(state) { return state.drafts.get(state.activeDraft); }
function lineupPositionKey(position) { return position.x + ',' + position.y; }
function lineupHero(state, heroId) {
  return state.editor?.heroes?.find(hero => hero.heroId === heroId) || { heroId, name: heroId, quality: '' };
}
function currentLineupPositions(state) {
  const draft = currentLineupDraft(state);
  const definition = state.editor?.formations?.find(item => item.presetId === draft.formation.presetId);
  return definition?.positions || draft.formation.heroPositions.map(item => item.pos);
}

// Both click placement and Pointer Events use this operation, so swaps and capacity agree.
function placeLineupHero(state, heroId, position) {
  const draft = currentLineupDraft(state), positions = currentLineupPositions(state);
  if (!positions.some(item => lineupPositionKey(item) === lineupPositionKey(position))) return false;
  if (!state.editor?.heroes?.some(hero => hero.heroId === heroId)) return false;
  const roster = draft.formation.heroPositions;
  const source = roster.find(item => item.heroId === heroId);
  const target = roster.find(item => lineupPositionKey(item.pos) === lineupPositionKey(position));
  if (target === source && source) return false;
  if (!source && !target && roster.length >= state.editor.capacity) {
    state.editorMessage = '已达到上阵人数上限，请选择场上英雄进行替换'; return false;
  }
  const next = roster.filter(item => item !== source && item !== target);
  if (source && target) next.push({ heroId: target.heroId, pos: { ...source.pos } });
  next.push({ heroId, pos: { ...position } });
  draft.formation.heroPositions = next; draft.dirty = true;
  state.selectedHeroId = null; state.editorMessage = '站位已更新';
  return true;
}

function removeLineupHero(state, heroId) {
  const draft = currentLineupDraft(state);
  if (!draft.formation.heroPositions.some(item => item.heroId === heroId)) return false;
  draft.formation.heroPositions = draft.formation.heroPositions.filter(item => item.heroId !== heroId);
  draft.dirty = true; state.selectedHeroId = null; state.editorMessage = '英雄已下阵';
  return true;
}

function changeLineupFormation(state, presetId) {
  const definition = state.editor?.formations?.find(item => item.presetId === presetId);
  const draft = currentLineupDraft(state);
  if (!definition?.unlocked || draft.formation.presetId === presetId) return;
  const targetPositions = [...definition.positions].sort((a, b) => b.x - a.x);
  draft.formation.heroPositions = draft.formation.heroPositions.slice(0, targetPositions.length).map((item, index) => ({
    heroId: item.heroId, pos: { ...targetPositions[index] },
  }));
  draft.formation.presetId = presetId; draft.dirty = true;
  state.selectedHeroId = null; state.editorMessage = '已按新阵型重新排列英雄，可继续调整站位';
}

function lineupPortrait(hero, size = 52) {
  const portrait = el('span', 'lineup-portrait');
  portrait.dataset.quality = String(hero.quality || '').toUpperCase();
  portrait.append(iconEl(hero.icon, size, hero.name));
  return portrait;
}

function redrawLineupEditor(state, account, focusPosition) {
  if (account !== current || lineupModal?.account !== account || lineupModal.mode !== 'editor' || !state.ui?.root?.isConnected) return;
  const active = state.ui.root.contains(document.activeElement) ? document.activeElement : null;
  const label = active?.getAttribute('aria-label');
  const selection = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const rosterScroll = state.ui.roster?.scrollTop || 0;
  const old = state.ui.root, host = el('div');
  renderLineupEditor(host, state, account);
  old.replaceWith(host.firstElementChild);
  state.ui.roster.scrollTop = rosterScroll;
  if (focusPosition) {
    [...state.ui.root.querySelectorAll('[data-lineup-position]')]
      .find(item => item.dataset.lineupPosition === focusPosition)?.focus({ preventScroll: true });
  } else if (label) {
    const target = [...state.ui.root.querySelectorAll('[aria-label]')].find(item => item.getAttribute('aria-label') === label);
    target?.focus({ preventScroll: true });
    if (selection && target?.setSelectionRange) target.setSelectionRange(...selection);
  }
}

function bindLineupPointer(button, state, account, heroId) {
  let drag = null, drop = null;
  const clearDrop = () => { if (drop) delete drop.dataset.lineupDrop; drop = null; };
  const end = () => {
    clearDrop(); delete button.dataset.lineupDragging;
    if (drag && button.hasPointerCapture?.(drag.id)) button.releasePointerCapture(drag.id);
    drag = null;
  };
  button.onpointerdown = event => {
    if (event.button !== 0 || event.isPrimary === false || state.saving || account !== current) return;
    if (event.pointerType === 'touch' && button.classList.contains('lineup-hero') && !event.target.closest('.lineup-portrait')) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    button.setPointerCapture(event.pointerId);
  };
  button.onpointermove = event => {
    if (!drag || drag.id !== event.pointerId) return;
    if (account !== current) { end(); return; }
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
    drag.moved = true; button.dataset.lineupDragging = 'true'; event.preventDefault();
    clearDrop();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-lineup-position], [data-lineup-remove]');
    if (target && state.ui.root.contains(target)) { drop = target; drop.dataset.lineupDrop = 'true'; }
  };
  button.onpointerup = event => {
    if (!drag || drag.id !== event.pointerId) return;
    const moved = drag.moved, target = drop;
    end();
    if (!moved || account !== current || state.saving) return;
    state.suppressClickUntil = Date.now() + 400;
    if (target?.dataset.lineupPosition) {
      const [x, y] = target.dataset.lineupPosition.split(',').map(Number);
      placeLineupHero(state, heroId, { x, y });
    } else if (target?.dataset.lineupRemove) removeLineupHero(state, heroId);
    redrawLineupEditor(state, account, target?.dataset.lineupPosition);
  };
  button.onpointercancel = end;
  button.onlostpointercapture = end;
  button.ondragstart = event => event.preventDefault();
}

function drawLineupBoard(state, account, readonly = false) {
  const draft = currentLineupDraft(state), board = state.ui.board;
  clear(board);
  for (const position of currentLineupPositions(state)) {
    const entry = draft.formation.heroPositions.find(item => lineupPositionKey(item.pos) === lineupPositionKey(position));
    const hero = entry && lineupHero(state, entry.heroId);
    const button = el(readonly ? 'div' : 'button', 'lineup-slot');
    if (!readonly) button.type = 'button';
    button.style.left = ((56 + (position.x - 1) * 56) / 336 * 100) + '%';
    // Keep the outermost heroes inside the board as its height adapts to the viewport.
    const rowRatio = (6 - position.y) / 6;
    button.style.top = readonly ? ((42 + (6 - position.y) * 68) / 492 * 100) + '%'
      : 'calc(' + (rowRatio * 100) + '% + ' + (33 - rowRatio * 66) + 'px)';
    button.dataset.lineupPosition = lineupPositionKey(position);
    button.setAttribute('aria-label', '站位 ' + position.x + '，' + position.y + (hero ? '，' + hero.name : '，空位'));
    button.append(hero ? lineupPortrait(hero, 48) : el('span', 'lineup-empty-slot', '+'), el('span', 'lineup-slot-name', hero?.name || '空位'));
    board.append(button);
    if (readonly) { button.setAttribute('role', 'img'); continue; }
    button.setAttribute('aria-pressed', String(Boolean(hero && state.selectedHeroId === hero.heroId)));
    button.disabled = state.saving || !state.editor;
    button.onclick = () => {
      if (account !== current || state.saving || Date.now() < (state.suppressClickUntil || 0)) return;
      if (state.selectedHeroId) {
        if (state.selectedHeroId === hero?.heroId) state.selectedHeroId = null;
        else placeLineupHero(state, state.selectedHeroId, position);
      } else if (hero) state.selectedHeroId = hero.heroId;
      redrawLineupEditor(state, account, lineupPositionKey(position));
    };
    if (hero) {
      button.title = '拖动调整站位，右键下阵';
      button.oncontextmenu = event => {
        event.preventDefault();
        if (account !== current || state.saving) return;
        removeLineupHero(state, hero.heroId);
        redrawLineupEditor(state, account, lineupPositionKey(position));
      };
      bindLineupPointer(button, state, account, hero.heroId);
    }
  }
}

function drawLineupRoster(state, account) {
  const roster = clear(state.ui.roster), draft = currentLineupDraft(state);
  const heroes = (state.editor?.heroes || []).filter(hero => (!state.query || hero.name.includes(state.query))
    && (!state.faction || hero.faction === state.faction) && (!state.career || hero.career === state.career));
  for (const hero of heroes) {
    const button = el('button', 'lineup-hero'); button.type = 'button';
    button.dataset.lineupHero = hero.heroId;
    button.disabled = state.saving;
    button.setAttribute('aria-label', '选择英雄 ' + hero.name);
    button.setAttribute('aria-pressed', String(state.selectedHeroId === hero.heroId));
    const portrait = lineupPortrait(hero);
    if (draft.formation.heroPositions.some(item => item.heroId === hero.heroId)) portrait.append(el('span', 'lineup-on-field', '已上阵'));
    button.append(portrait, el('span', 'lineup-hero-name', hero.name), el('span', 'lineup-hero-detail', [hero.career, hero.level && hero.level + '级'].filter(Boolean).join(' · ')));
    button.onclick = () => {
      if (account !== current || state.saving || Date.now() < (state.suppressClickUntil || 0)) return;
      state.selectedHeroId = state.selectedHeroId === hero.heroId ? null : hero.heroId;
      redrawLineupEditor(state, account);
      [...state.ui.roster.children].find(item => item.dataset.lineupHero === hero.heroId)?.focus({ preventScroll: true });
    };
    bindLineupPointer(button, state, account, hero.heroId); roster.append(button);
  }
  if (!heroes.length) roster.append(el('p', 'lineup-muted', state.editor ? '没有符合筛选条件的英雄' : '读取游戏数据后可选择英雄'));
}

async function saveLineupDraft(account, state) {
  const draft = currentLineupDraft(state);
  if (!draft || state.saving || account !== current) return;
  const modal = lineupModal;
  if (!draft.name.trim()) { state.editorMessage = '请输入阵容名称'; redrawLineupEditor(state, account); state.ui?.name?.focus(); return; }
  if (!draft.formation.heroPositions.length) { state.editorMessage = '请至少上阵一名英雄'; redrawLineupEditor(state, account); return; }
  const previousIds = new Set(state.saved.presets.map(item => item.id));
  const key = state.activeDraft;
  const data = await mutateSavedLineups(account, '/api/lineup-presets/save', {
    id: draft.id, name: draft.name.trim(), formation: structuredClone(draft.formation),
  });
  if (!data) {
    state.editorMessage = state.message;
    if (account === current) redrawLineupEditor(state, account);
    return;
  }
  const saved = data.presets.find(item => item.id === (draft.id || data.savedId))
    || data.presets.find(item => !previousIds.has(item.id));
  if (saved) {
    state.drafts.delete(key); draft.id = saved.id; draft.name = saved.name; draft.dirty = false;
    state.drafts.set(saved.id, draft);
    if (state.activeDraft === key) state.activeDraft = saved.id;
  }
  state.editorMessage = '';
  if (account === current) {
    renderSavedLineups(account);
    if (modal && lineupModal === modal && modal.mode === 'editor') {
      modal.presetId = saved?.id || draft.id;
      closeLineupDialog();
    }
  }
}

function renderLineupEditor(host, state, account) {
  const draft = currentLineupDraft(state);
  if (!draft) return;
  const root = el('section', 'lineup-editor'); root.id = 'saved-lineup-editor';
  root.setAttribute('aria-label', '编辑阵容');
  const heading = el('div', 'lineup-editor-heading');
  const title = el('h3', '', draft.id ? '编辑阵容' : '新建阵容');
  title.id = 'lineup-dialog-title';
  const refresh = smallButton(state.loading ? '正在读取…' : '刷新英雄与海兽');
  refresh.disabled = state.loading || state.saving;
  refresh.onclick = () => loadLineupEditorData(account);
  const headingActions = el('div', 'bar'); headingActions.append(refresh, lineupDialogCloseButton('editor'));
  heading.append(title, headingActions); root.append(heading);
  if (state.editorError) root.append(el('p', 'lineup-editor-notice', state.editorError));
  if (state.loading) root.append(el('p', 'lineup-muted', '正在读取游戏阵容和英雄，排队期间可继续编辑草稿名称。'));
  const workspace = el('div', 'lineup-workspace lineup-editor-workspace'), battlefield = el('div', 'lineup-battlefield');
  const formationPanel = el('section', 'lineup-formation-panel');
  const count = el('div', 'lineup-board-heading');
  count.append(el('span', '', '已上阵 ' + draft.formation.heroPositions.length + ' / ' + (state.editor?.capacity ?? '—')), el('span', '', '敌方 →'));
  const board = el('div', 'lineup-board'); board.setAttribute('aria-label', '英雄站位');
  battlefield.append(count, board);
  const options = el('div', 'lineup-formation-options'), typeField = el('label', 'lineup-formation-field');
  const typeSelect = el('select', 'lineup-formation-select'); typeSelect.setAttribute('aria-label', '阵型');
  for (const definition of state.editor?.formations || []) {
    const option = new Option(definition.name + (definition.unlocked ? ' · ' + definition.positions.length + ' 个站位' : ' · 未解锁'), String(definition.presetId));
    option.disabled = !definition.unlocked;
    typeSelect.add(option);
  }
  const selectedType = state.editor?.formations?.find(item => item.presetId === draft.formation.presetId);
  if (!selectedType) typeSelect.add(new Option('阵型 ' + draft.formation.presetId + ' · 待读取', String(draft.formation.presetId)));
  typeSelect.value = String(draft.formation.presetId); typeSelect.disabled = state.saving || !state.editor;
  typeSelect.onchange = () => {
    if (account !== current || state.saving) return;
    changeLineupFormation(state, Number(typeSelect.value));
    redrawLineupEditor(state, account);
  };
  typeField.append(el('span', '', '阵型'), typeSelect); options.append(typeField);
  if (selectedType?.effect || selectedType?.unlockEffect) {
    const effect = el('details', 'lineup-effect lineup-effect-details');
    effect.append(el('summary', '', '阵型效果'));
    if (selectedType.effect) effect.append(el('p', '', selectedType.effect));
    if (selectedType.unlockEffect) effect.append(el('p', 'lineup-muted', selectedType.unlockEffect));
    options.append(effect);
  }
  formationPanel.append(options, battlefield);
  const selection = el('div', 'lineup-selection'), remove = smallButton('下阵');
  remove.dataset.lineupRemove = 'true';
  remove.disabled = state.saving || !draft.formation.heroPositions.some(item => item.heroId === state.selectedHeroId);
  remove.onclick = () => {
    if (account !== current || state.saving) return;
    removeLineupHero(state, state.selectedHeroId); redrawLineupEditor(state, account);
  };
  const hint = state.selectedHeroId ? '已选择 ' + lineupHero(state, state.selectedHeroId).name + '，点选站位放置或交换'
    : '拖动或点选英雄入阵，右键场上英雄下阵。';
  selection.append(el('p', 'lineup-muted', hint), remove); formationPanel.append(selection);
  const petField = el('label', 'lineup-pet-field'); petField.append(el('span', '', '出战海兽'));
  const petSelect = el('select'); petSelect.setAttribute('aria-label', '出战海兽'); petSelect.add(new Option('不携带海兽', '0'));
  for (const pet of state.editor?.pets || []) petSelect.add(new Option(pet.name, String(pet.uid)));
  const petUid = String(draft.formation.petUid || '0');
  if (petUid !== '0' && !(state.editor?.pets || []).some(pet => String(pet.uid) === petUid)) petSelect.add(new Option('待确认的海兽 ' + petUid, petUid));
  petSelect.value = petUid; petSelect.disabled = state.saving || !state.editor;
  petSelect.onchange = () => {
    if (account !== current || state.saving) return;
    draft.formation.petUid = petSelect.value; draft.dirty = true; redrawLineupEditor(state, account);
  };
  const selectedPet = state.editor?.pets?.find(pet => String(pet.uid) === petUid);
  if (selectedPet) petField.append(iconEl(selectedPet.icon, 44, selectedPet.name));
  petField.append(petSelect);
  const rosterSection = el('section', 'lineup-roster-section'), filters = el('div', 'lineup-roster-filters');
  rosterSection.append(el('h4', '', '选择英雄'));
  const search = el('input'); search.type = 'search'; search.placeholder = '搜索英雄'; search.value = state.query;
  search.setAttribute('aria-label', '搜索英雄'); search.disabled = state.saving;
  search.oninput = () => { state.query = search.value.trim(); drawLineupRoster(state, account); };
  filters.append(search);
  for (const [key, label] of [['faction', '全部阵营'], ['career', '全部职业']]) {
    const select = el('select'); select.setAttribute('aria-label', label); select.add(new Option(label, ''));
    for (const value of [...new Set((state.editor?.heroes || []).map(hero => hero[key]).filter(Boolean))]) select.add(new Option(value, value));
    select.value = state[key]; select.disabled = state.saving;
    select.onchange = () => { state[key] = select.value; drawLineupRoster(state, account); }; filters.append(select);
  }
  const roster = el('div', 'lineup-roster');
  rosterSection.append(filters, roster);
  rosterSection.append(el('p', 'lineup-muted for-touch', '滑动英雄名称可滚动列表，拖动头像可布阵。'));
  rosterSection.append(petField);
  workspace.append(rosterSection, formationPanel); root.append(workspace);
  const footer = el('div', 'lineup-editor-footer'), nameField = el('label', 'lineup-name-field'), name = el('input');
  name.type = 'text'; name.value = draft.name; name.autocomplete = 'off'; name.maxLength = 60;
  name.disabled = state.saving; name.setAttribute('aria-label', '阵容名称');
  name.oninput = () => { draft.name = name.value; draft.dirty = true; };
  nameField.append(el('span', '', '阵容名称'), name);
  const save = smallButton(state.saving ? '正在保存…' : '保存阵容'); save.disabled = state.saving || !state.saved;
  save.onclick = () => saveLineupDraft(account, state);
  const close = smallButton('关闭');
  close.onclick = () => closeLineupDialog();
  const message = el('p', 'lineup-muted', state.editorMessage || '保存后可用于临时切换挑战，草稿按账号保留。'); message.setAttribute('role', 'status');
  footer.append(nameField, save, close, message); root.append(footer);
  root.onkeydown = event => {
    if (state.saving || account !== current) return;
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT') return;
    if (event.key === 'Delete' && state.selectedHeroId) { event.preventDefault(); removeLineupHero(state, state.selectedHeroId); redrawLineupEditor(state, account); }
  };
  state.ui = { root, board, roster, name };
  drawLineupBoard(state, account); drawLineupRoster(state, account);
  host.append(root);
}
