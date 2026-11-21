/** A link that opens the demo rig: `?demo` loads it, `?demo=wave` also plays that animation, so one URL shows the editor at work. */
import { selectAnimation, setMode } from '@/store/actions';
import { docStore } from '@/store/doc';
import { backupCurrent, restoreAutosave } from '@/store/project';
import { offerLesson } from '@/store/learn';
import { loadSample } from '@/store/sample';
import { toast, uiStore } from '@/store/ui';

/** The animation named in the link: '' when only `?demo` is given, null when the link does not ask for the demo. */
export function demoRequest(search: string): string | null {
  const params = new URLSearchParams(search);
  return params.has('demo') ? params.get('demo')!.trim().slice(0, 64) : null;
}

/** Opens what the link asks for. True when it did (the welcome window and the autosave are then not needed). */
export async function openDeepLink(search: string): Promise<boolean> {
  const name = demoRequest(search);
  if (name === null) return false;
  // a visitor who worked here before keeps that work: it goes to the History window before the demo replaces it
  if ((await restoreAutosave()) && (await backupCurrent('open'))) toast('Your earlier work is kept in the History window', 'info');
  await loadSample();
  const anim = docStore.get().skeleton.animations.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (anim) {
    selectAnimation(anim.id);
    setMode('animate');
    uiStore.patch({ time: 0, playing: true });
  }
  offerLesson('fox'); // a visitor from a link has not seen the editor yet: the lesson starts once, and can be closed
  return true;
}
