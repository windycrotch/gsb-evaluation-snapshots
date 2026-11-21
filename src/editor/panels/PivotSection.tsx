import { Crosshair } from 'lucide-react';
import type { Id } from '@/core/model';
import { uiStore, useUi } from '@/store/ui';
import { getScene } from '@/store/scene';
import { Button, NumberField, SelectField } from '../ui/controls';
import { Field } from '../ui/Field';
import { Section } from '../ui/Section';

/**
 * The pivot of the rotate tool: a point of the world the selected bones turn about, instead of their own origin (a forearm about the wrist, a
 * head about the neck). Turning about a point moves the bone as well, so in Animate mode it keys the rotation and the position.
 */
export function PivotSection({ id }: { id: Id }) {
  const tool = useUi((s) => s.tool);
  const pivot = useUi((s) => s.pivot);
  const pick = useUi((s) => s.pivotPick);
  useUi((s) => s.time);
  if (tool !== 'rotate') return null;
  const bone = getScene().skeleton.boneById(id);
  const set = (x: number, y: number) =>
    uiStore.patch({ pivot: { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 }, pivotPick: false });
  return (
    <Section id="bone.pivot" title="Pivot" icon={Crosshair}>
      <Field label="Rotate about" title="What the rotate tool turns the bone about">
        <SelectField<'bone' | 'point'>
          value={pivot ? 'point' : 'bone'}
          options={[
            { value: 'bone', label: 'The bone' },
            { value: 'point', label: 'A point' },
          ]}
          onChange={(v) => {
            if (v === 'bone') uiStore.patch({ pivot: null, pivotPick: false });
            else if (bone) set(bone.tipX, bone.tipY);
            else uiStore.patch({ pivotPick: true });
          }}
        />
      </Field>
      {pivot && (
        <>
          <Field label="Point" title="Where the pivot is in the world">
            <NumberField label="x" value={pivot.x} step={1} precision={2} onChange={(v) => set(v, pivot.y)} />
            <NumberField label="y" value={pivot.y} step={1} precision={2} onChange={(v) => set(pivot.x, v)} />
          </Field>
          <div className="hstack wrap mb">
            <Button
              primary={pick}
              title="The next click in the viewport sets the pivot"
              onClick={() => uiStore.patch({ pivotPick: !pick })}
            >
              Pick in the viewport
            </Button>
            <Button disabled={!bone} title="Put the pivot at the origin of the bone" onClick={() => bone && set(bone.worldX, bone.worldY)}>
              Bone origin
            </Button>
            <Button disabled={!bone} title="Put the pivot at the tip of the bone" onClick={() => bone && set(bone.tipX, bone.tipY)}>
              Bone tip
            </Button>
          </div>
        </>
      )}
      <p className="hint-text">Turning about a point moves the bone too: in Animate mode the rotation and the position are both keyed.</p>
    </Section>
  );
}
