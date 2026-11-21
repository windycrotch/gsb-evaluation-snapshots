import { Copy, Plus, Trash2 } from 'lucide-react';
import { activeIndex, skeletonList } from '@/core/skeletons';
import { useProject } from '@/store/doc';
import { copySkeleton, createSkeleton, deleteSkeletonAt, switchToSkeleton } from '@/store/skeletonActions';
import { IconButton, SelectField } from '../ui/controls';

/** The skeletons of the project: pick the one to edit, add an empty one, copy the edited one or delete it. The pictures are shared by all of them. */
export function SkeletonBar() {
  const project = useProject();
  const list = skeletonList(project);
  const at = activeIndex(project);
  return (
    <div className="skel-bar">
      <SelectField
        wide
        name="Skeleton"
        value={String(at)}
        options={list.map((d, i) => ({ value: String(i), label: d.name }))}
        onChange={(v) => switchToSkeleton(Number(v))}
      />
      <IconButton icon={Plus} small title="New skeleton (the pictures are shared with the others)" onClick={() => createSkeleton()} />
      <IconButton icon={Copy} small title="Duplicate this skeleton" onClick={() => copySkeleton()} />
      <IconButton icon={Trash2} small title="Delete this skeleton" disabled={list.length < 2} onClick={() => deleteSkeletonAt(at)} />
    </div>
  );
}
