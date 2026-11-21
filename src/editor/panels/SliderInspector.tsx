import { SlidersHorizontal, Trash2 } from 'lucide-react';
import { hasKey } from '@/core/edit';
import { TRANSFORM_PROPS } from '@/core/model';
import type { Id } from '@/core/model';
import { currentAnimation, deleteKeys } from '@/store/actions';
import { useProject } from '@/store/doc';
import { deleteConstraint } from '@/store/ikActions';
import { currentSliderValues, setSliderValues, updateSlider } from '@/store/sliderActions';
import { useUi } from '@/store/ui';
import { Button, Hint, NumberField, SelectField, Toggle } from '../ui/controls';
import { Field, KeyButton } from '../ui/Field';
import { Section } from '../ui/Section';
import { ConstraintHeader } from './ConstraintHeader';

const PROPERTY_LABEL: Record<string, string> = {
  rotate: 'Rotation',
  x: 'X',
  y: 'Y',
  scaleX: 'Scale X',
  scaleY: 'Scale Y',
  shearY: 'Shear Y',
};

/** Spine 4.3 slider: applies an animation at a hand-set (keyable) time, or at a time driven by a bone property. */
export function SliderInspector({ id }: { id: Id }) {
  const project = useProject();
  const mode = useUi((s) => s.mode);
  const time = useUi((s) => s.time);
  useUi((s) => s.overrides);
  const doc = project.skeleton;
  const c = doc.constraints.find((x) => x.id === id);
  if (!c || c.type !== 'slider') return null;
  const animate = mode === 'animate';
  const anim = currentAnimation();
  const keyedAt = (prop: 'time' | 'mix') => {
    const keys = anim?.slider[id]?.[prop];
    return hasKey(keys, time);
  };
  const v = (animate ? currentSliderValues(id) : null) ?? { time: c.time, mix: c.mix };
  const applied = c.animation ? doc.animations.find((a) => a.id === c.animation) : undefined;
  const keyButton = (prop: 'time' | 'mix') => (
    <KeyButton
      on={keyedAt(prop)}
      title={keyedAt(prop) ? `Remove the ${prop} key at the playhead` : `Key the ${prop} at the playhead`}
      onClick={() => (keyedAt(prop) ? deleteKeys([{ kind: 'slider', target: id, prop, time }]) : setSliderValues(id, { [prop]: v[prop] }))}
    />
  );

  return (
    <>
      <ConstraintHeader id={id} title="Slider" icon={SlidersHorizontal} kind="slider" deleteTitle="Delete slider" />

      <Section id="slider.animation" title="Animation">
        <Field label="Applies">
          <SelectField
            value={c.animation ?? ''}
            options={[{ value: '', label: '— choose —' }, ...doc.animations.map((a) => ({ value: a.id, label: a.name }))]}
            onChange={(a) => updateSlider(id, { animation: a || null })}
          />
        </Field>
        {!applied && <Hint>Without an animation the slider does nothing and is left out of the export.</Hint>}
        <Field label="Mix" keyButton={keyButton('mix')}>
          <NumberField
            label="%"
            value={v.mix * 100}
            step={1}
            precision={0}
            min={0}
            keyed={animate && keyedAt('mix')}
            onChange={(x) => setSliderValues(id, { mix: Math.max(0, x) / 100 })}
          />
        </Field>
        <Field label="Additive" title="Add the animation's values to the current pose instead of replacing them">
          <Toggle on={c.additive} onChange={(x) => updateSlider(id, { additive: x })} />
        </Field>
        <Field label="Loop" title="Wrap the time around the animation's length instead of clamping it">
          <Toggle on={c.loop} onChange={(x) => updateSlider(id, { loop: x })} />
        </Field>
      </Section>

      <Section id="slider.time" title="Time">
        <Field label="Driver">
          <SelectField
            value={c.bone ?? ''}
            options={[{ value: '', label: '— manual time —' }, ...doc.bones.map((b) => ({ value: b.id, label: b.name }))]}
            onChange={(b) => updateSlider(id, { bone: b || null })}
          />
        </Field>
        {c.bone ? (
          <>
            <Field label="Property">
              <SelectField
                value={c.property}
                options={TRANSFORM_PROPS.map((p) => ({ value: p, label: PROPERTY_LABEL[p] ?? p }))}
                onChange={(p) => updateSlider(id, { property: p })}
              />
            </Field>
            <Field label="From">
              <NumberField
                label={c.property === 'rotate' || c.property === 'shearY' ? '°' : ''}
                value={c.from}
                step={1}
                precision={2}
                onChange={(x) => updateSlider(id, { from: x })}
              />
            </Field>
            <Field label="To">
              <NumberField label="s" value={c.to} step={0.05} precision={3} onChange={(x) => updateSlider(id, { to: x })} />
            </Field>
            <Field label="Scale">
              <NumberField label="s/unit" value={c.scale} step={0.001} precision={4} onChange={(x) => updateSlider(id, { scale: x })} />
            </Field>
            <Field label="Local" title="Read the bone's local transform instead of its world transform">
              <Toggle on={c.local} onChange={(x) => updateSlider(id, { local: x })} />
            </Field>
            <p className="hint-text">time = to + (value − from) × scale</p>
          </>
        ) : (
          <Field label="Time" keyButton={keyButton('time')}>
            <NumberField
              label="s"
              value={v.time}
              step={0.05}
              precision={3}
              min={0}
              keyed={animate && keyedAt('time')}
              onChange={(x) => setSliderValues(id, { time: Math.max(0, x) })}
            />
          </Field>
        )}
        {applied && <p className="hint-text">{`"${applied.name}" is ${applied.duration.toFixed(2)} s long`}</p>}
      </Section>

      <div className="group">
        <Button danger icon={Trash2} onClick={() => deleteConstraint(id)}>
          Delete slider
        </Button>
      </div>
    </>
  );
}
