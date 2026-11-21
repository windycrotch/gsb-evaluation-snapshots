import { ArrowRight, Link2, Plus, Trash2, X } from 'lucide-react';
import { hasKey } from '@/core/edit';
import { TRANSFORM_PROPS } from '@/core/model';
import type { Id, TransformProp } from '@/core/model';
import { currentAnimation, deleteKeys } from '@/store/actions';
import { useProject } from '@/store/doc';
import { useUi } from '@/store/ui';
import { deleteConstraint } from '@/store/ikActions';
import { currentTransformMix, matchTransform, setTransformMix, updateTransform } from '@/store/transformActions';
import { Button, IconButton, NumberField, SelectField, Toggle } from '../ui/controls';
import { Field, KeyButton } from '../ui/Field';
import { Section } from '../ui/Section';
import { ConstraintHeader } from './ConstraintHeader';

const PROP_LABEL: Record<TransformProp, string> = {
  rotate: 'Rotation',
  x: 'X',
  y: 'Y',
  scaleX: 'Scale X',
  scaleY: 'Scale Y',
  shearY: 'Shear Y',
};
const propOptions = TRANSFORM_PROPS.map((p) => ({ value: p, label: PROP_LABEL[p] }));
const MIX_KEYS: TransformProp[] = ['rotate', 'x', 'y', 'scaleX', 'scaleY', 'shearY'];

