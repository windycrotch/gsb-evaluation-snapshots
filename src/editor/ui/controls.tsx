import { createContext, useContext, useLayoutEffect, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Check, X } from 'lucide-react';
import { clamp, parseNumberExpr } from '@/core/math';
import { docStore } from '@/store/doc';

/** A paragraph of explanation under a heading: two lines, and the rest opens on a click (when there is more). */
export function Hint({ children, flush }: { children: ReactNode; flush?: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [open, children]);
  const toggle = long || open;
  return (
    <p
      ref={ref}
      className={`hint-text hint-clamp${flush ? ' flush' : ' mb'}${toggle ? ' hint-more' : ''}${open ? ' open' : ''}`}
      title={toggle ? (open ? 'Click to fold' : 'Click to read all') : undefined}
      onClick={toggle ? () => setOpen(!open) : undefined}
    >
      {children}
    </p>
  );
}

/** An icon-only button: its title is its accessible name and its tooltip, with the hotkey as a key cap. */
export function IconButton(props: {
  icon: LucideIcon;
  title: string;
  onClick?: (e: React.MouseEvent) => void;
  active?: boolean;
  animate?: boolean;
  disabled?: boolean;
  small?: boolean;
  size?: number;
  hotkey?: string;
  tipPlace?: 'top' | 'bottom' | 'left' | 'right';
  style?: CSSProperties;
  /** Names this button for the lessons. */
  learn?: string;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      className={`icon-btn${props.active ? ' on' : ''}${props.animate ? ' animate' : ''}${props.small ? ' sm' : ''}`}
      aria-label={props.title}
      aria-pressed={props.active}
      data-learn={props.learn}
      data-tip={props.title}
      data-tip-key={props.hotkey}
      data-tip-place={props.tipPlace}
      onClick={props.onClick}
      disabled={props.disabled}
      style={props.style}
    >
      <Icon size={props.size ?? (props.small ? 14 : 17)} strokeWidth={1.9} />
      {props.hotkey && <span className="kbd-tip">{props.hotkey}</span>}
    </button>
  );
}

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  ghost?: boolean;
  danger?: boolean;
  small?: boolean;
  disabled?: boolean;
  title?: string;
  icon?: LucideIcon;
  /** Names this button for the lessons. */
  learn?: string;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      data-learn={props.learn}
      className={`btn${props.primary ? ' primary' : ''}${props.ghost ? ' ghost' : ''}${props.danger ? ' danger' : ''}${props.small ? ' sm' : ''}`}
      onClick={props.onClick}
      disabled={props.disabled}
      data-tip={props.title}
    >
      {Icon && <Icon size={15} strokeWidth={1.9} />}
      {props.children}
    </button>
  );
}

export function Toggle({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button
      type="button"
      className={`toggle${on ? ' on' : ''}`}
      onClick={() => onChange(!on)}
      aria-label={title}
      data-tip={title}
      role="switch"
      aria-checked={on}
    />
  );
}

