import { useMemo, useRef, useState } from 'react';
import { tr } from '@/i18n';
import { uiStore } from '@/store/ui';
import { buildCommands, filterCommands } from './commands';

/** Ctrl+K: type what you want to do. Arrow keys choose, Enter runs, Esc closes. */
export function Palette() {
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const all = useMemo(buildCommands, []);
  const shown = useMemo(() => filterCommands(all, query, tr).slice(0, 60), [all, query]);
  const list = useRef<HTMLDivElement>(null);
  const close = () => uiStore.patch({ paletteOpen: false });
  const run = (i: number) => {
    const c = shown[i];
    if (!c) return;
    close();
    setTimeout(c.run, 0); // after the palette is gone, so a command that opens a window keeps the focus
  };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length);
      setAt(next);
      list.current?.children[next]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(at);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          autoFocus
          value={query}
          onChange={(e) => (setQuery(e.target.value), setAt(0))}
          onKeyDown={key}
          placeholder="Type a command or a tool name…"
          aria-label="Command"
          spellCheck={false}
        />
        <div className="palette-list" ref={list} role="listbox">
          {shown.length === 0 && <div className="empty">Nothing matches</div>}
          {shown.map((c, i) => (
            <div
              key={c.id}
              role="option"
              aria-selected={i === at}
              className={`palette-item${i === at ? ' active' : ''}`}
              onMouseMove={() => setAt(i)}
              onClick={() => run(i)}
            >
              <span className="palette-title">{tr(c.title)}</span>
              <span className="palette-group">{tr(c.group)}</span>
              {c.keys && <kbd className="kbd">{c.keys}</kbd>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
