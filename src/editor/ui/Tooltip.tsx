import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { settingsStore } from '@/store/settings';

/**
 * Tooltips with the hotkey as a key cap.
 *
 * Nothing wraps the element that has one: any element with `data-tip="Rotate"` (and `data-tip-key="R"` for the hotkey,
 * `data-tip-place="right"` to choose the side, `data-tip-clipped` to show it only while its text is cut off) gets the tooltip after a short
 * delay under the pointer, at once for keyboard focus. One host in the app listens to the whole page, so a tooltip is an attribute, not a component.
 * The text arrives translated: the props it is made from (`title` of a button, `label` of a field) went through the language runtime already.
 */

type Place = 'top' | 'bottom' | 'left' | 'right';

interface Tip {
  text: string;
  hotkey?: string;
  rect: DOMRect;
  place: Place;
}

const DELAY = 450;
const GAP = 8;
const MARGIN = 8;

/** Where a tooltip of this size goes next to the element, kept inside the window. */
function placeTip(
  rect: { left: number; top: number; right: number; bottom: number },
  size: { width: number; height: number },
  place: Place,
  view: { width: number; height: number },
): { x: number; y: number } {
  let where = place;
  // not enough room on the wanted side: take the opposite one
  if (where === 'bottom' && rect.bottom + GAP + size.height > view.height - MARGIN) where = 'top';
  else if (where === 'top' && rect.top - GAP - size.height < MARGIN) where = 'bottom';
  else if (where === 'right' && rect.right + GAP + size.width > view.width - MARGIN) where = 'left';
  else if (where === 'left' && rect.left - GAP - size.width < MARGIN) where = 'right';
  let x: number;
  let y: number;
  if (where === 'bottom' || where === 'top') {
    x = (rect.left + rect.right) / 2 - size.width / 2;
    y = where === 'bottom' ? rect.bottom + GAP : rect.top - GAP - size.height;
  } else {
    x = where === 'right' ? rect.right + GAP : rect.left - GAP - size.width;
    y = (rect.top + rect.bottom) / 2 - size.height / 2;
  }
  return {
    x: Math.max(MARGIN, Math.min(view.width - size.width - MARGIN, x)),
    y: Math.max(MARGIN, Math.min(view.height - size.height - MARGIN, y)),
  };
}

export function TooltipHost() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer = 0;
    let owner: HTMLElement | null = null;
    const hide = () => {
      window.clearTimeout(timer);
      owner = null;
      setTip(null);
      setPos(null);
    };
    const find = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>('[data-tip]') : null);
    const open = (el: HTMLElement) => {
      const text = el.dataset.tip;
      if (!text || !el.isConnected) return;
      if (el.dataset.tipClipped !== undefined && el.scrollWidth <= el.clientWidth) return;
      setPos(null);
      setTip({
        text,
        hotkey: el.dataset.tipKey,
        rect: el.getBoundingClientRect(),
        place: (el.dataset.tipPlace as Place | undefined) ?? 'bottom',
      });
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || !settingsStore.get().tooltips) return;
      const el = find(e.target);
      if (el === owner) return;
      hide();
      if (!el) return;
      owner = el;
      timer = window.setTimeout(() => open(el), DELAY);
    };
    const onFocus = (e: FocusEvent) => {
      const el = find(e.target);
      if (!el || !el.matches(':focus-visible')) return; // only for the keyboard: a click focuses too
      hide();
      owner = el;
      open(el);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', hide);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      hide();
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // first drawn hidden at the corner to be measured, then moved to its place
  useLayoutEffect(() => {
    if (!tip || !box.current) return;
    const { width, height } = box.current.getBoundingClientRect();
    setPos(placeTip(tip.rect, { width, height }, tip.place, { width: window.innerWidth, height: window.innerHeight }));
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={box}
      className="tooltip"
      role="tooltip"
      style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      <span>{tip.text}</span>
      {tip.hotkey && <kbd className="kbd">{tip.hotkey}</kbd>}
    </div>,
    document.body,
  );
}
