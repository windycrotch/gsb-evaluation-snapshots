/** The key dialog: one key's time, values and interpolation typed in, where the graph and the dopesheet only drag. */
import { encodeKey, keyAtTime, resolveKeys } from '@/core/keyrefs';
import type { KeyRef } from '@/core/keyrefs';
import { currentAnimation, deleteKeys, moveKeysBy, setKeyChannelValue, setKeyCurveHandle, setKeysCurve, setTime } from '@/store/actions';
import { useProject } from '@/store/doc';
import { closeKeyDialog, keyDialogStore, useKeyDialog } from '@/store/keyDialog';
import { uiStore } from '@/store/ui';
import { Button, Dialog, NumberField, SelectField } from '../ui/controls';
import { Field } from '../ui/Field';
import { channelNames } from './GraphEditor';

type AnyKey = { time: number; value?: number[]; curve?: 'stepped' | number[] };

/** The kinds whose keys carry numbers to edit (the others have a time only). */
const NUMERIC = new Set<KeyRef['kind']>(['bone', 'slot', 'ik', 'transform', 'slider', 'path', 'physics']);

const kindOf = (k: AnyKey): 'linear' | 'stepped' | 'bezier' =>
  k.curve === 'stepped' ? 'stepped' : Array.isArray(k.curve) ? 'bezier' : 'linear';

/** Where the key dialog is mounted: renders nothing while no key is being edited. */
export function KeyDialogHost() {
  const ref = useKeyDialog();
  return ref ? <KeyDialog refKey={ref} /> : null;
}

function KeyDialog({ refKey }: { refKey: KeyRef }) {
  const fps = useProject().skeleton.fps; // also follows every edit of the document
  const anim = currentAnimation();
  const keys = anim ? resolveKeys(anim, refKey) : undefined;
  const key = keyAtTime(keys, refKey.time);
  const index = key && keys ? keys.indexOf(key) : -1;
  if (!anim || !keys || !key)
    return (
      <Dialog title="Edit key" onClose={closeKeyDialog}>
        <p className="hint-text">This key no longer exists.</p>
      </Dialog>
    );

  const numeric = NUMERIC.has(refKey.kind) && !!key.value && refKey.prop !== 'reset';
  const names = channelNames(refKey.kind, refKey.prop);
  const kind = kindOf(key);
  const last = index === keys.length - 1;
  const hasCurve = numeric && !last;

  const setFrame = (frame: number) => {
    // the key as it is NOW: a field commits on Enter and again on blur, before the dialog has drawn the first move
    const now = keyDialogStore.get().ref ?? refKey;
    const to = Math.max(0, frame) / fps;
    if (Math.abs(to - now.time) < 1e-6) return;
    const moved = moveKeysBy([now], to - now.time)[0];
    const old = encodeKey(now);
    const sel = uiStore.get().selectedKeys;
    if (sel.includes(old)) uiStore.patch({ selectedKeys: sel.map((s) => (s === old ? encodeKey(moved) : s)) });
    keyDialogStore.set({ ref: moved });
  };

  return (
    <Dialog
      title="Edit key"
      onClose={closeKeyDialog}
      width={360}
      footer={
        <>
          <Button
            danger
            ghost
            onClick={() => {
              deleteKeys([refKey]);
              closeKeyDialog();
            }}
          >
            Delete key
          </Button>
          <span className="spacer" />
          <Button onClick={() => setTime(key.time)}>Go to key</Button>
          <Button primary onClick={closeKeyDialog}>
            Done
          </Button>
        </>
      }
    >
      <Field label="Frame" title="The frame of the key (seconds are frame / fps)">
        <NumberField label="f" value={Math.round(key.time * fps * 100) / 100} step={1} precision={2} min={0} onChange={setFrame} />
        <span className="hint-text">{`${key.time.toFixed(3)} s`}</span>
      </Field>
      {numeric &&
        key.value!.map((v, c) => (
          <Field key={c} label={names[c] ?? `${c + 1}`} title="The value of the key (relative to the setup pose for bones)">
            <NumberField label="=" value={v} step={0.1} precision={4} onChange={(x) => setKeyChannelValue(refKey, c, x)} />
          </Field>
        ))}
      {hasCurve && (
        <>
          <Field label="Interpolation">
            <SelectField
              value={kind}
              options={[
                { value: 'linear', label: 'Linear' },
                { value: 'stepped', label: 'Stepped' },
                { value: 'bezier', label: 'Bezier (smooth)' },
              ]}
              onChange={(v: 'linear' | 'stepped' | 'bezier') => setKeysCurve([refKey], v)}
            />
          </Field>
          {kind === 'bezier' &&
            key.value!.map((_, c) => {
              const curve = key.curve as number[];
              const at = (i: number) => curve[c * 4 + i] ?? 0;
              const tip = 'A bezier handle: time (0 to 1 across the segment) and value (relative to the change)';
              return (
                <div key={c}>
                  <Field label={`${names[c] ?? c + 1} handle 1`} title={tip}>
                    <NumberField
                      label="t"
                      value={at(0)}
                      step={0.05}
                      precision={3}
                      min={0}
                      max={1}
                      onChange={(v) => setKeyCurveHandle(refKey, c, 1, v, at(1))}
                    />
                    <NumberField
                      label="v"
                      value={at(1)}
                      step={0.05}
                      precision={3}
                      onChange={(v) => setKeyCurveHandle(refKey, c, 1, at(0), v)}
                    />
                  </Field>
                  <Field label={`${names[c] ?? c + 1} handle 2`} title={tip}>
                    <NumberField
                      label="t"
                      value={at(2)}
                      step={0.05}
                      precision={3}
                      min={0}
                      max={1}
                      onChange={(v) => setKeyCurveHandle(refKey, c, 2, v, at(3))}
                    />
                    <NumberField
                      label="v"
                      value={at(3)}
                      step={0.05}
                      precision={3}
                      onChange={(v) => setKeyCurveHandle(refKey, c, 2, at(2), v)}
                    />
                  </Field>
                </div>
              );
            })}
        </>
      )}
      {numeric && last && <p className="hint-text">The last key of a timeline has no interpolation: it holds its value.</p>}
      {!numeric && <p className="hint-text">This key has no number to edit; move it with the frame.</p>}
    </Dialog>
  );
}
