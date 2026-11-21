/** The inspectors of the attachments that are not a plain picture: clipping, bounding box, path, point, region. */
import { SoftControls } from './SoftControls';
import { BoxSelect, Crosshair, Image as ImageIcon, RotateCcw, Scissors, Spline, Triangle } from 'lucide-react';
import type { Id, PathAttachment, PointAttachment, PolygonAttachment, RGBA, RegionAttachment } from '@/core/model';
import { pathNodeCount, polygonVertexCount } from '@/core/model';
import { resetPolygonShape } from '@/store/polygonActions';
import { setAttachmentProps, setTool } from '@/store/actions';
import { useProject } from '@/store/doc';
import { bindPathToBones, resetPathShape, setPathClosed, unbindPath } from '@/store/pathActions';
import { useUi } from '@/store/ui';
import { Button, ColorSwatch, Hint, NumberField, SelectField, Toggle } from '../ui/controls';
import { Field } from '../ui/Field';
import { Section } from '../ui/Section';

function ColorRow({ label, color, disabled, onChange }: { label: string; color: RGBA; disabled?: boolean; onChange: (c: RGBA) => void }) {
  return (
    <Field label={label}>
      <div className="hstack">
        <ColorSwatch value={color} onChange={(rgb) => onChange([rgb[0], rgb[1], rgb[2], color[3]])} />
        <NumberField
          label="A"
          value={color[3]}
          step={0.01}
          precision={2}
          min={0}
          max={1}
          disabled={disabled}
          onChange={(v) => onChange([color[0], color[1], color[2], v])}
        />
      </div>
    </Field>
  );
}

/** Clipping polygons and bounding boxes: they are data for the runtime (a mask / a hit area), not images. */
export function PolygonInspector({ slotId, att, disabled }: { slotId: Id; att: PolygonAttachment; disabled: boolean }) {
  const project = useProject();
  const tool = useUi((s) => s.tool);
  const doc = project.skeleton;
  const set = (patch: Record<string, unknown>, label: string) => setAttachmentProps(slotId, att.name, patch, label);
  const clip = att.type === 'clipping' ? att : null;
  const slotOptions = [{ value: '', label: '— to the end of the draw order —' }, ...doc.slots.map((s) => ({ value: s.id, label: s.name }))];
  const index = doc.slots.findIndex((s) => s.id === slotId);
  const endIndex = clip?.end ? doc.slots.findIndex((s) => s.id === clip.end) : -1;
  const clipHint = clip
    ? `Clips the slots below this one in the list${clip.end ? (endIndex >= 0 && endIndex <= index ? ' — the end slot is above this slot, so it has no effect' : '') : ' up to the end of the draw order'}.`
    : '';
  return (
    <Section id={clip ? 'slot.clipping' : 'slot.boundingbox'} title={clip ? 'Clipping' : 'Bounding box'} icon={clip ? Scissors : BoxSelect}>
      <div className="hstack wrap mb">
        <span className="chip">{`${polygonVertexCount(att)} vertices`}</span>
        {att.weights && <span className="chip accent">weighted</span>}
      </div>
      {clip && (
        <>
          <Field label="End slot">
            <SelectField
              value={clip.end ?? ''}
              options={slotOptions}
              onChange={(v) => !disabled && set({ end: v || null }, 'Clipping end slot')}
            />
          </Field>
          <Field label="Convex">
            <Toggle
              on={clip.convex}
              onChange={(v) => !disabled && set({ convex: v }, 'Clipping convex')}
              title="Treat the polygon as convex (its convex hull is used when it is not)"
            />
          </Field>
          <Field label="Inverse">
            <Toggle
              on={clip.inverse}
              onChange={(v) => !disabled && set({ inverse: v }, 'Clipping inverse')}
              title="Show everything outside the polygon instead of the inside"
            />
          </Field>
          <Hint>{clipHint}</Hint>
        </>
      )}
      <ColorRow label="Color" color={att.color} disabled={disabled} onChange={(c) => set({ color: c }, 'Attachment color')} />
      {!disabled && (
        <Button primary={tool === 'mesh'} icon={Triangle} onClick={() => setTool('mesh')} title="Edit vertices (M)">
          Edit vertices
        </Button>
      )}
      {!disabled && (
        <Button
          ghost
          small
          icon={RotateCcw}
          onClick={() => resetPolygonShape(slotId, att.name)}
          title="Reset the polygon to a square around the bone (weights and deform keys of the old shape go)"
        >
          Reset shape
        </Button>
      )}
      {!disabled && tool === 'mesh' && <SoftControls />}
      <p className="hint-text mt">Drag vertices · Ctrl-click or double-click an edge adds one · Del removes the selected vertices.</p>
    </Section>
  );
}

