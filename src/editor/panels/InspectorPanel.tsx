import { PathAttachmentInspector, PointInspector, PolygonInspector, RegionInspector } from './AttachmentInspectors';
import { hasKey } from '@/core/edit';
import { ConstraintEffects } from './ConstraintEffects';
import { PivotSection } from './PivotSection';
import { Bone as BoneIcon, Crosshair, Layers, Link2, Scissors, Spline, X } from 'lucide-react';
import { useState } from 'react';
import { createTransformConstraint, PRESET_LABEL } from '@/store/transformActions';
import type { TransformPreset } from '@/store/transformActions';
import { AXIS_GROUPS, INHERIT_MODES } from '@/core/model';
import { isSplit } from '@/core/axes';
import { setAxesSplit } from '@/store/axisActions';
import type { AxisGroup, BlendMode, BoneProp, Id, Inherit, PhysicsParam } from '@/core/model';
import { BLEND_MODES, attachmentImage } from '@/core/model';
import { folderOfSlot } from '@/core/folders';
import { deleteFolder, renameFolder, setSlotFolder } from '@/store/folderActions';
import {
  setSelection,
  deleteKeys,
  keyConstrainedBones,
  keySelectedBones,
  removeSkinImage,
  renameBone,
  renameSlot,
  setAnimationDuration,
  setBonePose,
  setBoneProps,
  setFps,
  setSkinImage,
  setSlotAttachment,
  setSlotBone,
  setSlotColor,
  setSlotProps,
  currentAnimation,
} from '@/store/actions';
import type { PoseProps } from '@/store/actions';
import { useProject } from '@/store/doc';
import { MAX_SPLIT } from '@/core/split';
import { splitBone } from '@/store/splitActions';
import { limitDrivenBy, rotationLimitOf } from '@/core/limits';
import { CHAIN_PARAMS, CHAIN_SHAPES, chainBones, chainValues, shapeAt } from '@/core/chains';
import type { ChainShape } from '@/core/chains';
import { applyChainCurve } from '@/store/chainActions';
import { addLimit, removeLimit, setLimit } from '@/store/limitActions';
import { uiStore, useUi } from '@/store/ui';
import { getScene } from '@/store/scene';
import { Button, ColorSwatch, Hint, IconButton, NumberField, SelectField, TextField, Toggle } from '../ui/controls';
import { Field, KeyButton } from '../ui/Field';
import { Section } from '../ui/Section';
import { activeIndex } from '@/core/skeletons';
import { renameSkeletonAt } from '@/store/skeletonActions';
import { useFloats } from '@/store/floats';
import { ConvertToMeshGroup, LinkedMeshFields, MeshGroup } from './MeshInspector';
import { SequenceSection } from './SequenceSection';
import { ConstraintInspector } from './ConstraintInspector';
import { projectStats, projectWarnings } from '@/core/stats';

/** The short names of the three split switches. */
const AXIS_SHORT: Record<AxisGroup, string> = { translate: 'Pos', scale: 'Scl', shear: 'Shr' };

