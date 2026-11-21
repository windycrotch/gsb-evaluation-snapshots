import { X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { clampFloat, moveFloat, raiseFloat, toggleFloat, useFloats } from '@/store/floats';
import type { FloatId } from '@/store/floats';
import { IconButton } from './controls';

/**
 * A window that hovers over the editor: drag it by its title bar, close it with the X, and it stays where it was left (Spine's floating panels).
 * Several can be open at once; the one clicked last is on top.
 */
export function FloatingWindow(props: { id: FloatId; title: string; icon?: LucideIcon; width?: number; children: ReactNode }) {
  const saved = useFloats((s) => s.pos[props.id]);
  const rank = useFloats((s) => s.order.indexOf(props.id));
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const start = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const Icon = props.icon;
  const width = props.width ?? 288;
  const screen = () => ({ w: window.innerWidth, h: window.innerHeight });
  const pos = drag ?? clampFloat(saved, { w: width, h: 0 }, screen());

  // a window that was left off-screen (a smaller window than last time) comes back
  useEffect(() => {
    const onResize = () => moveFloat(props.id, clampFloat(saved, { w: width, h: 0 }, screen()));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [props.id, saved, width]);

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    raiseFloat(props.id);
    start.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    setDrag(clampFloat({ x: s.x + e.clientX - s.px, y: s.y + e.clientY - s.py }, { w: width, h: 0 }, screen()));
  };
  const up = () => {
    if (start.current && drag) moveFloat(props.id, drag);
    start.current = null;
    setDrag(null);
  };

  return (
    <div
      ref={box}
      className="float-win"
      role="dialog"
      aria-label={props.title}
      style={{ left: pos.x, top: pos.y, width, zIndex: `calc(var(--z-float) + ${Math.max(0, rank)})` }}
      onPointerDownCapture={() => raiseFloat(props.id)}
    >
      <div className="float-head" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {Icon && <Icon size={14} />}
        <span className="title">{props.title}</span>
        <IconButton icon={X} small title="Close" onClick={() => toggleFloat(props.id, false)} />
      </div>
      <div className="float-body">{props.children}</div>
    </div>
  );
}
