import { Link2, Trash2 } from 'lucide-react';
import { hasKey } from '@/core/edit';
import type { Id } from '@/core/model';
import { currentAnimation, deleteKeys } from '@/store/actions';
import { useProject } from '@/store/doc';
import { currentIkValues, deleteConstraint, setConstraintSetup, setIkValues } from '@/store/ikActions';
import { useUi } from '@/store/ui';
import { Button, NumberField, SelectField, Toggle } from '../ui/controls';
import { Field, KeyButton } from '../ui/Field';
import { Section } from '../ui/Section';
import { ConstraintHeader } from './ConstraintHeader';
import { PathConstraintInspector } from './PathConstraintInspector';
import { PhysicsConstraintInspector } from './PhysicsConstraintInspector';
import { SliderInspector } from './SliderInspector';
import { TransformInspector } from './TransformInspector';

export function ConstraintInspector({ id }: { id: Id }) {
  const project = useProject();
  const c0 = project.skeleton.constraints.find((x) => x.id === id);
  if (!c0) return null;
  if (c0.type === 'transform') return <TransformInspector id={id} />;
  if (c0.type === 'slider') return <SliderInspector id={id} />;
  if (c0.type === 'path') return <PathConstraintInspector id={id} />;
  if (c0.type === 'physics') return <PhysicsConstraintInspector id={id} />;
  return <IkInspector id={id} />;
}

function IkInspector({ id }: { id: Id }) {
  const project = useProject();
  const mode = useUi((s) => s.mode);
  const time = useUi((s) => s.time);
  useUi((s) => s.overrides);
  const doc = project.skeleton;
  const c = doc.constraints.find((x) => x.id === id);
  if (!c || c.type !== 'ik') return null;
  const animate = mode === 'animate';
  const anim = currentAnimation();
  const keys = anim?.ik[id];
  const keyed = hasKey(keys, time);
  const v = (animate ? currentIkValues(id) : null) ?? {
    mix: c.mix,
    softness: c.softness,
    bendPositive: c.bendPositive,
    compress: c.compress,
    stretch: c.stretch,
  };
  const boneName = (b: Id) => doc.bones.find((x) => x.id === b)?.name ?? '?';

  return (
    <>
      <ConstraintHeader id={id} title="IK constraint" icon={Link2} kind="ik" />
      <Section
        id="ik.chain"
        title="Chain"
        actions={
          animate && (
            <KeyButton
              on={keyed}
              title={keyed ? 'Remove the IK key at the playhead' : 'Key the IK values at the playhead'}
              onClick={() => (keyed ? deleteKeys([{ kind: 'ik', target: id, prop: '', time }]) : setIkValues(id, {}))}
            />
          )
        }
      >
        <Field label="Bones">
          <span className="val">{c.bones.map(boneName).join(' → ')}</span>
        </Field>
        <Field label="Target">
          <SelectField
            value={c.target}
            options={doc.bones.filter((b) => !c.bones.includes(b.id)).map((b) => ({ value: b.id, label: b.name }))}
            onChange={(t) => setConstraintSetup(id, { target: t })}
          />
        </Field>
        <Field label="Mix">
          <NumberField
            label="%"
            value={v.mix * 100}
            step={1}
            precision={0}
            min={0}
            max={100}
            keyed={animate && keyed}
            onChange={(x) => setIkValues(id, { mix: x / 100 })}
          />
        </Field>
        {c.bones.length === 2 && (
          <Field label="Softness">
            <NumberField
              label="px"
              value={v.softness}
              step={0.5}
              precision={1}
              min={0}
              keyed={animate && keyed}
              onChange={(x) => setIkValues(id, { softness: Math.max(0, x) })}
            />
          </Field>
        )}
        {c.bones.length === 2 && (
          <Field label="Bend positive">
            <Toggle on={v.bendPositive} onChange={(x) => setIkValues(id, { bendPositive: x })} />
          </Field>
        )}
        <Field label="Stretch">
          <Toggle on={v.stretch} onChange={(x) => setIkValues(id, { stretch: x })} />
        </Field>
        {c.bones.length === 1 && (
          <Field label="Compress">
            <Toggle on={v.compress} onChange={(x) => setIkValues(id, { compress: x })} />
          </Field>
        )}
        {(v.stretch || v.compress) && (
          <Field label="Scale Y">
            <SelectField
              value={c.scaleY}
              options={[
                { value: 'none', label: 'Keep' },
                { value: 'uniform', label: 'Uniform' },
                { value: 'volume', label: 'Preserve volume' },
              ]}
              onChange={(x) => setConstraintSetup(id, { scaleY: x })}
            />
          </Field>
        )}
      </Section>
      <div className="group">
        <Button danger icon={Trash2} onClick={() => deleteConstraint(id)}>
          Delete constraint
        </Button>
      </div>
    </>
  );
}
