import { ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

/** Which sections of the inspector are folded: remembered between visits, shared by every object that shows the same section. */

const STORAGE_KEY = 'bone2d.sections';

function load(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set(); // storage can be blocked, or hold something else
  }
}

const folded = load();
const listeners = new Set<() => void>();
let version = 0;

function setSectionOpen(id: string, open: boolean) {
  if (open === !folded.has(id)) return;
  if (open) folded.delete(id);
  else folded.add(id);
  version++;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...folded]));
  } catch {
    /* not persisted */
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

function useSectionOpen(id: string): boolean {
  useSyncExternalStore(subscribe, () => version);
  return !folded.has(id);
}

/** What kind of rig element the section is about: the colour of its icon. */
export type SectionKind = 'ik' | 'transform' | 'slider' | 'path' | 'physics';

/**
 * A titled group of an inspector that folds. `id` names it for the memory of what is folded (`bone.transform`);
 * `actions` sit at the right of the title and stay visible when it is folded.
 */
export function Section(props: {
  id: string;
  title: string;
  icon?: LucideIcon;
  kind?: SectionKind;
  actions?: ReactNode;
  collapsible?: boolean;
  children: ReactNode;
}) {
  const open = useSectionOpen(props.id);
  const collapsible = props.collapsible !== false;
  const shown = !collapsible || open;
  const Icon = props.icon;
  const icon = Icon && <Icon size={14} className={props.kind ? `k-${props.kind}` : undefined} />;
  return (
    <section className={`group sec${shown ? '' : ' folded'}`}>
      <div className="group-title">
        {collapsible ? (
          <button type="button" className="sec-toggle" aria-expanded={shown} onClick={() => setSectionOpen(props.id, !shown)}>
            <ChevronDown size={13} className="sec-chev" />
            {icon}
            <span>{props.title}</span>
          </button>
        ) : (
          <span className="sec-static">
            {icon}
            <span>{props.title}</span>
          </span>
        )}
        <span className="spacer" />
        {props.actions}
      </div>
      {shown && props.children}
    </section>
  );
}