function BoneInspector({ id }: { id: Id }) {
  const project = useProject();
  const selectedIds = useUi((s) => s.selection.bones);
  const mode = useUi((s) => s.mode);
  const time = useUi((s) => s.time);
  const compensate = useUi((s) => s.compensate);
  useUi((s) => s.overrides);
  const doc = project.skeleton;
  const bone = doc.bones.find((b) => b.id === id);
  const anim = currentAnimation();
  if (!bone) return null;
  const animate = mode === 'animate';
  const sb = getScene().skeleton.boneById(id);
  const pose: Required<PoseProps> =
    animate && sb
      ? { x: sb.x, y: sb.y, rotation: sb.rotation, scaleX: sb.scaleX, scaleY: sb.scaleY, shearX: sb.shearX, shearY: sb.shearY }
      : {
          x: bone.x,
          y: bone.y,
          rotation: bone.rotation,
          scaleX: bone.scaleX,
          scaleY: bone.scaleY,
          shearX: bone.shearX,
          shearY: bone.shearY,
        };
  const set = (props: PoseProps) => setBonePose([{ id, props }], 'Edit bone');
  // a bone with a rotation limit is turned by its control bone: that is the rotation shown, keyed and edited here
  const limit = rotationLimitOf(doc, id);
  const control = limit ? doc.bones.find((b) => b.id === limit.control) : undefined;
  const controlScene = limit ? getScene().skeleton.boneById(limit.control) : undefined;
  if (limit && control) pose.rotation = animate && controlScene ? controlScene.rotation : control.rotation;
  const keyedOn = (p: BoneProp) => (p === 'rotate' && limit ? limit.control : id);
  const keyed = (p: BoneProp) => animate && hasKey(anim?.bones[keyedOn(p)]?.[p], time);
  const keyButton = (p: BoneProp, label: string) => (
    <KeyButton
      on={keyed(p)}
      title={`${keyed(p) ? 'Remove' : 'Set'} ${label} key at the playhead`}
      onClick={() => (keyed(p) ? deleteKeys([{ kind: 'bone', target: keyedOn(p), prop: p, time }]) : keySelectedBones([p]))}
    />
  );
  const tl = anim?.bones[id];
  /** One row for a group of two values, or one row per axis once the group is split (each axis then has its own key button). */
  const pair = (
    g: AxisGroup,
    label: string,
    step: number,
    precision: number,
    x: number,
    y: number,
    setX: (v: number) => void,
    setY: (v: number) => void,
  ) => {
    const [ax, ay] = AXIS_GROUPS[g];
    if (animate && isSplit(tl, g)) {
      return (
        <>
          <Field label={`${label} X`} keyButton={keyButton(ax, `${label} X`)}>
            <NumberField label="X" value={x} step={step} precision={precision} keyed={keyed(ax)} onChange={setX} />
          </Field>
          <Field label={`${label} Y`} keyButton={keyButton(ay, `${label} Y`)}>
            <NumberField label="Y" value={y} step={step} precision={precision} keyed={keyed(ay)} onChange={setY} />
          </Field>
        </>
      );
    }
    return (
      <Field label={label} keyButton={keyButton(g, g)}>
        <NumberField label="X" value={x} step={step} precision={precision} keyed={keyed(g)} onChange={setX} />
        <NumberField label="Y" value={y} step={step} precision={precision} keyed={keyed(g)} onChange={setY} />
      </Field>
    );
  };

  return (
    <>
      <Section
        id="bone.name"
        title="Bone"
        icon={BoneIcon}
        collapsible={false}
        actions={animate && <span className="chip animate">animating</span>}
      >
        <TextField name="Bone name" value={bone.name} onCommit={(v) => renameBone(id, v)} wide />
      </Section>
      <Section
        id="bone.transform"
        title="Transform"
        actions={
          animate && (
            <>
              <Button
                ghost
                small
                title="Key the pose the bone has after the constraints (IK, physics, ...) instead of its own pose"
                onClick={() => keyConstrainedBones()}
              >
                Key constrained
              </Button>
              <Button ghost small title="Key all transform channels" onClick={() => keySelectedBones()}>
                Key all
              </Button>
            </>
          )
        }
      >
        <Field label="Rotation" keyButton={keyButton('rotate', 'rotation')}>
          <NumberField label="°" value={pose.rotation} step={1} keyed={keyed('rotate')} onChange={(v) => set({ rotation: v })} />
        </Field>
        {pair(
          'translate',
          'Position',
          1,
          2,
          pose.x,
          pose.y,
          (v) => set({ x: v }),
          (v) => set({ y: v }),
        )}
        {pair(
          'scale',
          'Scale',
          0.01,
          3,
          pose.scaleX,
          pose.scaleY,
          (v) => set({ scaleX: v }),
          (v) => set({ scaleY: v }),
        )}
        {pair(
          'shear',
          'Shear',
          1,
          2,
          pose.shearX,
          pose.shearY,
          (v) => set({ shearX: v }),
          (v) => set({ shearY: v }),
        )}
        {!animate && (
          <>
            <Field label="Keep children" title="Compensation: the child bones stay where they are in the scene while this bone is edited">
              <Toggle
                on={compensate.bones}
                onChange={(v) => uiStore.patch({ compensate: { ...compensate, bones: v } })}
                title="Keep children in place"
              />
            </Field>
            <Field
              label="Keep images"
              title="Compensation: the pictures, points and outlines on this bone stay where they are in the scene while it is edited"
            >
              <Toggle
                on={compensate.images}
                onChange={(v) => uiStore.patch({ compensate: { ...compensate, images: v } })}
                title="Keep images in place"
              />
            </Field>
          </>
        )}
        {animate && (
          <Field
            label="Split X / Y"
            title="Key position, scale or shear one axis at a time: X and Y get their own timelines (Spine's split timelines)"
          >
            <div className="hstack">
              {(['translate', 'scale', 'shear'] as const).map((g) => (
                <span key={g} className="hstack">
                  <span className="dim">{AXIS_SHORT[g]}</span>
                  <Toggle
                    on={isSplit(tl, g)}
                    title={isSplit(tl, g) ? `Merge ${g} X / Y into one timeline` : `Split ${g} into X and Y timelines`}
                    onChange={(v) => setAxesSplit([id], g, v)}
                  />
                </span>
              ))}
            </div>
          </Field>
        )}
      </Section>
      <Section id="bone.setup" title="Bone setup">
        <Field label="Length">
          <NumberField
            label="L"
            value={bone.length}
            step={1}
            disabled={animate}
            onChange={(v) => setBoneProps(id, { length: Math.max(0, v) })}
          />
        </Field>
        <Field label="Inherit">
          <SelectField
            value={bone.inherit}
            options={INHERIT_MODES.map((m) => ({ value: m, label: m.replace(/([A-Z])/g, ' $1').toLowerCase() }))}
            onChange={(v: Inherit) => setBoneProps(id, { inherit: v })}
          />
        </Field>
        <Field label="Color">
          <div className="hstack">
            <ColorSwatch value={bone.color} onChange={(rgb) => setBoneProps(id, { color: [rgb[0], rgb[1], rgb[2], 1] }, 'Bone color')} />
            <span className="hint-text">editor only</span>
          </div>
        </Field>
        <Field label="Name on screen" title="Draw the name of this bone in the viewport even when Bone names is off (editor only)">
          <Toggle
            on={!!bone.showName}
            onChange={(v) => setBoneProps(id, { showName: v || undefined }, 'Bone name on screen')}
            title="Name on screen"
          />
        </Field>
      </Section>
      <LimitSection id={id} animate={animate} />
      <PivotSection id={id} />
      <ConstraintEffects id={id} />
      {!animate && <ChainSection id={id} />}
      {!animate && <SplitSection id={id} rootBone={!bone.parent} />}
      {!animate && <TransformCreate boneIds={selectedIds} />}
    </>
  );
}

