import { ChevronRight } from 'lucide-react';
import { useMemo } from 'react';
import { breadcrumbs } from '@/core/breadcrumbs';
import { clearSelection, selectBone, selectSlot } from '@/store/actions';
import { useProject } from '@/store/doc';
import { useSettings } from '@/store/settings';
import { useUi } from '@/store/ui';

/** The trail of the selection over the viewport: skeleton › parent bones › bone › slot › attachment. A click on a bone or a slot selects it. */
export function Breadcrumbs() {
  const doc = useProject().skeleton;
  const selection = useUi((s) => s.selection);
  const parents = useSettings((s) => s.breadcrumbParents);
  const crumbs = useMemo(() => breadcrumbs(doc, selection, parents), [doc, selection, parents]);
  if (crumbs.length < 2) return null;
  const go = (i: number) => {
    const c = crumbs[i];
    if (c.kind === 'skeleton') clearSelection();
    else if (c.kind === 'bone' && c.id) selectBone(c.id);
    else if (c.kind === 'slot' && c.id) selectSlot(c.id, null);
  };
  const last = crumbs.length - 1;
  return (
    <nav className="vp-crumbs" aria-label="Selection">
      {crumbs.map((c, i) => {
        const clickable = i !== last && (c.kind === 'skeleton' || c.id !== undefined);
        return (
          <span key={i} className="crumb-wrap">
            {i > 0 && <ChevronRight size={11} />}
            {clickable ? (
              <button className={`crumb ${c.kind}`} onClick={() => go(i)} title={c.label}>
                {c.label}
              </button>
            ) : (
              <span className={`crumb ${c.kind}${i === last ? ' current' : ''}`}>{c.label}</span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