export function TransformInspector({ id }: { id: Id }) {
  const project = useProject();
  const mode = useUi((s) => s.mode);
  const time = useUi((s) => s.time);
  useUi((s) => s.overrides); // every hook goes above the early return
  const doc = project.skeleton;
  const c = doc.constraints.find((x) => x.id === id);
  if (!c || c.type !== 'transform') return null;
  const boneName = (b: Id) => doc.bones.find((x) => x.id === b)?.name ?? '?';
  const usedTo = new Set(c.properties.flatMap((f) => f.to.map((t) => t.prop)));
  const animate = mode === 'animate';
  const keys = currentAnimation()?.transform?.[id];
  const keyed = hasKey(keys, time);
  const cur = animate ? currentTransformMix(id) : null; // the animated mixes
  const mixOf = (k: TransformProp) => (cur ? cur[TRANSFORM_PROPS.indexOf(k)] : c.mix[k]);

  return (
    <>
      <ConstraintHeader id={id} title="Transform constraint" icon={Link2} kind="transform" />

      <Section id="transform.bones" title="Bones">
        <Field label="Source">
          <SelectField
            value={c.source}
            options={doc.bones.filter((b) => !c.bones.includes(b.id)).map((b) => ({ value: b.id, label: b.name }))}
            onChange={(v) => updateTransform(id, (x) => void (x.source = v))}
          />
        </Field>
        <Field label="Drives">
          <span className="val">{c.bones.map(boneName).join(', ')}</span>
        </Field>
        <Field label="Local source" title="Read the source's local transform instead of its world transform">
          <Toggle on={c.localSource} onChange={(v) => updateTransform(id, (x) => void (x.localSource = v))} />
        </Field>
        <Field label="Local target" title="Write the constrained bones' local transforms instead of their world transforms">
          <Toggle on={c.localTarget} onChange={(v) => updateTransform(id, (x) => void (x.localTarget = v))} />
        </Field>
        <Field label="Additive" title="Add to the constrained bone instead of replacing the property">
          <Toggle on={c.additive} onChange={(v) => updateTransform(id, (x) => void (x.additive = v))} />
        </Field>
        <Field label="Clamp" title="Keep each result between the target offset and max">
          <Toggle on={c.clamp} onChange={(v) => updateTransform(id, (x) => void (x.clamp = v))} />
        </Field>
      </Section>

      <Section
        id="transform.mappings"
        title="Mappings"
        actions={
          <IconButton
            icon={Plus}
            title="Add mapping"
            small
            onClick={() =>
              updateTransform(
                id,
                (x) => void x.properties.push({ prop: 'rotate', offset: 0, to: [{ prop: 'rotate', offset: 0, max: 1, scale: 1 }] }),
              )
            }
          />
        }
      >
        {c.properties.map((f, fi) =>
          f.to.map((t, ti) => (
            <div key={`${fi}-${ti}`} className="card">
              <div className="card-head">
                <SelectField
                  value={f.prop}
                  options={propOptions}
                  onChange={(v) => updateTransform(id, (x) => void (x.properties[fi].prop = v))}
                />
                <ArrowRight size={14} className="muted" />
                <SelectField
                  value={t.prop}
                  options={propOptions}
                  onChange={(v) => updateTransform(id, (x) => void (x.properties[fi].to[ti].prop = v))}
                />
                <IconButton
                  icon={X}
                  title="Remove mapping"
                  small
                  onClick={() =>
                    updateTransform(id, (x) => {
                      x.properties[fi].to.splice(ti, 1);
                      if (!x.properties[fi].to.length) x.properties.splice(fi, 1);
                    })
                  }
                />
              </div>
              <div className="grid2">
                <NumberField
                  label="from"
                  value={f.offset}
                  step={1}
                  title="Source value that maps to the target offset"
                  onChange={(v) => updateTransform(id, (x) => void (x.properties[fi].offset = v))}
                />
                <NumberField
                  label="to"
                  value={t.offset}
                  step={1}
                  title="Target value at the source offset"
                  onChange={(v) => updateTransform(id, (x) => void (x.properties[fi].to[ti].offset = v))}
                />
                <NumberField
                  label="×"
                  value={t.scale}
                  step={0.05}
                  precision={3}
                  title="Target change per unit of source change"
                  onChange={(v) => updateTransform(id, (x) => void (x.properties[fi].to[ti].scale = v))}
                />
                <NumberField
                  label="max"
                  value={t.max}
                  step={1}
                  title="Clamp limit (when Clamp is on)"
                  onChange={(v) => updateTransform(id, (x) => void (x.properties[fi].to[ti].max = v))}
                />
              </div>
            </div>
          )),
        )}
        {!c.properties.length && <p className="hint-text">No mappings: the constraint does nothing.</p>}
        {c.properties.length > 0 && (
          <Button
            small
            ghost
            disabled={animate}
            title="Set the offsets so the constraint changes nothing in the Setup pose: the bones stay where they are and follow the source from there"
            onClick={() => matchTransform(id)}
          >
            Match to current pose
          </Button>
        )}
      </Section>

      <Section
        id="transform.mix"
        title="Mix"
        actions={
          animate && (
            <KeyButton
              on={keyed}
              title={keyed ? 'Remove the mix key at the playhead' : 'Key the mixes at the playhead'}
              onClick={() => (keyed ? deleteKeys([{ kind: 'transform', target: id, prop: '', time }]) : setTransformMix(id, {}))}
            />
          )
        }
      >
        {MIX_KEYS.filter((k) => usedTo.has(k)).map((k) => (
          <Field key={k} label={PROP_LABEL[k]}>
            <NumberField
              label="%"
              value={mixOf(k) * 100}
              step={1}
              precision={0}
              min={0}
              max={100}
              keyed={animate && keyed}
              onChange={(v) => setTransformMix(id, { [k]: v / 100 })}
            />
          </Field>
        ))}
        {!usedTo.size && <p className="hint-text">Add a mapping to set mixes.</p>}
      </Section>

      <Section id="transform.offsets" title="Offsets applied to the source">
        <div className="grid2">
          {(['rotation', 'x', 'y', 'scaleX', 'scaleY', 'shearY'] as const).map((k) => (
            <NumberField
              key={k}
              label={k === 'rotation' ? '°' : k.replace('scale', 'S').replace('shear', 'Sh')}
              value={c.offsets[k]}
              step={k.startsWith('scale') ? 0.05 : 1}
              precision={2}
              onChange={(v) => updateTransform(id, (x) => void (x.offsets[k] = v))}
            />
          ))}
        </div>
      </Section>

      <div className="group">
        <Button danger icon={Trash2} onClick={() => deleteConstraint(id)}>
          Delete constraint
        </Button>
      </div>
    </>
  );
}
