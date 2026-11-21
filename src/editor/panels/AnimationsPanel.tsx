import { useMemo, useState } from 'react';
import { Eraser, ChevronDown, ChevronRight, Copy, Film, Folder, Pencil, Plus, Trash2 } from 'lucide-react';
import { countKeys } from '@/core/stats';
import type { Animation } from '@/core/model';
import {
  cleanUpKeys,
  createAnimation,
  deleteAnimation,
  duplicateAnimation,
  renameAnimation,
  selectAnimation,
  setMode,
} from '@/store/actions';
import { useProject } from '@/store/doc';
import { useUi } from '@/store/ui';
import { IconButton } from '../ui/controls';

/** Spine groups animations in folders; the folder is the part of the name before the last "/" ("emotes/wave"). */
function folderOf(name: string): string {
  const i = name.lastIndexOf('/');
  return i < 0 ? '' : name.slice(0, i);
}

/** The Animations window: every animation with its length and number of keys, folders by name, new / rename / duplicate / delete. */
export function AnimationsPanel() {
  const project = useProject();
  const animationId = useUi((s) => s.animationId);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const animations = project.skeleton.animations;

  const groups = useMemo(() => {
    const map = new Map<string, Animation[]>();
    for (const a of animations) {
      const f = folderOf(a.name);
      map.set(f, [...(map.get(f) ?? []), a]);
    }
    return [...map.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  }, [animations]);

  const row = (a: Animation, indent: boolean) => {
    const label = indent ? a.name.slice(a.name.lastIndexOf('/') + 1) : a.name;
    return (
      <div
        key={a.id}
        className={`row${a.id === animationId ? ' selected' : ''}`}
        style={{ paddingLeft: indent ? 22 : 8 }}
        onClick={() => selectAnimation(a.id)}
        onDoubleClick={() => setRenaming(a.id)}
      >
        <span className="ico">
          <Film size={13} />
        </span>
        {renaming === a.id ? (
          <span className="label">
            <input
              autoFocus
              defaultValue={a.name}
              aria-label="Animation name"
              onFocus={(e) => e.target.select()}
              onBlur={(e) => {
                renameAnimation(a.id, e.target.value);
                setRenaming(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                else if (e.key === 'Escape') setRenaming(null);
                e.stopPropagation();
              }}
            />
          </span>
        ) : (
          <span className="label">{label}</span>
        )}
        <span className="dim row-meta">
          {a.duration.toFixed(2)}s · {countKeys(a)}
        </span>
        <span className="actions">
          <IconButton icon={Pencil} title="Rename animation" small onClick={(e) => (e.stopPropagation(), setRenaming(a.id))} />
          <IconButton
            icon={Eraser}
            title="Clean up: remove the keys that change nothing"
            small
            onClick={(e) => (e.stopPropagation(), cleanUpKeys(a.id))}
          />
          <IconButton icon={Copy} title="Duplicate animation" small onClick={(e) => (e.stopPropagation(), duplicateAnimation(a.id))} />
          <IconButton icon={Trash2} title="Delete animation" small onClick={(e) => (e.stopPropagation(), deleteAnimation(a.id))} />
        </span>
      </div>
    );
  };

  const group = (folder: string, list: Animation[]) => {
    if (folder === '') return list.map((a) => row(a, false));
    return (
      <div key={folder}>
        <div className="row folder" onClick={() => setClosed({ ...closed, [folder]: !closed[folder] })}>
          <span className="chev">{closed[folder] ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</span>
          <span className="ico">
            <Folder size={13} />
          </span>
          <span className="label">{folder}</span>
          <span className="dim row-meta">{list.length}</span>
        </div>
        {!closed[folder] && list.map((a) => row(a, true))}
      </div>
    );
  };

  return (
    <div className="panel grow" style={{ minHeight: 110 }}>
      <div className="panel-head">
        <span className="title">Animations</span>
        <IconButton icon={Plus} title="New animation" small onClick={() => (createAnimation(), setMode('animate'))} />
      </div>
      <div className="panel-body">
        {animations.length === 0 && <div className="empty">No animations yet. Press + to make the first one.</div>}
        {groups.map(([folder, list]) => group(folder, list))}
      </div>
    </div>
  );
}