/** The sector a bone may swing in: a control bone and a clamped transform constraint (see core/limits). */
function LimitSection({ id, animate }: { id: Id; animate: boolean }) {
  const project = useProject();
  const [half, setHalf] = useState(60);
  const doc = project.skeleton;
  const limit = rotationLimitOf(doc, id);
  const driven = limitDrivenBy(doc, id);
  const shown = limit ?? driven;
  if (!shown && (animate || !doc.bones.find((b) => b.id === id)?.parent)) return null;
  const nameOf = (b: Id) => doc.bones.find((x) => x.id === b)?.name ?? '';
  return (
    <Section id="bone.limit" title="Rotation limit" icon={Crosshair} kind="transform">
      {shown ? (
        <>
          <Hint>
            {limit
              ? `Rotate "${nameOf(limit.control)}" (the control bone): "${nameOf(limit.bone)}" follows it inside the sector and stops at its ends.`
              : `This is the control bone of the limit on "${nameOf(shown.bone)}": it can turn all the way round, that bone stays in the sector.`}
          </Hint>
          <Field label="Sector">
            <NumberField
              label="−"
              value={shown.min}
              step={1}
              precision={0}
              onChange={(v) => setLimit(shown.bone, Math.min(v, shown.max - 1), shown.max)}
            />
            <NumberField
              label="+"
              value={shown.max}
              step={1}
              precision={0}
              onChange={(v) => setLimit(shown.bone, shown.min, Math.max(v, shown.min + 1))}
            />
          </Field>
          <div className="hstack">
            <Button small onClick={() => setSelection({ bones: [limit ? limit.control : shown.bone] })}>
              {limit ? 'Select control bone' : 'Select limited bone'}
            </Button>
            {!animate && (
              <Button small onClick={() => removeLimit(shown.bone)}>
                Remove limit
              </Button>
            )}
          </div>
        </>
      ) : (
        <>
          <Hint>
            Keep this bone inside a sector of angles (a knee that does not bend backwards, a neck that does not spin). It is a transform
            constraint with a clamp, so it exports and plays in every Spine runtime.
          </Hint>
          <Field label="Half width">
            <NumberField
              label="°"
              value={half}
              step={5}
              precision={0}
              min={1}
              max={179}
              onChange={(v) => setHalf(Math.max(1, Math.min(179, Math.round(v))))}
            />
          </Field>
          <Button icon={Crosshair} onClick={() => addLimit(id, half)}>
            Add rotation limit
          </Button>
        </>
      )}
    </Section>
  );
}

