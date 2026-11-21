/** Constraint presets: keep the settings of a constraint under a name, put them on another one. The model is in core/presets. */
import { applyPresetSettings, loadPresets, newPreset, savePresets } from '@/core/presets';
import type { ConstraintPreset } from '@/core/presets';
import type { Id } from '@/core/model';
import { askName } from './ask';
import { docStore } from './doc';
import { clampPhysicsValue } from './physicsActions';
import { createStore, useStore } from './store';
import { toast } from './ui';

export const presetsStore = createStore<{ list: ConstraintPreset[] }>({ list: loadPresets() });
export const usePresets = (): ConstraintPreset[] => useStore(presetsStore, (s) => s.list);

function commit(list: ConstraintPreset[]) {
  presetsStore.set({ list });
  savePresets(list);
}

/** Keeps the settings of a constraint under a name. A preset of the same kind with the same name is replaced. Returns it. */
export function savePreset(constraintId: Id, name: string): ConstraintPreset | null {
  const c = docStore.get().skeleton.constraints.find((x) => x.id === constraintId);
  const wanted = name.trim();
  if (!c || !wanted) return null;
  const list = presetsStore.get().list;
  const same = list.find((p) => p.type === c.type && p.name.toLowerCase() === wanted.toLowerCase());
  const entry = newPreset(same ? list.filter((p) => p !== same) : list, c, same ? same.name : wanted);
  if (same) entry.id = same.id;
  commit(same ? list.map((p) => (p === same ? entry : p)) : [...list, entry]);
  return entry;
}

export async function savePresetDialog(constraintId: Id) {
  const c = docStore.get().skeleton.constraints.find((x) => x.id === constraintId);
  if (!c) return;
  const name = await askName('Save preset', 'Name for these settings. A preset of this kind with the same name is replaced.', c.name);
  if (!name) return;
  const entry = savePreset(constraintId, name);
  if (entry) toast(`Preset "${entry.name}" saved`, 'ok');
}

/** Puts a preset on a constraint of the same kind, one step in the history. Returns how many settings changed. */
export function applyPreset(constraintId: Id, presetId: string): number {
  const preset = presetsStore.get().list.find((p) => p.id === presetId);
  const c = docStore.get().skeleton.constraints.find((x) => x.id === constraintId);
  if (!preset || !c || preset.type !== c.type) return 0;
  let changed = 0;
  docStore.update(`Apply preset "${preset.name}"`, (d) => {
    const target = d.skeleton.constraints.find((x) => x.id === constraintId);
    if (target) changed = applyPresetSettings(target, preset.settings, clampPhysicsValue);
  });
  if (!changed) toast('The constraint has these settings already');
  return changed;
}

export function deletePreset(presetId: string) {
  commit(presetsStore.get().list.filter((p) => p.id !== presetId));
}
