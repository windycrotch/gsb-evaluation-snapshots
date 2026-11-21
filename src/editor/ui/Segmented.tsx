import type { LucideIcon } from 'lucide-react';
import { useRef } from 'react';
import { tr } from '@/i18n';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  title?: string;
  /** The colour of the active segment: the Setup colour, the Animate colour, or neutral (the default). */
  tone?: 'setup' | 'animate' | 'plain';
}

/**
 * A switch with a few exclusive options (Setup / Animate, EN / RU). One tab stop; the arrow keys move between the options.
 * The labels are children of elements made here, so the language runtime translates them; the titles (tooltips) are translated here.
 */
export function Segmented<T extends string>(props: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
  /** Names this switch for the lessons (a frame is drawn around it when a step points at it). */
  learn?: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const move = (e: React.KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + props.options.length) % props.options.length;
    props.onChange(props.options[next].value);
    group.current?.querySelectorAll<HTMLElement>('[role=radio]')[next]?.focus();
  };
  return (
    <div
      ref={group}
      className={`seg${props.className ? ` ${props.className}` : ''}`}
      role="radiogroup"
      aria-label={props.label}
      data-learn={props.learn}
    >
      {props.options.map((o, i) => {
        const Icon = o.icon;
        const active = o.value === props.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            className={active ? `active ${o.tone ?? 'plain'}` : (o.tone ?? 'plain')}
            data-tip={o.title && tr(o.title)}
            onClick={() => props.onChange(o.value)}
            onKeyDown={(e) => move(e, i)}
          >
            {Icon && <Icon size={14} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