function fmt(v: number, precision: number): string {
  if (!Number.isFinite(v)) return '0';
  const s = v.toFixed(precision);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** The label of the inspector row (`Field`) a control sits in, so that a number or a select in it has a name for a screen reader ("Position X"). */
export const FieldLabelContext = createContext('');
function useControlName(own?: string) {
  const row = useContext(FieldLabelContext);
  return row && own ? `${row} ${own}` : row || own || undefined;
}

export function NumberField(props: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  precision?: number;
  min?: number;
  max?: number;
  suffix?: string;
  keyed?: boolean;
  disabled?: boolean;
  wide?: boolean;
  title?: string;
}) {
  const { value, onChange, step = 1, precision = 2, min, max } = props;
  const [text, setText] = useState<string | null>(null);
  const scrub = useRef<{ x: number; v: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const name = useControlName(props.label);

  const commit = (raw: string) => {
    const v = parseNumberExpr(raw, value);
    if (v !== null) onChange(clamp(v, min ?? -Infinity, max ?? Infinity));
    setText(null);
  };

  const onDown = (e: React.PointerEvent) => {
    if (props.disabled) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    scrub.current = { x: e.clientX, v: value };
    docStore.beginGesture('Edit value');
  };
  const onMove = (e: React.PointerEvent) => {
    const s = scrub.current;
    if (!s) return;
    const mult = (e.shiftKey ? 10 : 1) * (e.altKey ? 0.1 : 1);
    onChange(clamp(s.v + (e.clientX - s.x) * step * mult * 0.5, min ?? -Infinity, max ?? Infinity));
  };
  const onUp = (e: React.PointerEvent) => {
    if (!scrub.current) return;
    scrub.current = null;
    docStore.endGesture();
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      className={`field${props.keyed ? ' keyed' : ''}${props.wide ? ' wide' : ''}${props.disabled ? ' disabled' : ''}`}
      data-tip={props.title}
      data-tip-place="top"
    >
      <span className="flabel" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {props.label}
      </span>
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        aria-label={name}
        disabled={props.disabled}
        spellCheck={false}
        value={text ?? fmt(value, precision) + (props.suffix ?? '')}
        onFocus={(e) => {
          setText(fmt(value, precision));
          requestAnimationFrame(() => e.target.select());
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== null && commit(text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit(text ?? fmt(value, precision));
            inputRef.current?.blur();
          } else if (e.key === 'Escape') {
            setText(null);
            inputRef.current?.blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const mult = (e.shiftKey ? 10 : 1) * (e.altKey ? 0.1 : 1);
            const nv = clamp(value + (e.key === 'ArrowUp' ? 1 : -1) * step * mult, min ?? -Infinity, max ?? Infinity);
            onChange(nv);
            setText(fmt(nv, precision));
          }
        }}
      />
    </div>
  );
}

export function TextField(props: {
  label?: string;
  name?: string;
  value: string;
  onCommit: (v: string) => void;
  wide?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const name = useControlName(props.name ?? props.label ?? props.placeholder);
  return (
    <div className={`field${props.wide ? ' wide' : ''}`}>
      {props.label && (
        <span className="flabel" style={{ cursor: 'default' }}>
          {props.label}
        </span>
      )}
      <input
        type="text"
        aria-label={name}
        spellCheck={false}
        placeholder={props.placeholder}
        value={text ?? props.value}
        onFocus={(e) => {
          setText(props.value);
          requestAnimationFrame(() => e.target.select());
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== null && text !== props.value) props.onCommit(text);
          setText(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'Escape') {
            setText(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}

export function SelectField<T extends string>(props: {
  label?: string;
  name?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  wide?: boolean;
}) {
  const name = useControlName(props.name ?? props.label);
  return (
    <div className={`field${props.wide ? ' wide' : ''}`}>
      {props.label && (
        <span className="flabel" style={{ cursor: 'default' }}>
          {props.label}
        </span>
      )}
      <select aria-label={name} value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function rgbaToHex(c: ArrayLike<number>): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [1, 1, 1];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

export function ColorSwatch({
  value,
  onChange,
  title,
}: {
  value: ArrayLike<number>;
  onChange: (rgb: [number, number, number]) => void;
  title?: string;
}) {
  return (
    <span className="swatch" data-tip={title} style={{ background: rgbaToHex(value) }}>
      <input type="color" aria-label={title ?? 'Color'} value={rgbaToHex(value)} onChange={(e) => onChange(hexToRgb(e.target.value))} />
    </span>
  );
}

/**
 * Keeps a pop-up (a menu, the track filter) inside the window: if it would run past an edge it is moved back, and if it is taller than the
 * window it scrolls inside itself. Without this a long menu near the bottom stretches the page (or is cut off). Works for `absolute` and
 * `fixed` pop-ups alike, because it only uses `translate`.
 */
export function useFitInWindow(ref: { current: HTMLElement | null }, active = true) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const edge = 8;
    el.style.translate = '';
    el.style.maxHeight = '';
    el.style.overflowY = '';
    const natural = el.getBoundingClientRect();
    if (natural.height > innerHeight - natural.top - edge) {
      // too tall for the room below it: stay under its button and scroll inside, unless that leaves a sliver (then take the whole window)
      const below = innerHeight - natural.top - edge;
      el.style.maxHeight = `${below >= 260 ? below : innerHeight - edge * 2}px`;
      el.style.overflowY = 'auto';
    }
    const r = el.getBoundingClientRect();
    let dx = 0;
    let dy = 0;
    if (r.right > innerWidth - edge) dx = innerWidth - edge - r.right;
    if (r.left + dx < edge) dx = edge - r.left;
    if (r.bottom > innerHeight - edge) dy = innerHeight - edge - r.bottom;
    if (r.top + dy < edge) dy = edge - r.top;
    if (dx || dy) el.style.translate = `${dx}px ${dy}px`;
  });
}

export function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', h);
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener('mousedown', h);
      window.removeEventListener('keydown', k);
    };
  }, [open, close]);
  return ref;
}

/** Arrow keys, Home and End move between the items of a menu. */
export function menuKeys(e: React.KeyboardEvent<HTMLElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role^=menuitem]:not(:disabled)')];
  if (!items.length) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'ArrowDown'
      ? (i + 1) % items.length
      : e.key === 'ArrowUp'
        ? i <= 0
          ? items.length - 1
          : i - 1
        : e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? items.length - 1
            : -1;
  if (next < 0) return;
  e.preventDefault();
  items[next].focus();
}

