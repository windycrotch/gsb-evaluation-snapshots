import { Film, Search, Trash2 } from 'lucide-react';
import { SEQUENCE_MODES } from '@/core/model';
import type { Id, MeshAttachment, RegionAttachment, SequenceMode } from '@/core/model';
import { resolveSequenceIndex, sequenceFrameNames, sequenceFramePath } from '@/core/sequence';
import { useProject } from '@/store/doc';
import { findFrames, keySequence, makeSequence, sequenceKeyAt, setSequence } from '@/store/sequenceActions';
import { useUi } from '@/store/ui';
import { getScene } from '@/store/scene';
import { Button, Hint, NumberField, SelectField } from '../ui/controls';
import { Field, KeyButton } from '../ui/Field';
import { Section } from '../ui/Section';

const MODE_LABEL: Record<SequenceMode, string> = {
  hold: 'Hold',
  once: 'Once',
  loop: 'Loop',
  pingpong: 'Ping-pong',
  onceReverse: 'Once, backwards',
  loopReverse: 'Loop, backwards',
  pingpongReverse: 'Ping-pong, backwards',
};

/** Frame-by-frame pictures of a region or mesh: how many, how they are named, and (Animate mode) the keys that play them. */
export function SequenceSection({ slotId, att }: { slotId: Id; att: RegionAttachment | MeshAttachment }) {
  const project = useProject();
  const mode = useUi((s) => s.mode);
  const time = useUi((s) => s.time);
  const animate = mode === 'animate';
  const seq = att.sequence;

  if (!seq) {
    if (animate) return null;
    return (
      <Section id="slot.sequence" title="Sequence" icon={Film}>
        <Hint>
          Show a different picture over time: smoke, fire, a blink drawn frame by frame. Number the pictures (flame01, flame02…) and press
          the button.
        </Hint>
        <Button
          icon={Film}
          onClick={() => makeSequence(slotId, att.name)}
          title="Use the numbered pictures that go with this one as the frames"
        >
          Make a sequence
        </Button>
      </Section>
    );
  }

  const have = new Set(project.images.map((i) => i.name));
  const missing = sequenceFrameNames(att.path, seq).filter((n) => !have.has(n));
  const current = animate ? getScene().skeleton.slotById(slotId) : undefined;
  const shown = resolveSequenceIndex(seq, current ? current.sequenceIndex : -1);
  const key = animate ? sequenceKeyAt(slotId, att.name, time) : undefined;
  const set = (patch: Partial<typeof seq>) => setSequence(slotId, att.name, { ...seq, ...patch });

  return (
    <Section id="slot.sequence" title="Sequence" icon={Film}>
      <div className="hstack wrap mb">
        <span className="chip">{`${seq.count} frames`}</span>
        <span className="chip">{`frame ${shown + 1} of ${seq.count}`}</span>
        {missing.length > 0 && (
          <span className="chip warn" title={missing.slice(0, 8).join(', ')}>{`${missing.length} pictures missing`}</span>
        )}
      </div>
      {!animate && (
        <>
          <Field label="Frames" title="How many pictures the sequence has">
            <NumberField
              label="n"
              value={seq.count}
              step={1}
              precision={0}
              min={1}
              max={9999}
              onChange={(v) => set({ count: Math.round(v), setupIndex: Math.min(seq.setupIndex, Math.max(0, Math.round(v) - 1)) })}
            />
          </Field>
          <Field label="First number" title="The number in the name of the first picture">
            <NumberField label="#" value={seq.start} step={1} precision={0} min={0} onChange={(v) => set({ start: Math.round(v) })} />
          </Field>
          <Field label="Digits" title="Zero padding of the number: 2 gives 01, 02 … (0 for none)">
            <NumberField
              label="d"
              value={seq.digits}
              step={1}
              precision={0}
              min={0}
              max={9}
              onChange={(v) => set({ digits: Math.round(v) })}
            />
          </Field>
          <Field label="Setup frame" title="The frame that shows while no sequence key plays (0 is the first)">
            <NumberField
              label="i"
              value={seq.setupIndex}
              step={1}
              precision={0}
              min={0}
              max={seq.count - 1}
              onChange={(v) => set({ setupIndex: Math.round(v) })}
            />
          </Field>
          <p className="hint-text">{`Pictures: ${sequenceFramePath(att.path, seq, 0)}, …`}</p>
          <div className="hstack">
            <Button icon={Search} onClick={() => findFrames(slotId, att.name)} title="Look for the numbered pictures again">
              Find frames
            </Button>
            <Button
              icon={Trash2}
              onClick={() => setSequence(slotId, att.name, null)}
              title="Show one picture again; the sequence keys of this attachment go too"
            >
              Remove
            </Button>
          </div>
        </>
      )}
      {animate && (
        <>
          <Field
            label="Mode"
            title="How the frames advance after this key"
            keyButton={
              <KeyButton
                on={!!key && Math.abs(key.time - time) < 1e-3}
                title="Key the sequence"
                onClick={() => keySequence(slotId, att.name)}
              />
            }
          >
            <SelectField<SequenceMode>
              value={key?.mode ?? 'hold'}
              options={SEQUENCE_MODES.map((m) => ({ value: m, label: MODE_LABEL[m] }))}
              onChange={(m) => keySequence(slotId, att.name, { mode: m })}
            />
          </Field>
          <Field label="Frame" title="The frame this key starts from (0 is the first)">
            <NumberField
              label="i"
              value={key?.index ?? 0}
              step={1}
              precision={0}
              min={0}
              max={seq.count - 1}
              onChange={(v) => keySequence(slotId, att.name, { index: Math.round(v) })}
            />
          </Field>
          <Field label="Delay" title="Seconds each frame stays (hold ignores it)">
            <NumberField
              label="s"
              value={key?.delay ?? 0}
              step={0.01}
              precision={3}
              min={0}
              onChange={(v) => keySequence(slotId, att.name, { delay: v })}
            />
          </Field>
        </>
      )}
    </Section>
  );
}
