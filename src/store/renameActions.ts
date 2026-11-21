/** Find and replace for names (see core/rename.ts): one history step, with a message of what changed and what could not. */
import type { Id, Project } from '@/core/model';
import { applyImageRename, applyRename, planRename } from '@/core/rename';
import type { FindReplaceOptions, RenamePlan, RenameScope } from '@/core/rename';
import { attachmentPictures } from '@/core/sequence';
import { assets } from './assets';
import { docStore } from './doc';
import { toast, uiStore } from './ui';

export type RenameWhere = 'all' | 'selection' | 'skin';

/**
 * What a replacement is limited to. `selection`: the selected bones, slot and constraint (and the animation being edited), and the pictures
 * the selected slot shows. `skin`: the chosen skin, and the pictures its attachments show (the default skin's when none is chosen).
 */
export function renameScope(where: RenameWhere, project: Project = docStore.get(), ui = uiStore.get()): RenameScope | undefined {
  if (where === 'all') return undefined;
  const doc = project.skeleton;
  const ids = new Set<Id>();
  const images = new Set<string>();
  const take = (attachments: Record<string, Record<string, Parameters<typeof attachmentPictures>[0]>> | undefined, slot?: Id) => {
    for (const slotId in attachments ?? {}) {
      if (slot && slotId !== slot) continue;
      for (const att of Object.values(attachments![slotId])) for (const p of attachmentPictures(att)) images.add(p);
    }
  };
  if (where === 'selection') {
    for (const b of ui.selection.bones) ids.add(b);
    if (ui.selection.slot) {
      ids.add(ui.selection.slot);
      for (const skin of doc.skins) take(skin.attachments, ui.selection.slot);
    }
    if (ui.selection.constraint) ids.add(ui.selection.constraint);
    if (ui.mode === 'animate' && ui.animationId) ids.add(ui.animationId);
  } else {
    const skin = doc.skins.find((s) => s.id === ui.skinId) ?? doc.skins[0];
    if (skin) {
      ids.add(skin.id);
      take(skin.attachments);
    }
  }
  return { ids, images };
}

/** What the replacement would do now, without doing it (the panel shows the count while typing). */
export function previewRename(opts: FindReplaceOptions): RenamePlan {
  const project = docStore.get();
  return planRename(project.skeleton, opts, project);
}

/** Does it. Returns how many names changed. */
export function findReplaceNames(opts: FindReplaceOptions): number {
  const project = docStore.get();
  const plan = planRename(project.skeleton, opts, project);
  if (plan.invalid) {
    toast('That regular expression does not parse', 'error');
    return 0;
  }
  if (!plan.changes.length) {
    toast(plan.skipped.length ? `Nothing renamed: ${plan.skipped.length} would clash or become empty` : 'No name matches', 'info');
    return 0;
  }
  // the loaded pictures keep their bitmaps under the new names
  const pixels = new Map(plan.changes.filter((c) => c.kind === 'image').map((c) => [c.from, assets.get(c.from)]));
  for (const c of plan.changes) {
    const a = c.kind === 'image' ? pixels.get(c.from) : undefined;
    if (!a) continue;
    // a name that another picture is leaving (a swap of names) gets the new pixels; any other keeps the old ones too, for undo
    if (assets.get(c.to)) assets.set(c.to, a);
    else assets.alias(c.from, c.to);
  }
  let n = 0;
  docStore.update('Find and replace', (d) => {
    n = applyRename(d.skeleton, plan.changes) + applyImageRename(d, plan.changes);
  });
  toast(
    plan.skipped.length ? `Renamed ${n} names, skipped ${plan.skipped.length} that would clash or become empty` : `Renamed ${n} names`,
    'ok',
  );
  return n;
}
