/** The slider constraint: plays an animation by time or by a bone property. */
import { applyAnimationOnto } from '../animate';
import type { SliderData } from './data';
import type { Bone } from './bone';
import { NO_OFFSETS, transformFrom } from './transform';
import type { Skeleton } from './skeleton';

/**
 * Spine 4.3 slider. Applies an animation on top of the current (constrained) pose, at a time that is either its own
 * `time` (animatable) or computed from a bone property: `to + (value - from) * scale`.
 */
export class SliderRT {
  readonly kind = 'slider' as const;
  readonly data: SliderData;
  readonly skeleton: Skeleton;
  readonly bone: Bone | null;
  mix: number;
  time: number;
  active = true;

  constructor(data: SliderData, skeleton: Skeleton) {
    this.data = data;
    this.skeleton = skeleton;
    this.bone = data.bone >= 0 ? skeleton.bones[data.bone] : null;
    this.mix = data.mix;
    this.time = data.time;
  }

  setToSetupPose() {
    this.mix = this.data.mix;
    this.time = this.data.time;
  }

  sourceActive() {
    // a slider that has no animation does nothing and is not exported, so it must not shape the update order either
    return this.data.animation !== null;
  }

  sort(skeleton: Skeleton) {
    const d = this.data;
    if (this.bone && !d.local) skeleton.sortBone(this.bone);
    skeleton.cache.push(this);
    // the animated bones change their local transforms: they (and their descendants) are updated again afterwards
    for (const i of d.animatedBones) {
      const bone = skeleton.bones[i];
      bone.sorted = false;
      skeleton.sortReset(bone.children);
    }
  }

  update() {
    if (this.mix === 0) return;
    const d = this.data;
    const animation = d.animation;
    if (!animation) return;
    const sk = this.skeleton;
    const bone = this.bone;
    if (bone) {
      if (!bone.active) return;
      if (d.local) bone.validateApplied();
      this.time = d.to + (transformFrom(d.property, sk, bone, d.local, NO_OFFSETS) - d.from) * d.scale;
      if (d.loop && animation.duration > 0) this.time = animation.duration + (this.time % animation.duration);
      else this.time = Math.max(0, this.time);
    }
    for (const i of d.animatedBones) sk.bones[i].modifyLocal();
    applyAnimationOnto(sk, animation, this.time, this.mix, d.additive, d.loop);
  }
}