/** Defaults of the chain curve per parameter: the first bone's value and the last bone's. */
const CHAIN_DEFAULTS: Record<PhysicsParam, [number, number]> = {
  strength: [300, 60],
  damping: [0.9, 0.7],
  inertia: [0.9, 0.4],
  mass: [1, 1],
  mix: [1, 1],
  wind: [0, 1],
  gravity: [0, 1],
};

const CHAIN_PARAM_LABEL: Record<PhysicsParam, string> = {
  strength: 'Strength',
  damping: 'Damping',
  inertia: 'Inertia',
  mass: 'Mass',
  mix: 'Mix',
  wind: 'Wind',
  gravity: 'Gravity',
};

const CHAIN_SHAPE_LABEL: Record<ChainShape, string> = { linear: 'Straight', in: 'Slow start', out: 'Fast start', smooth: 'S-curve' };

/** One physics parameter spread over the bones of a chain (tail, spine) along a curve: stiff at the root, loose at the tip. */
function ChainSection({ id }: { id: Id }) {
  const project = useProject();
  const [param, setParam] = useState<PhysicsParam>('strength');
  const [from, setFrom] = useState(CHAIN_DEFAULTS.strength[0]);
  const [to, setTo] = useState(CHAIN_DEFAULTS.strength[1]);
  const [shape, setShape] = useState<ChainShape>('linear');
  const [power, setPower] = useState(2);
  const [create, setCreate] = useState(true);
  const selected = useUi((s) => s.selection.bones);
  const doc = project.skeleton;
  const chain = chainBones(doc, selected.length ? selected : [id]).filter((b) => doc.bones.some((x) => x.id === b && x.parent));
  if (chain.length < 2) return null;
  const values = chainValues(chain.length, from, to, shape, power);
  const lo = Math.min(...values, from, to);
  const hi = Math.max(...values, from, to);
  const span = hi - lo || 1;
  const pick = (p: PhysicsParam) => {
    setParam(p);
    setFrom(CHAIN_DEFAULTS[p][0]);
    setTo(CHAIN_DEFAULTS[p][1]);
  };
  const W = 200;
  const H = 54;
  const pts = values.map(
    (v, i) => [chain.length === 1 ? 0 : 8 + (i / (chain.length - 1)) * (W - 16), H - 8 - ((v - lo) / span) * (H - 16)] as const,
  );
  const curve = Array.from({ length: 41 }, (_, i) => {
    const t = i / 40;
    const v = from + (to - from) * shapeAt(t, shape, power);
    return `${(8 + t * (W - 16)).toFixed(1)},${(H - 8 - ((v - lo) / span) * (H - 16)).toFixed(1)}`;
  }).join(' ');
  return (
    <Section id="bone.chain" title="Chain curve" icon={Spline}>
      <Hint>{`Spreads one physics value over ${chain.length} bones along a curve, so a tail or a spine gets its stiffness without typing it bone by bone.`}</Hint>
      <Field label="Value">
        <SelectField<PhysicsParam>
          value={param}
          options={CHAIN_PARAMS.map((p) => ({ value: p, label: CHAIN_PARAM_LABEL[p] }))}
          onChange={pick}
        />
      </Field>
      <Field label="First → last">
        <NumberField
          label="1"
          value={from}
          step={param === 'strength' ? 10 : 0.05}
          precision={param === 'strength' ? 0 : 2}
          onChange={setFrom}
        />
        <NumberField
          label="n"
          value={to}
          step={param === 'strength' ? 10 : 0.05}
          precision={param === 'strength' ? 0 : 2}
          onChange={setTo}
        />
      </Field>
      <Field label="Curve">
        <SelectField<ChainShape>
          value={shape}
          options={CHAIN_SHAPES.map((s) => ({ value: s, label: CHAIN_SHAPE_LABEL[s] }))}
          onChange={setShape}
        />
      </Field>
      {shape !== 'linear' && (
        <Field label="Bend">
          <NumberField
            label="×"
            value={power}
            step={0.25}
            precision={2}
            min={0.25}
            max={6}
            onChange={(v) => setPower(Math.max(0.25, Math.min(6, v)))}
          />
        </Field>
      )}
      <svg className="chain-preview" viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Chain curve">
        <polyline points={curve} fill="none" stroke="var(--accent)" strokeWidth="1.5" opacity="0.7" />
        {pts.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="3" fill="var(--accent)" />
        ))}
      </svg>
      <Field label="Add missing constraints">
        <Toggle
          on={create}
          onChange={setCreate}
          title="Bones of the chain without a physics constraint get one. Off: only the constraints that exist are changed"
        />
      </Field>
      <Button icon={Spline} onClick={() => applyChainCurve(chain, { param, from, to, shape, power, create })}>
        Apply to the chain
      </Button>
    </Section>
  );
}

