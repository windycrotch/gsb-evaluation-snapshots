import { Diamond } from 'lucide-react';
import type { ReactNode } from 'react';
import { useUi } from '@/store/ui';
import { FieldLabelContext } from './controls';

/** The diamond that keys a property at the playhead; lit when there is a key at the playhead. */
export function KeyButton(props: { on: boolean; onClick: () => void; title: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={`key-btn${props.on ? ' on' : ''}`}
      aria-pressed={props.on}
      aria-label={props.title}
      data-tip={props.title}
      data-tip-place="left"
      onClick={props.onClick}
      disabled={props.disabled}
    >
      <Diamond size={11} fill={props.on ? 'currentColor' : 'none'} strokeWidth={2.2} />
    </button>
  );
}

/**
 * One row of an inspector: a label, the controls, and (in Animate mode) a column for the key button.
 * The controls share the width equally (two number fields for X and Y, one select across the whole row); put several controls of
 * different widths into one `.hstack` child instead.
 */
export function Field(props: { label: string; title?: string; children: ReactNode; keyButton?: ReactNode }) {
  const animate = useUi((s) => s.mode === 'animate');
  return (
    <div className={`frow${animate ? ' keys' : ''}`}>
      <span
        className="frow-label"
        data-tip={props.title ?? props.label}
        data-tip-clipped={props.title ? undefined : ''}
        data-tip-place="top"
      >
        {props.label}
      </span>
      <div className="frow-body">
        <FieldLabelContext.Provider value={props.label}>{props.children}</FieldLabelContext.Provider>
      </div>
      {animate && <span className="frow-key">{props.keyButton}</span>}
    </div>
  );
}