/** When a menu opens, the keyboard is in it: the first item has the focus. */
export function useFocusFirstItem(ref: React.RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    if (active) ref.current?.querySelector<HTMLElement>('[role^=menuitem]:not(:disabled)')?.focus();
  }, [ref, active]);
}

export function Menu(props: { label: ReactNode; children: (close: () => void) => ReactNode; icon?: LucideIcon; title?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useFocusFirstItem(pop, open);
  useFitInWindow(pop, open);
  const Icon = props.icon;
  return (
    <div className="menu" ref={ref}>
      <button
        ref={trigger}
        type="button"
        className={`btn ghost${open ? ' on' : ''}`}
        title={props.title}
        aria-label={props.title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => e.key === 'ArrowDown' && (e.preventDefault(), setOpen(true))}
      >
        {Icon && <Icon size={15} strokeWidth={1.9} />}
        {props.label}
      </button>
      {open && (
        <div
          ref={pop}
          className="menu-pop"
          role="menu"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation(); // closes the menu, not the selection
              setOpen(false);
              trigger.current?.focus();
            } else if (e.key === 'Tab') setOpen(false);
            else menuKeys(e);
          }}
        >
          {props.children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** One item of a menu. With `checked` it is a switch (a tick at the right while it is on). */
export function MenuItem(props: {
  icon?: LucideIcon;
  children: ReactNode;
  onClick: () => void;
  hotkey?: string;
  disabled?: boolean;
  checked?: boolean;
  title?: string;
  close: () => void;
}) {
  const Icon = props.icon;
  const checkable = props.checked !== undefined;
  return (
    <button
      type="button"
      role={checkable ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={checkable ? props.checked : undefined}
      className="menu-item"
      title={props.title}
      disabled={props.disabled}
      onClick={() => {
        props.close();
        props.onClick();
      }}
    >
      {Icon ? <Icon size={15} strokeWidth={1.9} /> : <span className="menu-gap" />}
      <span>{props.children}</span>
      {props.checked && <Check size={14} className="menu-check" />}
      {props.hotkey && <kbd className="kbd">{props.hotkey}</kbd>}
    </button>
  );
}

/** A modal dialog: the keyboard goes into it and comes back to where it was; Tab stays inside, Esc closes. */
export function Dialog(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.focus();
    return () => before?.focus?.();
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [props]);
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); // closes the dialog, not the selection
      props.onClose();
      return;
    }
    if (e.key !== 'Tab' || !box.current) return;
    const focusable = [
      ...box.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === box.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        ref={box}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
        onKeyDown={keys}
        style={props.width ? { width: props.width } : undefined}
      >
        <div className="dialog-head">
          <span role="heading" aria-level={2}>
            {props.title}
          </span>
          <span className="spacer" />
          <IconButton icon={X} title="Close" onClick={props.onClose} small />
        </div>
        <div className="dialog-body">{props.children}</div>
        {props.footer && <div className="dialog-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

export function Splitter(props: { dir: 'v' | 'h'; onDrag: (delta: number) => void }) {
  const [active, setActive] = useState(false);
  const last = useRef(0);
  return (
    <div
      className={`split-${props.dir}${active ? ' active' : ''}`}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        last.current = props.dir === 'v' ? e.clientX : e.clientY;
        setActive(true);
      }}
      onPointerMove={(e) => {
        if (!active) return;
        const p = props.dir === 'v' ? e.clientX : e.clientY;
        props.onDrag(p - last.current);
        last.current = p;
      }}
      onPointerUp={() => setActive(false)}
      onPointerCancel={() => setActive(false)}
    />
  );
}