function SplitSection({ id, rootBone }: { id: Id; rootBone: boolean }) {
  const [count, setCount] = useState(3);
  const [nested, setNested] = useState(true);
  const [fibonacci, setFibonacci] = useState(false);
  const [weights, setWeights] = useState<'keep' | 'split' | 'blend'>('blend');
  return (
    <Section id="bone.split" title="Split" icon={Scissors}>
      <Hint>Cut this bone into shorter bones along its length: a chain for a tail, a spine or a tentacle.</Hint>
      <Field label="Parts">
        <NumberField
          label="#"
          value={count}
          step={1}
          precision={0}
          min={2}
          max={MAX_SPLIT}
          onChange={(v) => setCount(Math.max(2, Math.min(MAX_SPLIT, Math.round(v))))}
        />
      </Field>
      <Field label="Nested">
        <Toggle
          on={nested || rootBone}
          onChange={setNested}
          title="Each new bone is a child of the one before it. Off: they stand side by side under the parent"
        />
      </Field>
      <Field label="Fibonacci">
        <Toggle
          on={fibonacci}
          onChange={setFibonacci}
          title="Each bone is shorter than the one before it (5 3 2 1 1). Off: equal lengths"
        />
      </Field>
      <Field
        label="Mesh weights"
        title="Meshes that follow this bone: keep all their weight on the first part, give each vertex to the part it lies on, or share it smoothly around each cut"
      >
        <SelectField<'keep' | 'split' | 'blend'>
          value={weights}
          options={[
            { value: 'blend', label: 'Blend at the cuts' },
            { value: 'split', label: 'By position' },
            { value: 'keep', label: 'Keep on the first' },
          ]}
          onChange={setWeights}
        />
      </Field>
      <Button icon={Scissors} onClick={() => splitBone(id, count, { nested: nested || rootBone, fibonacci, weights })}>
        Split bone
      </Button>
    </Section>
  );
}

