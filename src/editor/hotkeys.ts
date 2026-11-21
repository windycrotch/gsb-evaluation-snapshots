import { settingsStore, setSettings } from '@/store/settings';
import { TOOLS, hotkeyOf, setToolKey } from './tools';

export type KeyId =
  | 'undo'
  | 'redo'
  | 'save'
  | 'saveAs'
  | 'open'
  | 'export'
  | 'copy'
  | 'paste'
  | 'pasteHold'
  | 'flipView'
  | 'selectAll'
  | 'frame'
  | 'mode'
  | 'play'
  | 'key'
  | 'delete'
  | 'help'
  | 'hideViews'
  | 'settings'
  | 'duplicate'
  | 'palette'
  | 'mirror'
  | 'showAll'
  | 'isolate'
  | 'frameSelection'
  | 'zoom100'
  | 'parent'
  | 'keyShown';

export interface Binding {
  id: KeyId;
  /** The name in the shortcuts window and in the messages; also the row of the table there. */
  label: string;
  /** The default combination. */
  combo: string;
  /** Always this combination: it depends on what is focused, so it cannot be moved. */
  fixed?: boolean;
  /** Other combinations that do the same and stay as they are. */
  aliases?: string[];
}

/**
 * The commands that have a key combination, named once: the tooltips, the menus, the shortcuts window and Settings read them from here,
 * and keyActions.ts holds what each one does. The person can move them in Settings (the tool letters are in tools.ts).
 */
export const BINDINGS: Binding[] = [
  { id: 'undo', label: 'Undo', combo: 'Ctrl+Z' },
  { id: 'redo', label: 'Redo', combo: 'Ctrl+Y', aliases: ['Ctrl+Shift+Z'] },
  { id: 'save', label: 'Save', combo: 'Ctrl+S' },
  { id: 'saveAs', label: 'Save as…', combo: 'Ctrl+Shift+S' },
  { id: 'open', label: 'Open', combo: 'Ctrl+O' },
  { id: 'export', label: 'Export', combo: 'Ctrl+E' },
  { id: 'copy', label: 'Copy keys', combo: 'Ctrl+C', fixed: true },
  { id: 'paste', label: 'Paste keys', combo: 'Ctrl+V', fixed: true },
  { id: 'pasteHold', label: 'Paste keys, hold', combo: 'Ctrl+Shift+V', fixed: true },
  { id: 'selectAll', label: 'Select all bones', combo: 'Ctrl+A' },
  { id: 'frame', label: 'Frame skeleton', combo: 'F' },
  { id: 'frameSelection', label: 'Frame the selection', combo: 'Shift+F' },
  { id: 'zoom100', label: 'Zoom to 100%', combo: 'Shift+Z' },
  { id: 'flipView', label: 'Flip the viewport', combo: 'Ctrl+Shift+F' },
  { id: 'mode', label: 'Setup ⇄ Animate', combo: 'Tab' },
  { id: 'play', label: 'Play / pause', combo: 'Space' },
  { id: 'key', label: 'Key edited channels', combo: 'K' },
  { id: 'keyShown', label: 'Key all channels of the selected bones', combo: 'Ctrl+Shift+L' },
  { id: 'delete', label: 'Delete selection / keys', combo: 'Del', fixed: true },
  { id: 'help', label: 'Shortcuts', combo: '?' },
  { id: 'hideViews', label: 'Hide / show all windows', combo: 'F9' },
  { id: 'settings', label: 'Settings', combo: 'F12' },
  { id: 'duplicate', label: 'Duplicate bones', combo: 'Ctrl+D' },
  { id: 'palette', label: 'Command palette', combo: 'Ctrl+K' },
  { id: 'mirror', label: 'Mirror bones', combo: 'Ctrl+Shift+D' },
  { id: 'showAll', label: 'Show everything hidden', combo: 'Ctrl+H' },
  { id: 'isolate', label: 'Show only the selection', combo: 'Ctrl+Shift+H' },
  { id: 'parent', label: 'Set parent', combo: 'Shift+P' },
];

const BIND = Object.fromEntries(BINDINGS.map((b) => [b.id, b])) as Record<KeyId, Binding>;

/** What the person has set for a command, else the default. */
const bindingOf = (id: KeyId): string => {
  const b = BIND[id];
  return b.fixed ? b.combo : (settingsStore.get().keyMap[id] ?? b.combo);
};

/** The combinations of the editor as they are now ("Ctrl+Z"); read at the moment they are shown, so a change in Settings shows at once. */
export const KEYS = {} as Record<KeyId, string>;
for (const b of BINDINGS) Object.defineProperty(KEYS, b.id, { get: () => bindingOf(b.id), enumerable: true });

/** The combination of a keyboard event in the form the editor writes it, or null for a key that cannot be bound (a modifier on its own, the arrows…). */
/** The punctuation keys by position: with a layout that has no Latin letters on them a shortcut still means the key where it is on a US keyboard. */
const CODE_CHARS: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

/**
 * The key a shortcut means. With a Russian (or any non-Latin) layout `e.key` is "я" where Ctrl+Z is pressed, and every shortcut would be dead:
 * a letter or a punctuation mark that is not ASCII is read from the position of the key (`e.code`: KeyZ, BracketLeft…) instead.
 */
export function latinKey(e: { key: string; code?: string }): string {
  if (e.key.length !== 1 || e.key.charCodeAt(0) < 128) return e.key;
  const code = e.code ?? '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  return CODE_CHARS[code] ?? e.key;
}