/** A Bezier path: bones follow it through a path constraint (Constraints list in the tree). */
export function PathAttachmentInspector({ slotId, att, disabled }: { slotId: Id; att: PathAttachment; disabled: boolean }) {
  const tool = useUi((s) => s.tool);
  const selectedBones = useUi((s) => s.selection.bones);
  const set = (patch: Record<string, unknown>, label: string) => setAttachmentProps(slotId, att.name, patch, label);
  return (
    <Section id="slot.path" title="Path" icon={Spline} kind="path">
      <div className="hstack wrap mb">
        <span className="chip">{`${pathNodeCount(att)} nodes`}</span>
        <span className="chip">{att.closed ? 'closed' : 'open'}</span>
        {att.weights && <span className="chip accent">weighted</span>}
      </div>
      <Field label="Closed">
        <Toggle
          on={att.closed}
          onChange={(v) => !disabled && setPathClosed(slotId, att.name, v)}
          title="Join the last node to the first one"
        />
      </Field>
      <Field label="Constant speed">
        <Toggle
          on={att.constantSpeed}
          onChange={(v) => !disabled && set({ constantSpeed: v }, 'Path constant speed')}
          title="Measure the curves every frame so bones move at a constant speed; otherwise the lengths of the setup pose are used (cheaper)"
        />
      </Field>
      <ColorRow label="Color" color={att.color} disabled={disabled} onChange={(c) => set({ color: c }, 'Attachment color')} />
      <Button primary={tool === 'mesh'} icon={Triangle} onClick={() => setTool('mesh')} title="Edit nodes (M)">
        Edit nodes
      </Button>
      {!disabled && (
        <Button
          ghost
          small
          icon={RotateCcw}
          onClick={() => resetPathShape(slotId, att.name)}
          title="Reset the path to a straight line of two nodes around the bone (weights and deform keys of the old path go)"
        >
          Reset path
        </Button>
      )}
      {!disabled && (
        <div className="hstack mt">
          <Button
            ghost
            disabled={!selectedBones.length}
            onClick={() => bindPathToBones(slotId, att.name, selectedBones)}
            title="Let the selected bones move the path (automatic weights)"
          >
            Bind to the selected bones
          </Button>
          {att.weights && (
            <Button ghost onClick={() => unbindPath(slotId, att.name)} title="Back to a plain path: the points stay where they are">
              Unbind
            </Button>
          )}
        </div>
      )}
      <p className="hint-text mt">
        Drag nodes and handles · Alt-drag a handle mirrors the other one · Ctrl-click or double-click the curve adds a node · Del removes
        the selected nodes · in Animate mode dragging keys a deform.
      </p>
    </Section>
  );
}

export function PointInspector({ slotId, att, disabled }: { slotId: Id; att: PointAttachment; disabled: boolean }) {
  const set = (patch: Partial<PointAttachment>) => setAttachmentProps(slotId, att.name, patch);
  return (
    <Section id="slot.point" title="Point" icon={Crosshair}>
      <Field label="Position">
        <NumberField label="X" value={att.x} disabled={disabled} onChange={(v) => set({ x: v })} />
        <NumberField label="Y" value={att.y} disabled={disabled} onChange={(v) => set({ y: v })} />
      </Field>
      <Field label="Rotation">
        <NumberField label="°" value={att.rotation} disabled={disabled} onChange={(v) => set({ rotation: v })} />
      </Field>
      <ColorRow label="Color" color={att.color} disabled={disabled} onChange={(c) => set({ color: c })} />
    </Section>
  );
}

export function RegionInspector({ slotId, att, disabled }: { slotId: Id; att: RegionAttachment; disabled: boolean }) {
  const set = (patch: Partial<RegionAttachment>) => setAttachmentProps(slotId, att.name, patch);
  return (
    <Section id="slot.region" title={`Region · ${att.path}`} icon={ImageIcon}>
      <Field label="Position">
        <NumberField label="X" value={att.x} disabled={disabled} onChange={(v) => set({ x: v })} />
        <NumberField label="Y" value={att.y} disabled={disabled} onChange={(v) => set({ y: v })} />
      </Field>
      <Field label="Rotation">
        <NumberField label="°" value={att.rotation} disabled={disabled} onChange={(v) => set({ rotation: v })} />
      </Field>
      <Field label="Scale">
        <NumberField label="X" value={att.scaleX} step={0.01} precision={3} disabled={disabled} onChange={(v) => set({ scaleX: v })} />
        <NumberField label="Y" value={att.scaleY} step={0.01} precision={3} disabled={disabled} onChange={(v) => set({ scaleY: v })} />
      </Field>
      <Field label="Size">
        <NumberField label="W" value={att.width} disabled={disabled} onChange={(v) => set({ width: Math.max(1, v) })} />
        <NumberField label="H" value={att.height} disabled={disabled} onChange={(v) => set({ height: Math.max(1, v) })} />
      </Field>
      <Field label="Color">
        <div className="hstack">
          <ColorSwatch value={att.color} onChange={(rgb) => set({ color: [rgb[0], rgb[1], rgb[2], att.color[3]] })} />
          <NumberField
            label="A"
            value={att.color[3]}
            step={0.01}
            min={0}
            max={1}
            onChange={(v) => set({ color: [att.color[0], att.color[1], att.color[2], v] })}
          />
        </div>
      </Field>
    </Section>
  );
}
