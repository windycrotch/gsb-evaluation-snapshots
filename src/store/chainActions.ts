/** Spreads a physics parameter over a chain of bones along a curve (stiff at the root, loose at the tip). */
import { chainValues } from '@/core/chains';
import type { ChainShape } from '@/core/chains';
import { freshName } from '@/core/edit';
import { newPhysicsConstraint } from '@/core/model';
import type { Id, PhysicsParam } from '@/core/model';
import { docStore } from './doc';
import { clampPhysicsValue } from './physicsActions';
import { toast } from './ui';

export interface ChainCurve {
  param: PhysicsParam;
  from: number;
  to: number;
  shape: ChainShape;
  power: number;
  /** Give the bones that have no physics constraint one. */
  create: boolean;
}

/** Applies the curve to the chain (physics constraint setup values). Returns the number of bones changed. */
export function applyChainCurve(ids: Id[], o: ChainCurve): number {
  const doc = docStore.get().skeleton;
  // the root bone has nothing to hang on, so it takes no physics constraint
  const bones = ids.filter((id) => doc.bones.some((b) => b.id === id && b.parent));
  if (!bones.length) {
    toast('Select a bone with children (a tail, a spine) or several bones in a chain', 'error');
    return 0;
  }
  const values = chainValues(bones.length, o.from, o.to, o.shape, o.power);
  let changed = 0;
  docStore.update('Chain curve', (d) => {
    bones.forEach((id, i) => {
      const bone = d.skeleton.bones.find((b) => b.id === id)!;
      let c = d.skeleton.constraints.find((x) => x.type === 'physics' && x.bone === id);
      if (!c && o.create) {
        c = newPhysicsConstraint({ name: freshName(`${bone.name} physics`, d.skeleton.constraints), bone: id });
        d.skeleton.constraints.push(c);
      }
      if (c && c.type === 'physics') {
        c[o.param] = clampPhysicsValue(o.param, values[i]);
        changed++;
      }
    });
  });
  if (!changed) toast('None of these bones has a physics constraint: turn on "Add missing constraints"', 'error');
  return changed;
}
