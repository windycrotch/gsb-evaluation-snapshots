/**
 * Micro-move: the small steps of the arrow keys. A step is 1 unit of position, 1 degree of rotation or shear and 0.01 of scale; the Shift key makes
 * it ten times larger. These are pure helpers; the actions that use them are in store/nudgeActions.ts.
 */

/** How far one step goes for a timeline of a bone (translate, rotate, scale or shear, whole or one axis). */
export function stepOf(prop: string): number {
  return prop.startsWith('scale') ? 0.01 : 1;
}

/**
 * The value of a bone key after `steps` steps up (negative: down). A scale pair moves both axes together so the bone keeps its shape;
 * a translate or shear pair moves its second number (Y), which is the one "up" means; a single number moves as it is.
 */
export function nudgeValue(prop: string, value: readonly number[], steps: number): number[] {
  const d = steps * stepOf(prop);
  const out = [...value];
  if (!out.length) return out;
  if (prop === 'scale') return out.map((v) => v + d);
  out[out.length - 1] += d;
  return out;
}

/** The number to add to a key's value or position for a pressed arrow: right/up are positive. */
export function arrowSteps(key: 'arrowleft' | 'arrowright' | 'arrowup' | 'arrowdown', big: boolean): { dx: number; dy: number } {
  const n = big ? 10 : 1;
  return { dx: key === 'arrowright' ? n : key === 'arrowleft' ? -n : 0, dy: key === 'arrowup' ? n : key === 'arrowdown' ? -n : 0 };
}
