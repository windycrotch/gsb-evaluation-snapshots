import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Bone as BoneIcon,
  BoxSelect,
  ChevronDown,
  ChevronRight,
  Crosshair,
  Diamond,
  Eye,
  EyeOff,
  Folder,
  Image as ImageIcon,
  Layers,
  Link2,
  Lock,
  Plus,
  Replace,
  Scissors,
  Shirt,
  Search,
  Spline,
  Trash2,
  Unlock,
  Waves,
  X,
  Zap,
} from 'lucide-react';
import type { Bone, Id, Slot } from '@/core/model';
import {
  createEvent,
  createSkin,
  deleteBones,
  deleteEvent,
  deleteSkin,
  deleteSlots,
  keyEvent,
  moveSlot,
  renameBone,
  renameSkin,
  renameSlot,
  reparentBone,
  selectBone,
  selectMatches,
  selectSlot,
  setActiveSkin,
  toggleExtraSlot,
  setBoneProps,
  setSelection,
  setSlotBone,
  setSlotProps,
  updateEvent,
} from '@/store/actions';
import { folderOfSlot } from '@/core/folders';
import { filterTree } from '@/core/treeFilter';
import { useProject } from '@/store/doc';
import { createPathConstraint } from '@/store/pathConstraintActions';
import { createPhysicsConstraint } from '@/store/physicsActions';
import { createSlider } from '@/store/sliderActions';
import { applyParent } from '@/store/parentActions';
import { uiStore, useUi } from '@/store/ui';
import { showAll } from '@/store/visibilityActions';
import { getScene } from '@/store/scene';
import { IconButton, NumberField, TextField } from '../ui/controls';
import { Field } from '../ui/Field';
import { RenameBar } from './RenameBar';
import { SelectionSets } from './SelectionSets';
import { SkeletonBar } from './SkeletonBar';

/** How far a row of the given depth is moved in: 14 px a level for the first five, then 6 px, so a deep chain still leaves room for a name in a narrow panel. */
function indent(depth: number): number {
  return 8 + Math.min(depth, 5) * 14 + Math.max(depth - 5, 0) * 6;
}

function InlineName({ value, editing, onDone }: { value: string; editing: boolean; onDone: (v: string | null) => void }) {
  if (!editing)
    return (
      <span className="label" title={value}>
        {value}
      </span>
    );
  return (
    <span className="label">
      <input
        autoFocus
        defaultValue={value}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => onDone(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onDone((e.target as HTMLInputElement).value);
          if (e.key === 'Escape') onDone(null);
          e.stopPropagation();
        }}
        onClick={(e) => e.stopPropagation()}
      />
    </span>
  );
}