function TransformCreate({ boneIds }: { boneIds: Id[] }) {
  const project = useProject();
  const [source, setSource] = useState<Id>('');
  const [preset, setPreset] = useState<TransformPreset>('rotation');
  const bones = project.skeleton.bones.filter((b) => !boneIds.includes(b.id));
  const src = bones.some((b) => b.id === source) ? source : (bones[0]?.id ?? '');
  return (
    <Section id="bone.constraint" title="Transform constraint" icon={Link2} kind="transform">
      <Hint>{`Make ${boneIds.length > 1 ? 'these bones' : 'this bone'} follow another bone's rotation, position or scale (Spine 4.3 mappings).`}</Hint>
      <Field label="Follow">
        <SelectField value={src} options={bones.map((b) => ({ value: b.id, label: b.name }))} onChange={setSource} />
      </Field>
      <Field label="Preset">
        <SelectField
          value={preset}
          options={(Object.keys(PRESET_LABEL) as TransformPreset[]).map((p) => ({ value: p, label: PRESET_LABEL[p] }))}
          onChange={setPreset}
        />
      </Field>
      <Button icon={Link2} onClick={() => createTransformConstraint(boneIds, src, preset)} disabled={!src}>
        Create constraint
      </Button>
    </Section>
  );
}

/** The tint of a slot (and its dark tint): in the Inspector, or in the floating Slot color window. In Animate mode the keys go with the playhead. */
export function SlotColorFields({ slotId }: { slotId: Id }) {
  const project = useProject();
  const mode = useUi((s) => s.mode);
  useUi((s) => (s.mode === 'animate' ? s.time : 0)); // the animated tint follows the playhead
  const slot = project.skeleton.slots.find((x) => x.id === slotId);
  if (!slot) return null;
  const animate = mode === 'animate';
  const sk = getScene().skeleton.slotById(slotId);
  const color = animate && sk ? sk.color : slot.color;
  const dark = animate && sk?.dark ? sk.dark : slot.dark; // the animated dark color in Animate mode
  const darkNow = animate && dark ? dark : undefined; // keyed together with the light color
  return (
    <>
      <Field
        label="Tint"
        keyButton={
          <KeyButton on={false} title="Key color" onClick={() => setSlotColor(slotId, [color[0], color[1], color[2], color[3]], darkNow)} />
        }
      >
        <div className="hstack">
          <ColorSwatch value={color} onChange={(rgb) => setSlotColor(slotId, [rgb[0], rgb[1], rgb[2], color[3]], darkNow)} />
          <NumberField
            label="A"
            value={color[3]}
            step={0.01}
            precision={2}
            min={0}
            max={1}
            onChange={(v) => setSlotColor(slotId, [color[0], color[1], color[2], v], darkNow)}
          />
        </div>
      </Field>
      {(!animate || dark) && (
        <Field label="Dark tint">
          <div className="hstack">
            {!animate && (
              <Toggle
                on={!!slot.dark}
                onChange={(on) => setSlotProps(slotId, { dark: on ? [0, 0, 0] : null }, 'Dark tint')}
                title="Two-color tint: a dark color that fills in where the image is dark (glow, hit flash)"
              />
            )}
            {dark && (
              <ColorSwatch
                value={dark}
                title="Dark color"
                onChange={(rgb) =>
                  animate
                    ? setSlotColor(slotId, [color[0], color[1], color[2], color[3]], rgb)
                    : setSlotProps(slotId, { dark: rgb }, 'Dark color')
                }
              />
            )}
          </div>
        </Field>
      )}
    </>
  );
}

