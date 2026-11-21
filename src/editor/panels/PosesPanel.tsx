import { useState } from 'react';
import { Bookmark, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { applyPose, deletePose, overwritePose, renamePose, savePose } from '@/store/poseActions';
import { useProject } from '@/store/doc';
import { useUi } from '@/store/ui';
import { Field } from '../ui/Field';
import { IconButton, NumberField } from '../ui/controls';

/**
 * The pose library: poses kept by name (a guard stance, a wave, a hand shape) that go onto the skeleton with one click. In Setup mode they set
 * the setup pose; in Animate mode they key the bones at the playhead (or hold the pose until it is keyed, with auto-key off). Part of the way
 * (the blend) lets a pose be mixed into what the bones do now. The library is saved in the project file and is not part of the export.
 */
export function PosesPanel() {
  const project = useProject();
  const poses = project.poses ?? [];
  const mode = useUi((s) => s.mode);
  const selected = useUi((s) => s.selection.bones.length);
  const [blend, setBlend] = useState(100);
  const [renaming, setRenaming] = useState<string | null>(null);

  return (
    <div className="panel grow" style={{ minHeight: 160 }}>
      <div className="panel-head">
        <span className="title">Poses</span>
        <IconButton
          icon={Plus}
          title={selected ? 'Keep the pose of the selected bones as a new pose' : 'Keep the pose of all bones as a new pose'}
          small
          onClick={() => savePose()}
        />
      </div>
      <div className="panel-body">
        <div className="pad">
          <Field label="Blend" title="How far a pose goes onto the bones: 100% is the whole pose, less mixes it into what the bones do now">
            <NumberField label="%" value={blend} step={5} precision={0} min={0} max={100} onChange={(v) => setBlend(Math.round(v))} />
          </Field>
        </div>
        {poses.length === 0 && (
          <p className="hint-text pad">
            Pose the skeleton, then press + to keep the pose here. Click a pose to put it on the bones. Select some bones first to keep or
            apply only those.
          </p>
        )}
        {poses.map((p) => (
          <div
            key={p.id}
            className="row"
            onClick={() => applyPose(p.id, blend / 100)}
            data-tip={mode === 'animate' ? 'Click: put this pose on the bones at the playhead' : 'Click: put this pose on the bones'}
          >
            <span className="ico">
              <Bookmark size={13} />
            </span>
            {renaming === p.id ? (
              <span className="label" onClick={(e) => e.stopPropagation()}>
                <input
                  autoFocus
                  defaultValue={p.name}
                  aria-label="Pose name"
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => {
                    renamePose(p.id, e.target.value);
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
              <span className="label">{p.name}</span>
            )}
            <span className="dim row-meta">{Object.keys(p.bones).length}</span>
            <span className="actions">
              <IconButton
                icon={RefreshCw}
                title={
                  selected
                    ? 'Replace this pose with the pose of the selected bones now'
                    : 'Replace this pose with the pose of all bones now'
                }
                small
                onClick={(e) => (e.stopPropagation(), overwritePose(p.id))}
              />
              <IconButton icon={Pencil} title="Rename pose" small onClick={(e) => (e.stopPropagation(), setRenaming(p.id))} />
              <IconButton icon={Trash2} title="Delete pose" small onClick={(e) => (e.stopPropagation(), deletePose(p.id))} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