export function TreePanel() {
  const project = useProject();
  const doc = project.skeleton;
  const selection = useUi((s) => s.selection);
  const skinId = useUi((s) => s.skinId);
  const mode = useUi((s) => s.mode);
  useUi((s) => (s.mode === 'animate' ? s.time : 0));
  const orderedSlots: Slot[] =
    mode === 'animate'
      ? getScene()
          .skeleton.drawOrder.map((s) => doc.slots.find((x) => x.id === s.data.id))
          .filter((s): s is Slot => !!s)
      : doc.slots;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  const match = useMemo(() => filterTree(doc, query), [doc, query]);

  // the draw order list: slots of one draw order folder that sit next to each other are grouped under the folder's name (a group can be folded)
  type OrderItem = { head: { key: string; name: string; count: number } } | { s: Slot; i: number; indent: boolean };
  const orderItems: OrderItem[] = [];
  {
    const list = orderedSlots
      .map((s, i) => ({ s, i }))
      .reverse()
      .filter(({ s }) => !match.active || match.slots.has(s.id));
    let run: string | null = null;
    let folded = false;
    for (let k = 0; k < list.length; k++) {
      const f = folderOfSlot(doc, list[k].s.id);
      if (f && f.id !== run) {
        let count = 0;
        while (k + count < list.length && folderOfSlot(doc, list[k + count].s.id)?.id === f.id) count++;
        const key = 'f:' + list[k].s.id;
        orderItems.push({ head: { key, name: f.name, count } });
        folded = !!collapsed[key];
      }
      run = f ? f.id : null;
      if (!f) folded = false;
      if (!folded) orderItems.push({ s: list[k].s, i: list[k].i, indent: !!f });
    }
  }

  const childrenOf = useMemo(() => {
    const m = new Map<Id | null, Bone[]>();
    for (const b of doc.bones) {
      const k = b.parent;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(b);
    }
    return m;
  }, [doc.bones]);
  const slotsOf = useMemo(() => {
    const m = new Map<Id, Slot[]>();
    for (const s of doc.slots) {
      if (!m.has(s.bone)) m.set(s.bone, []);
      m.get(s.bone)!.push(s);
    }
    return m;
  }, [doc.slots]);

  const toggle = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  const renderSlot = (slot: Slot, depth: number) => {
    const selected = selection.slot === slot.id || (selection.extraSlots ?? []).includes(slot.id);
    const atts = doc.skins[0]?.attachments[slot.id] ?? {};
    const attNames = Object.keys(atts);
    const open = !collapsed['s:' + slot.id] && (selected || (match.active && match.slots.has(slot.id)));
    return (
      <div key={slot.id}>
        <div
          className={`row${selected && !selection.attachment ? ' selected' : ''}`}
          style={{ paddingLeft: indent(depth) }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-bone2d-slot', slot.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onClick={(e) =>
            (e.ctrlKey || e.metaKey || e.shiftKey) && selection.slot ? toggleExtraSlot(slot.id) : selectSlot(slot.id, slot.attachment)
          }
          onDoubleClick={() => setEditing('s:' + slot.id)}
        >
          <span className={`chev${attNames.length ? '' : ' hidden'}`} onClick={(e) => (e.stopPropagation(), toggle('s:' + slot.id))}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
          <span className="ico">
            <Layers size={13} />
          </span>
          <InlineName
            value={slot.name}
            editing={editing === 's:' + slot.id}
            onDone={(v) => {
              setEditing(null);
              if (v !== null && v !== slot.name) renameSlot(slot.id, v);
            }}
          />
          <span className="actions">
            <IconButton
              icon={slot.hidden ? EyeOff : Eye}
              title={slot.hidden ? 'Show' : 'Hide'}
              small
              onClick={(e) => (e.stopPropagation(), setSlotProps(slot.id, { hidden: !slot.hidden }, 'Toggle slot'))}
            />
            <IconButton icon={Trash2} title="Delete slot" small onClick={(e) => (e.stopPropagation(), deleteSlots([slot.id]))} />
          </span>
        </div>
        {open &&
          attNames.map((name) => (
            <div
              key={name}
              className={`row${selected && selection.attachment === name ? ' selected' : ''}`}
              style={{ paddingLeft: indent(depth + 1) + 16 }}
              onClick={() => selectSlot(slot.id, name)}
            >
              <span className="ico">
                {atts[name].type === 'clipping' ? (
                  <Scissors size={12} />
                ) : atts[name].type === 'boundingbox' ? (
                  <BoxSelect size={12} />
                ) : atts[name].type === 'point' ? (
                  <Crosshair size={12} />
                ) : atts[name].type === 'path' ? (
                  <Spline size={12} />
                ) : (
                  <ImageIcon size={12} />
                )}
              </span>
              <span className="label" title={name}>
                {name}
              </span>
              {slot.attachment === name && <span className="chip">setup</span>}
              <span className="actions">
                <IconButton
                  icon={Eye}
                  title="Show this attachment in setup pose"
                  small
                  onClick={(e) => (e.stopPropagation(), setSlotProps(slot.id, { attachment: name }, 'Set attachment'))}
                />
              </span>
            </div>
          ))}
      </div>
    );
  };

  const renderBone = (bone: Bone, depth: number): ReactElement | null => {
    if (match.active && !match.bones.has(bone.id)) return null;
    const kids = (childrenOf.get(bone.id) ?? []).filter((k) => !match.active || match.bones.has(k.id));
    const slots = (slotsOf.get(bone.id) ?? []).filter((s) => !match.active || match.slots.has(s.id));
    const hasKids = kids.length + slots.length > 0;
    const open = match.active || !collapsed['b:' + bone.id];
    const selected = selection.bones.includes(bone.id) && !selection.slot;
    return (
      <div key={bone.id}>
        <div
          className={`row${selected ? ' selected' : ''}${dropOn === bone.id ? ' drop' : ''}`}
          style={{ paddingLeft: indent(depth) }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-bone2d-bone', bone.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('application/x-bone2d-bone') || e.dataTransfer.types.includes('application/x-bone2d-slot')) {
              e.preventDefault();
              setDropOn(bone.id);
            }
          }}
          onDragLeave={() => setDropOn((d) => (d === bone.id ? null : d))}
          onDrop={(e) => {
            e.preventDefault();
            setDropOn(null);
            const bid = e.dataTransfer.getData('application/x-bone2d-bone');
            const sid = e.dataTransfer.getData('application/x-bone2d-slot');
            if (bid && bid !== bone.id) reparentBone(bid, bone.id);
            if (sid) setSlotBone(sid, bone.id);
          }}
          onClick={(e) => (uiStore.get().pickParent ? applyParent(bone.id) : selectBone(bone.id, e.shiftKey || e.ctrlKey || e.metaKey))}
          onDoubleClick={() => setEditing('b:' + bone.id)}
        >
          <span className={`chev${hasKids ? '' : ' hidden'}`} onClick={(e) => (e.stopPropagation(), toggle('b:' + bone.id))}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
          <span className="ico">
            <BoneIcon size={13} />
          </span>
          <InlineName
            value={bone.name}
            editing={editing === 'b:' + bone.id}
            onDone={(v) => {
              setEditing(null);
              if (v !== null && v !== bone.name) renameBone(bone.id, v);
            }}
          />
          <span className={`actions${bone.hidden || bone.locked ? ' pinned' : ''}`}>
            <IconButton
              icon={bone.locked ? Lock : Unlock}
              title={bone.locked ? 'Unlock' : 'Lock (not selectable in viewport)'}
              small
              onClick={(e) => (e.stopPropagation(), setBoneProps(bone.id, { locked: !bone.locked }, 'Lock bone'))}
            />
            <IconButton
              icon={bone.hidden ? EyeOff : Eye}
              title={bone.hidden ? 'Show' : 'Hide'}
              small
              onClick={(e) => (e.stopPropagation(), setBoneProps(bone.id, { hidden: !bone.hidden }, 'Hide bone'))}
            />
          </span>
        </div>
        {open && (
          <>
            {kids.map((k) => renderBone(k, depth + 1))}
            {slots.map((s) => renderSlot(s, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const roots = childrenOf.get(null) ?? [];

  return (
    <div className="panel grow" style={{ minHeight: 120 }} data-learn="tree">
      <div className="panel-head">
        <span className="title">Hierarchy</span>
        <IconButton icon={Eye} title="Show everything hidden" small onClick={() => showAll()} />
        <IconButton
          icon={Trash2}
          title="Delete selected"
          small
          disabled={!selection.bones.length && !selection.slot}
          onClick={() => (selection.slot && !selection.bones.length ? deleteSlots([selection.slot]) : deleteBones(selection.bones))}
        />
      </div>
      <SkeletonBar />
      <div className="tree-filter">
        <Search size={13} />
        <input
          value={query}
          placeholder="Filter by name (words, * ?, /regex/)"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
            e.stopPropagation();
          }}
        />
        {match.active && match.matchedBones.length + match.matchedSlots.length > 0 && (
          <button
            className="btn sm"
            title="Select every bone and slot that matches (several slots are selected together, so the weight tools work on all their meshes)"
            onClick={() => selectMatches(match)}
          >
            {`Select ${match.matchedBones.length + match.matchedSlots.length}`}
          </button>
        )}
        {query && <IconButton icon={X} title="Clear the filter" small onClick={() => setQuery('')} />}
        <IconButton icon={Replace} title="Find and replace in names" small active={replacing} onClick={() => setReplacing((v) => !v)} />
      </div>
      {replacing && <RenameBar />}
      <SelectionSets />
      <div
        className="panel-body"
        onClick={(e) => e.target === e.currentTarget && setSelection({})}
        onDragOver={(e) => e.dataTransfer.types.includes('application/x-bone2d-bone') && e.preventDefault()}
      >
        {roots.map((r) => renderBone(r, 0))}

        {match.active && !match.bones.size && !match.constraints.size && !match.skins.size && !match.events.size && (
          <div className="empty">Nothing matches</div>
        )}

        {doc.slots.length > 1 && (!match.active || match.slots.size > 0) && (
          <>
            <div className="section-label">Draw order{mode === 'animate' ? ' · keyed at playhead' : ''}</div>
            {orderItems.map((it) => {
              if ('head' in it) {
                const open = !collapsed[it.head.key];
                return (
                  <div key={it.head.key} className="row folder" style={{ paddingLeft: 14 }} onClick={() => toggle(it.head.key)}>
                    <span className="chev">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
                    <span className="ico">
                      <Folder size={13} />
                    </span>
                    <span className="label" title={it.head.name}>
                      {it.head.name}
                    </span>
                    <span className="chip" title="Slots of this draw order folder next to each other">
                      {it.head.count}
                    </span>
                  </div>
                );
              }
              const { s, i, indent } = it;
              return (
                <div
                  key={s.id}
                  className={`row${selection.slot === s.id || (selection.extraSlots ?? []).includes(s.id) ? ' selected' : ''}${dropOn === 'o:' + s.id ? ' drop' : ''}`}
                  style={{ paddingLeft: indent ? 30 : 14 }}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-bone2d-order', s.id);
                  }}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes('application/x-bone2d-order')) {
                      e.preventDefault();
                      setDropOn('o:' + s.id);
                    }
                  }}
                  onDragLeave={() => setDropOn(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDropOn(null);
                    const id = e.dataTransfer.getData('application/x-bone2d-order');
                    if (id && id !== s.id) moveSlot(id, i);
                  }}
                  onClick={(e) =>
                    (e.ctrlKey || e.metaKey || e.shiftKey) && selection.slot ? toggleExtraSlot(s.id) : selectSlot(s.id, s.attachment)
                  }
                >
                  <span className="ico">
                    <Layers size={13} />
                  </span>
                  <span className="label" title={s.name}>
                    {s.name}
                  </span>
                </div>
              );
            })}
          </>
        )}

        {(doc.constraints.length > 0 || doc.bones.length > 0) && (!match.active || match.constraints.size > 0) && (
          <>
            <div className="section-label bar">
              <span className="grow">Constraints</span>
              <IconButton
                icon={Spline}
                title="New path constraint (the selected bones follow a path)"
                small
                onClick={() => createPathConstraint()}
              />
              <IconButton
                icon={Waves}
                title="New physics constraint (the selected bone swings while an animation plays)"
                small
                onClick={() => createPhysicsConstraint()}
              />
              <IconButton
                icon={Plus}
                title="New slider (applies an animation by hand or driven by a bone)"
                small
                onClick={() => createSlider(selection.bones[0] ?? null)}
              />
            </div>
            {doc.constraints
              .filter((c) => !match.active || match.constraints.has(c.id))
              .map((c) => (
                <div
                  key={c.id}
                  className={`row${selection.constraint === c.id ? ' selected' : ''}`}
                  style={{ paddingLeft: 14 }}
                  onClick={() => setSelection({ constraint: c.id })}
                >
                  <span className="ico">
                    {c.type === 'path' ? <Spline size={13} /> : c.type === 'physics' ? <Waves size={13} /> : <Link2 size={13} />}
                  </span>
                  <span className="label" title={c.name}>
                    {c.name}
                  </span>
                  <span className={`chip k-${c.type}`}>
                    {c.type === 'ik' ? 'IK' : c.type === 'transform' ? 'TC' : c.type === 'path' ? 'PC' : c.type === 'physics' ? 'PH' : 'SL'}
                  </span>
                </div>
              ))}
          </>
        )}

        {doc.slots.length > 0 && (!match.active || match.skins.size > 0) && (
          <>
            <div className="section-label bar">
              <span className="grow">Skins</span>
              <IconButton icon={Plus} title="New skin" small onClick={() => createSkin()} />
            </div>
            {doc.skins.map((s, i) => {
              if (match.active && !match.skins.has(s.id)) return null;
              const active = (skinId ?? doc.skins[0].id) === s.id;
              return (
                <div
                  key={s.id}
                  className={`row${active ? ' selected' : ''}`}
                  style={{ paddingLeft: 14 }}
                  onClick={() => setActiveSkin(i === 0 ? null : s.id)}
                  onDoubleClick={() => i > 0 && setEditing('k:' + s.id)}
                >
                  <span className="ico">
                    <Shirt size={13} />
                  </span>
                  <InlineName
                    value={s.name}
                    editing={editing === 'k:' + s.id}
                    onDone={(v) => {
                      setEditing(null);
                      if (v !== null && v !== s.name) renameSkin(s.id, v);
                    }}
                  />
                  {i > 0 && (
                    <span className="actions">
                      <IconButton icon={Trash2} title="Delete skin" small onClick={(e) => (e.stopPropagation(), deleteSkin(s.id))} />
                    </span>
                  )}
                </div>
              );
            })}
          </>
        )}

        {(doc.events.length > 0 || doc.slots.length > 0) && (!match.active || match.events.size > 0) && (
          <>
            <div className="section-label bar">
              <span className="grow">Events</span>
              <IconButton icon={Plus} title="New event" small onClick={() => createEvent()} />
            </div>
            {doc.events
              .filter((ev) => !match.active || match.events.has(ev.id))
              .map((ev) => (
                <div key={ev.id}>
                  <div
                    className={`row${openEvent === ev.id ? ' selected' : ''}`}
                    style={{ paddingLeft: 14 }}
                    onClick={() => setOpenEvent((o) => (o === ev.id ? null : ev.id))}
                    onDoubleClick={() => setEditing('e:' + ev.id)}
                  >
                    <span className="ico">
                      <Zap size={13} />
                    </span>
                    <InlineName
                      value={ev.name}
                      editing={editing === 'e:' + ev.id}
                      onDone={(v) => {
                        setEditing(null);
                        if (v !== null && v !== ev.name) updateEvent(ev.id, { name: v });
                      }}
                    />
                    <span className="actions pinned">
                      <IconButton
                        icon={Diamond}
                        title="Fire this event at the playhead"
                        small
                        onClick={(e) => (e.stopPropagation(), keyEvent(ev.id))}
                      />
                      <IconButton icon={Trash2} title="Delete event" small onClick={(e) => (e.stopPropagation(), deleteEvent(ev.id))} />
                    </span>
                  </div>
                  {openEvent === ev.id && (
                    <div className="event-edit">
                      <Field label="Int" title="The whole number the event carries by default">
                        <NumberField label="#" value={ev.int} step={1} precision={0} onChange={(v) => updateEvent(ev.id, { int: v })} />
                      </Field>
                      <Field label="Float" title="The decimal number the event carries by default">
                        <NumberField
                          label="f"
                          value={ev.float}
                          step={0.1}
                          precision={3}
                          onChange={(v) => updateEvent(ev.id, { float: v })}
                        />
                      </Field>
                      <Field label="Text" title="The text the event carries by default">
                        <TextField name="Event string" value={ev.string} onCommit={(v) => updateEvent(ev.id, { string: v })} wide />
                      </Field>
                      <Field
                        label="Sound"
                        title="The path of the sound file for the engine (kept in the export; the editor does not play it)"
                      >
                        <TextField name="Event sound" value={ev.audio ?? ''} onCommit={(v) => updateEvent(ev.id, { audio: v })} wide />
                      </Field>
                      {ev.audio && (
                        <>
                          <Field label="Volume" title="0 is silent, 1 is full">
                            <NumberField
                              label="v"
                              value={ev.volume ?? 1}
                              step={0.05}
                              precision={2}
                              min={0}
                              max={1}
                              onChange={(v) => updateEvent(ev.id, { volume: v })}
                            />
                          </Field>
                          <Field label="Balance" title="-1 is the left speaker, 1 the right">
                            <NumberField
                              label="b"
                              value={ev.balance ?? 0}
                              step={0.05}
                              precision={2}
                              min={-1}
                              max={1}
                              onChange={(v) => updateEvent(ev.id, { balance: v })}
                            />
                          </Field>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
          </>
        )}

        {doc.bones.length <= 1 && doc.slots.length === 0 && (
          <div className="empty">
            Pick the <b>Create bone</b> tool <span className="kbd">B</span> and drag in the viewport.
            <br />
            Drop images into the viewport to add parts.
          </div>
        )}
      </div>
    </div>
  );
}