function SlotInspector({ slotId, attachmentName }: { slotId: Id; attachmentName: string | null }) {
  const project = useProject();
  const mode = useUi((s) => s.mode);
  const skinId = useUi((s) => s.skinId); // every hook goes above the early return: undo can remove the selected slot between two renders
  const colorFloats = useFloats((s) => s.open.slotColor); // the tint lives in its own window while that is open
  const meshFloats = useFloats((s) => s.open.meshTools);
  useUi((s) => (s.mode === 'animate' ? s.time : 0)); // the animated tint follows the playhead
  const doc = project.skeleton;
  const slot = doc.slots.find((s) => s.id === slotId);
  if (!slot) return null;
  const atts = doc.skins[0]?.attachments[slotId] ?? {};
  const att = attachmentName ? atts[attachmentName] : undefined;
  const animate = mode === 'animate';
  const sk = getScene().skeleton.slotById(slotId);
  const current = animate && sk ? sk.attachmentName : slot.attachment;
  const attOptions = [{ value: '', label: '— none —' }, ...Object.keys(atts).map((n) => ({ value: n, label: n }))];
  const folder = folderOfSlot(doc, slotId);
  const activeSkin = skinId && skinId !== doc.skins[0]?.id ? doc.skins.find((s) => s.id === skinId) : undefined;

  return (
    <>
      <Section id="slot.name" title="Slot" icon={Layers} collapsible={false}>
        <TextField name="Slot name" value={slot.name} onCommit={(v) => renameSlot(slotId, v)} wide />
      </Section>
      <div className="group">
        <Field label="Bone">
          <SelectField
            value={slot.bone}
            options={doc.bones.map((b) => ({ value: b.id, label: b.name }))}
            onChange={(v) => setSlotBone(slotId, v)}
          />
        </Field>
        <Field
          label={att && attachmentImage(att) === null ? 'Shape' : 'Image'}
          keyButton={<KeyButton on={false} title="Key attachment" onClick={() => setSlotAttachment(slotId, current)} />}
        >
          <SelectField value={current ?? ''} options={attOptions} onChange={(v) => setSlotAttachment(slotId, v || null)} />
        </Field>
        {activeSkin && att && attachmentImage(att) !== null && (
          <Field label="In skin">
            <SelectField
              value={(activeSkin.attachments[slotId]?.[att.name] && attachmentImage(activeSkin.attachments[slotId][att.name])) || ''}
              options={[
                { value: '', label: `default (${attachmentImage(att)})` },
                ...project.images.map((i) => ({ value: i.name, label: i.name })),
              ]}
              onChange={(v) => (v ? setSkinImage(activeSkin.id, slotId, att.name, v) : removeSkinImage(activeSkin.id, slotId, att.name))}
            />
          </Field>
        )}
        {activeSkin &&
          att &&
          (() => {
            const own = activeSkin.attachments[slotId]?.[att.name];
            return own?.type === 'mesh' && own.link ? (
              <LinkedMeshFields skinId={activeSkin.id} slotId={slotId} name={att.name} mesh={own} />
            ) : null;
          })()}
        <Field label="Blend">
          <SelectField
            value={slot.blend}
            options={BLEND_MODES.map((b) => ({ value: b, label: b }))}
            onChange={(v: BlendMode) => setSlotProps(slotId, { blend: v }, 'Blend mode')}
          />
        </Field>
        {!animate && (
          <Field
            label="Folder"
            title="Draw order folder: slots of a folder swap places with each other when you key the draw order, the other slots stay where they are"
          >
            <SelectField
              value={folder?.id ?? ''}
              options={[
                { value: '', label: '— none —' },
                ...(doc.drawOrderFolders ?? []).map((x) => ({ value: x.id, label: x.name })),
                { value: 'new', label: '+ new folder' },
              ]}
              onChange={(v) => setSlotFolder(slotId, v === '' ? null : v)}
            />
          </Field>
        )}
        {!animate && folder && (
          <Field label="Folder name">
            <TextField name="Folder name" value={folder.name} onCommit={(v) => renameFolder(folder.id, v)} wide />
            <IconButton
              icon={X}
              small
              title="Delete the folder (its slots stay, its draw order keys go)"
              onClick={() => deleteFolder(folder.id)}
            />
          </Field>
        )}
        {!colorFloats && <SlotColorFields slotId={slotId} />}
      </div>
      {att && att.type === 'region' && <RegionInspector slotId={slotId} att={att} disabled={animate} />}
      {att && att.type === 'region' && !animate && !meshFloats && <ConvertToMeshGroup slotId={slotId} name={att.name} />}
      {att && att.type === 'mesh' && <MeshGroup slotId={slotId} att={att} />}
      {att && (att.type === 'region' || att.type === 'mesh') && <SequenceSection slotId={slotId} att={att} />}
      {att && (att.type === 'clipping' || att.type === 'boundingbox') && <PolygonInspector slotId={slotId} att={att} disabled={animate} />}
      {att && att.type === 'path' && <PathAttachmentInspector slotId={slotId} att={att} disabled={animate} />}
      {att && att.type === 'point' && <PointInspector slotId={slotId} att={att} disabled={animate} />}
    </>
  );
}