export function comboOf(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> & { code?: string }): string | null {
  let key: string;
  const typed = latinKey(e);
  if (typed === ' ') key = 'Space';
  else if (typed.length === 1 && typed !== '+') key = typed.toUpperCase();
  else if (/^F\d{1,2}$/.test(typed) || typed === 'Tab') key = typed;
  else return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  // Shift is part of a symbol already (? is Shift+/), so it is named only with a letter, a digit-less key or the named keys
  if (e.shiftKey && (/^[A-Z]$/.test(key) || key === 'Space' || key === 'Tab' || key.length > 1)) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/** The command a combination belongs to (the default of a moved command is free again). */
export function keyIdOf(combo: string): KeyId | null {
  for (const b of BINDINGS) if (bindingOf(b.id) === combo || b.aliases?.includes(combo)) return b.id;
  return null;
}

/** The browser keeps these for itself (closing the tab, reloading…): a page cannot use them reliably. */
const RESERVED = new Set([
  'Ctrl+W',
  'Ctrl+T',
  'Ctrl+N',
  'Ctrl+Shift+N',
  'Ctrl+Shift+T',
  'Ctrl+R',
  'Ctrl+Shift+R',
  'Ctrl+Q',
  'Ctrl+L',
  'Ctrl+Tab',
  'F5',
  'F11',
]);

/** What already has a combination (a command, a tool, or the browser), for the message when it is taken. */
function whoHas(combo: string, except?: KeyId): string | null {
  if (RESERVED.has(combo)) return 'the browser';
  for (const b of BINDINGS) if (b.id !== except && (bindingOf(b.id) === combo || b.aliases?.includes(combo))) return b.label;
  return TOOLS.find((t) => hotkeyOf(t.tool) === combo)?.title ?? null;
}

/** Gives a command another combination. Returns what already has it (nothing changes then), or null when it is done. */
export function setBinding(id: KeyId, combo: string): string | null {
  const b = BIND[id];
  if (b.fixed) return b.label;
  const clash = whoHas(combo, id);
  if (clash) return clash;
  const keyMap = { ...settingsStore.get().keyMap };
  if (combo === b.combo) delete keyMap[id];
  else keyMap[id] = combo;
  setSettings({ keyMap });
  return null;
}

export function resetBinding(id: KeyId) {
  const keyMap = { ...settingsStore.get().keyMap };
  delete keyMap[id];
  setSettings({ keyMap });
}

export const isDefaultBinding = (id: KeyId): boolean => bindingOf(id) === BIND[id].combo;

/** Gives a tool another letter. Returns the name of what already has the letter, or null when it is done. */
export function assignToolKey(tool: (typeof TOOLS)[number]['tool'], letter: string): string | null {
  const key = letter.toUpperCase();
  const command = BINDINGS.find((b) => bindingOf(b.id) === key);
  if (command) return command.label;
  const other = setToolKey(tool, key);
  return other ? TOOLS.find((t) => t.tool === other)!.title : null;
}

export interface HotkeyRow {
  label: string;
  /** Alternatives; each one is a combination whose keys are joined by +. */
  keys: string[];
  /** The command, when its combination can be moved in Settings. */
  id?: KeyId;
}
export interface HotkeyGroup {
  title: string;
  rows: HotkeyRow[];
}

const row = (id: KeyId, ...more: string[]): HotkeyRow => {
  const b = BIND[id];
  return { label: b.label, keys: [KEYS[id], ...(b.aliases ?? []), ...more], id: b.fixed ? undefined : id };
};

/** The table of the shortcuts window and Settings as it stands now (the tool letters and the commands as the person set them). */
export const hotkeyGroups = (): HotkeyGroup[] => [
  { title: 'Tools', rows: TOOLS.map((t) => ({ label: t.title, keys: [hotkeyOf(t.tool)] })) },
  {
    title: 'Animation',
    rows: [
      row('mode'),
      row('play'),
      { label: 'Step frame', keys: ['←', '→'] },
      { label: 'Step 10 frames', keys: ['Shift+←', 'Shift+→'] },
      {
        label: 'Micro-move: bones by a unit; keys by a frame (← →) and their values (↑ ↓). Shift: ten',
        keys: ['Alt+←', 'Alt+→', 'Alt+↑', 'Alt+↓'],
      },
      { label: 'Go to the start', keys: ['Home'] },
      row('key'),
      row('keyShown'),
    ],
  },
  {
    title: 'Edit',
    rows: [
      row('undo'),
      row('redo'),
      row('selectAll'),
      row('duplicate'),
      row('mirror'),
      row('copy'),
      row('paste'),
      row('pasteHold'),
      { label: 'Shift keys: this and every later key', keys: ['Alt+drag a key'] },
      { label: 'Offset keys: round the loop', keys: ['Ctrl+Alt+drag a key'] },
      { label: 'Scale the time of the selected keys', keys: ['Ctrl+Shift+drag a selected key'] },
      row('delete', 'Backspace'),
      { label: 'Finish a polygon or path', keys: ['Enter'] },
      { label: 'Cancel / clear the selection', keys: ['Esc'] },
      { label: 'Previous / next selection', keys: ['PgUp', 'PgDn'] },
    ],
  },
  {
    title: 'View',
    rows: [
      row('frame'),
      row('frameSelection'),
      row('zoom100'),
      row('flipView'),
      row('hideViews'),
      row('showAll'),
      row('isolate'),
      { label: 'Pan viewport', keys: ['Mid drag', 'Right drag', 'Alt+drag'] },
      { label: 'Zoom', keys: ['Wheel'] },
      { label: 'Timeline zoom', keys: ['Ctrl+Wheel'] },
    ],
  },
  {
    title: 'File',
    rows: [row('save'), row('saveAs'), row('open'), row('export'), row('palette'), row('help'), row('settings')],
  },
];
