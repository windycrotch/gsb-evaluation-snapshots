/**
 * The keys of the editor are named once (src/editor/tools.ts for the tool letters, src/editor/hotkeys.ts for the rest) and three things read
 * that table: the tooltips, the shortcuts window and the key handler. This test keeps them together: a row of the shortcuts window that the handler does
 * not implement, or a key in a tooltip that is typed by hand, fails it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BINDINGS, KEYS, comboOf, hotkeyGroups, keyIdOf, latinKey, setBinding } from '@/editor/hotkeys';
import { resetSettings } from '@/store/settings';
import { HINTS, TOOLS, toolForKey } from '@/editor/tools';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const app = read('src/editor/App.tsx');
const actions = read('src/editor/keyActions.ts');

afterEach(resetSettings);

describe('tools', () => {
  it('have one letter each, and no two share it', () => {
    const letters = TOOLS.map((t) => t.hotkey);
    expect(letters.every((l) => /^[A-Z]$/.test(l))).toBe(true);
    expect(new Set(letters).size).toBe(letters.length);
  });

  it('are the tools that have a hint, and the letter finds the tool in either case', () => {
    expect(TOOLS.map((t) => t.tool).sort()).toEqual(Object.keys(HINTS).sort());
    for (const t of TOOLS) {
      expect(toolForKey(t.hotkey)).toBe(t.tool);
      expect(toolForKey(t.hotkey.toLowerCase())).toBe(t.tool);
    }
    expect(toolForKey('q')).toBeUndefined();
  });
});

describe('the shortcuts window', () => {
  const rows = hotkeyGroups().flatMap((g) => g.rows);

  it('lists every tool and names every combination once', () => {
    for (const t of TOOLS) expect(rows.some((r) => r.keys.includes(t.hotkey) && r.label === t.title)).toBe(true);
    const combos = rows.flatMap((r) => r.keys);
    expect(combos.filter((c, i) => combos.indexOf(c) !== i)).toEqual([]);
    const labels = rows.map((r) => r.label);
    expect(labels.filter((l, i) => labels.indexOf(l) !== i)).toEqual([]);
  });

  it('is implemented by the key handler', () => {
    // a key as the handler sees it (e.key in lower case) -> where it must appear in App.tsx
    const handled = (combo: string): string | null => {
      if (/drag|Wheel/.test(combo)) return null; // the pointer, not the keyboard: the viewport and the timeline handle it
      const parts = combo.split('+');
      const key = parts[parts.length - 1];
      if (BINDINGS.some((b) => !b.fixed && (b.combo === combo || b.aliases?.includes(combo)))) return null; // a movable command: checked below
      const lower: Record<string, string> = {
        Tab: 'tab',
        Space: ' ',
        Del: 'delete',
        Backspace: 'backspace',
        Home: 'home',
        PgUp: 'pageup',
        PgDn: 'pagedown',
        Enter: 'enter',
        Esc: 'escape',
        '←': 'arrowleft',
        '→': 'arrowright',
        '↑': 'arrowup',
        '↓': 'arrowdown',
        '?': '?',
      };
      const name = lower[key] ?? key.toLowerCase();
      if (parts.includes('Ctrl')) return `key === '${name}'`;
      if (parts.includes('Alt')) return `e.altKey`; // Alt with an arrow: micro-move
      if (parts.includes('Shift')) return `e.shiftKey`; // Shift with an arrow: ten frames
      if (/^[A-Z]$/.test(key) && TOOLS.some((t) => t.hotkey === key)) return 'toolForKey(key)';
      return `case '${name}'`;
    };
    const missing: string[] = [];
    for (const r of rows)
      for (const combo of r.keys) {
        const needle = handled(combo);
        if (needle && !app.includes(needle)) missing.push(`${r.label}: ${combo} (App.tsx has no ${needle})`);
      }
    // every movable command has its action in keyActions.ts, and every action there belongs to a command
    for (const b of BINDINGS) if (!b.fixed && !actions.includes(`  ${b.id}:`)) missing.push(`${b.label}: keyActions.ts has no ${b.id}`);
    expect(missing).toEqual([]);
  });
});

describe('movable key combinations', () => {
  const press = (key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) =>
    comboOf({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  it('are read from a keyboard event the way the table writes them', () => {
    expect(press('z', { ctrlKey: true })).toBe('Ctrl+Z');
    expect(press('S', { ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+S');
    expect(press('s', { metaKey: true })).toBe('Ctrl+S');
    expect(press('?', { shiftKey: true })).toBe('?');
    expect(press(' ')).toBe('Space');
    expect(press('F12')).toBe('F12');
    expect(press('Tab', { shiftKey: true })).toBe('Shift+Tab');
    for (const k of ['Shift', 'Control', 'Alt', 'ArrowLeft', 'Escape', 'Enter', '+']) expect(press(k), k).toBeNull();
  });

  it('find the command of a combination, and the redo alias still works', () => {
    expect(keyIdOf('Ctrl+Z')).toBe('undo');
    expect(keyIdOf('Ctrl+Shift+Z')).toBe('redo');
    expect(keyIdOf('Ctrl+Q')).toBeNull();
  });

  it('move, and the old combination is free while the new one is taken', () => {
    expect(setBinding('undo', 'Ctrl+U')).toBeNull();
    expect(KEYS.undo).toBe('Ctrl+U');
    expect(keyIdOf('Ctrl+U')).toBe('undo');
    expect(keyIdOf('Ctrl+Z')).toBeNull();
    expect(
      hotkeyGroups()
        .flatMap((g) => g.rows)
        .find((r) => r.label === 'Undo')?.keys,
    ).toEqual(['Ctrl+U']);
    expect(setBinding('redo', 'Ctrl+Z')).toBeNull(); // the freed one can be used
  });

  it('refuse a combination another command, a tool or the browser has, and change nothing', () => {
    expect(setBinding('undo', 'Ctrl+S')).toBe('Save');
    expect(setBinding('undo', 'Ctrl+Shift+Z')).toBe('Redo'); // an alias counts
    expect(setBinding('undo', 'V')).toBe('Pose / select'); // a tool letter
    expect(setBinding('undo', 'Ctrl+W')).toBe('the browser');
    expect(setBinding('copy', 'Ctrl+J')).not.toBeNull(); // fixed
    expect(KEYS.undo).toBe('Ctrl+Z');
    expect(KEYS.copy).toBe('Ctrl+C');
  });

  it('go back to the default when it is typed again', () => {
    setBinding('save', 'Ctrl+U');
    expect(setBinding('save', 'Ctrl+S')).toBeNull();
    expect(KEYS.save).toBe('Ctrl+S');
  });
});

describe('tooltips', () => {
  it('take the keys from the table, never typed by hand', () => {
    for (const f of ['src/editor/App.tsx', 'src/editor/timeline/Timeline.tsx']) {
      const typed = [...read(f).matchAll(/hotkey="([^"]*)"/g)].map((m) => m[1]);
      expect(typed, f).toEqual([]);
    }
    expect(KEYS.undo).toBe('Ctrl+Z');
  });
});

describe('a non-Latin layout', () => {
  const press = (key: string, code: string, extra: object = {}) => ({
    key,
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...extra,
  });

  it('reads the letter from the position of the key, so Ctrl+Z works on a Russian layout', () => {
    expect(comboOf(press('я', 'KeyZ', { ctrlKey: true }))).toBe('Ctrl+Z');
    expect(keyIdOf(comboOf(press('я', 'KeyZ', { ctrlKey: true }))!)).toBe('undo');
    expect(comboOf(press('Я', 'KeyZ', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+Z');
    expect(comboOf(press('ы', 'KeyS', { ctrlKey: true }))).toBe('Ctrl+S');
    expect(comboOf(press('с', 'KeyC', { ctrlKey: true }))).toBe('Ctrl+C');
  });

  it('reads punctuation by position too', () => {
    expect(latinKey(press('х', 'BracketLeft'))).toBe('[');
    expect(latinKey(press('ъ', 'BracketRight'))).toBe(']');
    expect(latinKey(press('ю', 'Period'))).toBe('.');
  });

  it('leaves Latin layouts and named keys alone', () => {
    expect(comboOf(press('z', 'KeyY', { ctrlKey: true }))).toBe('Ctrl+Z'); // a German keyboard: the typed letter counts
    expect(latinKey(press('ArrowLeft', 'ArrowLeft'))).toBe('ArrowLeft');
    expect(latinKey(press('я', ''))).toBe('я'); // no position to go by
  });
});