/** What the skeleton holds, shown while nothing is selected: the counts and the number of things the project check would mention. */
function SkeletonSummary() {
  const project = useProject();
  const stats = projectStats(project);
  const warnings = projectWarnings(project).length;
  return (
    <div className="summary-chips">
      <span className="chip">{`Bones: ${stats.bones}`}</span>
      <span className="chip">{`Slots: ${stats.slots}`}</span>
      <span className="chip">{`Animations: ${stats.animations}`}</span>
      <span className="chip">{`Skins: ${stats.skins}`}</span>
      <span className="chip">{`Pictures: ${stats.images}`}</span>
      {warnings > 0 && <span className="chip warn">{`Warnings: ${warnings}`}</span>}
    </div>
  );
}

export function InspectorPanel() {
  const selection = useUi((s) => s.selection);
  const project = useProject();
  const mode = useUi((s) => s.mode);
  const doc = project.skeleton;
  const anim = currentAnimation();
  const showBone = selection.bones.length > 0 && !(selection.slot && selection.attachment) && !selection.constraint;

  return (
    <div className="panel grow">
      <div className="panel-head">
        <span className="title">Inspector</span>
        {selection.bones.length > 1 && <span className="chip">{selection.bones.length} bones</span>}
      </div>
      <div className="panel-body">
        {selection.constraint && <ConstraintInspector id={selection.constraint} />}
        {showBone && <BoneInspector id={selection.bones[0]} />}
        {selection.slot && <SlotInspector slotId={selection.slot} attachmentName={selection.attachment} />}
        {!showBone && !selection.slot && !selection.constraint && (
          <>
            <Section id="skeleton" title="Skeleton" collapsible={false}>
              <div className="mb">
                <TextField name="Skeleton name" value={doc.name} onCommit={(v) => renameSkeletonAt(activeIndex(project), v)} wide />
              </div>
              <Field label="FPS">
                <NumberField label="fps" value={doc.fps} step={1} precision={0} min={1} max={240} onChange={(v) => setFps(v)} />
              </Field>
            </Section>
            {mode === 'animate' && anim && (
              <Section id="skeleton.animation" title={`Animation · ${anim.name}`}>
                <Field label="Length">
                  <NumberField
                    label="s"
                    value={anim.duration}
                    step={0.05}
                    precision={3}
                    min={0.05}
                    onChange={(v) => setAnimationDuration(anim.id, v)}
                  />
                </Field>
              </Section>
            )}
            <SkeletonSummary />
            <div className="empty">
              Select a bone or an image in the viewport
              <br />
              to edit its properties.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
