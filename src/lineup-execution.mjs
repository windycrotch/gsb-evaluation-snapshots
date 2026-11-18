import { uidText } from './hero-equipment.mjs';
import { readLineupEditor, validateEditorFormation } from './saved-lineups.mjs';
import { withTemporaryLineup } from './lineup-runtime.mjs';

function optionalRole(player) {
  const playerId = uidText(player?.playerId ?? player?.id);
  const worldId = uidText(player?.bornWorldId || player?.worldId);
  return playerId && worldId ? { playerId, worldId } : null;
}

export function lineupRole(player) {
  const role = optionalRole(player);
  if (!role) throw new Error('无法确认阵容所属角色与区服，请重新连接');
  return role;
}

export function selectedSavedLineup(settings, { mode, raidId, presetId } = {}) {
  const lineups = settings?.lineups;
  let selected = presetId;
  if (selected === undefined) {
    selected = mode === 'trial'
      ? lineups?.trialPresets?.find(binding => binding.raidId === String(raidId))?.presetId ?? ''
      : lineups?.mainlinePresetId ?? '';
  }
  if (typeof selected !== 'string') throw new Error('请选择有效的保存阵容');
  if (!selected) return null;
  const preset = lineups?.presets?.find(item => item.id === selected);
  if (!preset) throw new Error('所选阵容已删除，请重新选择');
  return structuredClone(preset);
}

// Call within the caller's account queue. Both console and CLI use this path.
export function createLineupExecutor(client, {
  accountId, getPlayer, getSettings, getConfig, presetId,
  enabled = () => client.connected !== false, onPhase = () => {},
}) {
  return async (work, context = {}) => {
    const current = () => enabled() && !context.signal?.aborted && context.enabled?.() !== false;
    const notify = event => {
      try { context.onLineupPhase?.(event); } catch { /* State observers cannot interrupt cleanup. */ }
      try { onPhase(event); } catch { /* Logs cannot interrupt cleanup. */ }
    };
    if (!current()) throw new Error('挑战已停止，未切换阵容');
    const preset = selectedSavedLineup(getSettings(), { ...context, presetId });
    const player = getPlayer();
    if (!preset) {
      // Runtime checks pending recovery after acquiring account ownership. Even
      // a default-lineup battle must not cross another task's snapshot window.
      return withTemporaryLineup(client, {
        accountId, role: optionalRole(player), formation: null, enabled: current, onPhase: notify,
      }, work);
    }
    const role = lineupRole(player);
    const editor = await readLineupEditor(client, getConfig(), player);
    const formation = validateEditorFormation(preset.formation, editor);
    return withTemporaryLineup(client, {
      accountId, role, formation, enabled: current,
      onPhase: event => notify({ ...event, lineupId: preset.id, lineupName: preset.name }),
    }, work);
  };
}
