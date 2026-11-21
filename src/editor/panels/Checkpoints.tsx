import { useMemo, useState } from 'react';
import { ArrowDownToLine, Check, ClipboardCopy, Eye, EyeOff, FileDiff, Flag, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { changesToText, diffSkeletons, nextCheckpointName, summarizeChanges } from '@/core/checkpoints';
import type { Change, Checkpoint } from '@/core/checkpoints';
import { askName } from '@/store/ask';
import {
  checkpointsOfActive,
  deleteCheckpoint,
  markCheckpoint,
  pickProjectToCompare,
  renameCheckpoint,
  restoreCheckpoint,
  restoreFileCheckpoint,
  takeFromCheckpoint,
  toggleCompare,
  useCheckpointList,
} from '@/store/checkpoints';
import { useProject } from '@/store/doc';
import { toast, useUi } from '@/store/ui';
import { IconButton } from '../ui/controls';

const AREA: Record<Change['area'], string> = {
  bone: 'Bone',
  slot: 'Slot',
  skin: 'Skin',
  constraint: 'Constraint',
  event: 'Event',
  animation: 'Animation',
  skeleton: 'Skeleton',
};
const SIGN: Record<Change['kind'], string> = { added: '+', removed: '−', changed: '~' };

/** What can be taken from the checkpoint: a thing that is gone here or differs, and the skeleton's own settings. A thing only the open skeleton has is not. */
const takeable = (c: Change) => c.kind !== 'added' && (c.area === 'skeleton' || !!c.id);
const keyOf = (c: Change) => `${c.area}:${c.id ?? ''}`;

/** What a compared checkpoint differs in: the things added, removed and changed since it was marked. */
function Changes({ cp }: { cp: Checkpoint }) {
  const doc = useProject().skeleton;
  const changes = useMemo(() => diffSkeletons(cp.skeleton, doc), [cp.skeleton, doc]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const can = changes.filter(takeable);
  const chosen = can.filter((c) => picked.has(keyOf(c)));
  const toggle = (c: Change) =>
    setPicked((p) => {
      const n = new Set(p);
      if (!n.delete(keyOf(c))) n.add(keyOf(c));
      return n;
    });
  const take = async () => {
    const res = await takeFromCheckpoint(
      cp.id,
      chosen.map((c) => ({ area: c.area, id: c.id })),
    );
    if (res?.taken) setPicked(new Set());
  };
  if (!changes.length)
    return (
      <div className="row">
        <span className="label dim">Nothing has changed since this checkpoint</span>
      </div>
    );
  const sum = summarizeChanges(changes);
  return (
    <>
      <div className="row">
        <span
          className="label dim"
          title="Compared with the pose drawn in violet under the current one"
        >{`+${sum.added}  −${sum.removed}  ~${sum.changed}`}</span>
        <span className="actions pinned">
          {can.length > 0 && (
            <>
              <IconButton
                icon={Check}
                title="Pick every difference that can be taken (what is gone here or differs)"
                small
                onClick={() => setPicked(chosen.length === can.length ? new Set() : new Set(can.map(keyOf)))}
              />
              <IconButton
                icon={ArrowDownToLine}
                title="Take the picked differences from this checkpoint into the skeleton (Undo brings the work back)"
                small
                disabled={!chosen.length}
                onClick={() => void take()}
              />
            </>
          )}
          <IconButton
            icon={ClipboardCopy}
            title="Copy the list of changes as text (to paste into a message)"
            small
            onClick={() => {
              void navigator.clipboard?.writeText(changesToText(changes)).then(
                () => toast('Changes copied', 'ok'),
                () => toast('Could not copy', 'error'),
              );
            }}
          />
        </span>
      </div>
      {changes.slice(0, 60).map((c, i) => (
        <div key={i} className="row change-row" title={c.keys ? `+${c.keys.added} −${c.keys.removed} ~${c.keys.changed}` : undefined}>
          {takeable(c) ? (
            <input
              type="checkbox"
              checked={picked.has(keyOf(c))}
              onChange={() => toggle(c)}
              title="Pick this difference to take it from the checkpoint"
            />
          ) : (
            <span className="ico" />
          )}
          <span className={`change-sign ${c.kind}`}>{SIGN[c.kind]}</span>
          <span className="label">
            <span className="dim">{AREA[c.area]}</span> {c.name}
            {c.fields?.map((f, j) => (
              <span key={f} className="dim">
                {j === 0 ? ' · ' : ', '}
                {f}
              </span>
            ))}
            {c.keys && <span className="dim">{` · ${c.keys.added + c.keys.removed + c.keys.changed} keys`}</span>}
          </span>
        </div>
      ))}
      {changes.length > 60 && (
        <div className="row">
          <span className="label dim">{`… ${changes.length - 60} more`}</span>
        </div>
      )}
    </>
  );
}

/** Checkpoints of the skeleton: a named copy to compare the pose with, or to go back to. Kept for the session. */
export function Checkpoints() {
  const all = useCheckpointList();
  const compare = useUi((s) => s.compare);
  useProject();
  const list = checkpointsOfActive(all);
  const mark = async () => {
    const name = await askName('Checkpoint', 'Name for this moment of the skeleton', nextCheckpointName(list), 'Mark');
    if (name) {
      markCheckpoint(name);
      toast('Checkpoint marked', 'ok');
    }
  };
  return (
    <>
      <div className="section-label">Checkpoints</div>
      <div className="row">
        <span className="ico">
          <Flag size={12} />
        </span>
        <span
          className="label dim"
          title="Mark the skeleton as it is now. Later: show its pose under the current one, see what changed, or go back to it"
        >
          Kept until the project is closed
        </span>
        <span className="actions pinned">
          <IconButton
            icon={FileDiff}
            title="Compare with a project file: another version of the project (a teammate's copy, an older save)"
            small
            onClick={() => pickProjectToCompare()}
          />
          <IconButton icon={Flag} title="Mark a checkpoint" small onClick={() => void mark()} />
        </span>
      </div>
      {list.map((c) => (
        <div key={c.id}>
          <div className={`row${compare === c.id ? ' selected' : ''}`} title={new Date(c.time).toLocaleString()}>
            <span className="ico">
              <Flag size={12} />
            </span>
            <span className="label">{c.name}</span>
            <span className="row-meta">{new Date(c.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <span className="actions">
              <IconButton
                icon={compare === c.id ? EyeOff : Eye}
                title={compare === c.id ? 'Stop comparing' : 'Compare: show this pose under the current one and list the changes'}
                small
                active={compare === c.id}
                onClick={() => toggleCompare(c.id)}
              />
              <IconButton
                icon={RotateCcw}
                title={
                  c.fromFile
                    ? 'Go back to this project file: the skeleton becomes the one in the file (Undo brings the work back)'
                    : 'Go back to this checkpoint (Undo brings the work back)'
                }
                small
                onClick={() => void (c.fromFile ? restoreFileCheckpoint(c.id) : restoreCheckpoint(c.id))}
              />
              <IconButton
                icon={Pencil}
                title="Rename this checkpoint"
                small
                onClick={async () => {
                  const name = await askName('Rename checkpoint', 'Name of the checkpoint', c.name, 'Rename');
                  if (name) renameCheckpoint(c.id, name);
                }}
              />
              <IconButton icon={Trash2} title="Delete this checkpoint" small onClick={() => deleteCheckpoint(c.id)} />
            </span>
          </div>
          {compare === c.id && <Changes cp={c} />}
        </div>
      ))}
    </>
  );
}
