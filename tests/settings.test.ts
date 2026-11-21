/** Preferences: what is read back from storage, and the tool letters that can be changed. */
import { afterEach, describe, expect, it } from 'vitest';
import { assignToolKey, hotkeyGroups, setBinding } from '../src/editor/hotkeys';
import { TOOLS, hotkeyOf, setToolKey, toolForKey } from '../src/editor/tools';
import { DEFAULT_SETTINGS, readSettings, resetSettings } from '../src/store/settings';

afterEach(resetSettings);

describe('settings', () => {
  it('start from the defaults when nothing or garbage is stored', () => {
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(readSettings('{broken')).toEqual(DEFAULT_SETTINGS);
    expect(readSettings(JSON.stringify({ autosave: 'yes', viewportBg: [2, 0, 0], smoothing: 1 }))).toEqual(DEFAULT_SETTINGS);
  });

  it('keep what is valid', () => {
    const s = readSettings(JSON.stringify({ autosave: false, viewportBg: [0.5, 0.5, 0.5], zoomToMouse: false, smoothing: false }));
    expect(s).toMatchObject({ autosave: false, zoomToMouse: false, smoothing: false, viewportBg: [0.5, 0.5, 0.5] });
  });

  it('take the bone size from the range of the slider and the hints from a flag', () => {
    expect(readSettings(JSON.stringify({ boneScale: 150, tooltips: false }))).toMatchObject({ boneScale: 150, tooltips: false });
    expect(readSettings(JSON.stringify({ boneScale: 120, tooltips: 'no' }))).toMatchObject({ boneScale: 120, tooltips: true });
    expect(readSettings(JSON.stringify({ boneScale: 5 }))).toMatchObject({ boneScale: 100 });
    expect(readSettings(JSON.stringify({ boneScale: 900 }))).toMatchObject({ boneScale: 100 });
    expect(readSettings(JSON.stringify({ boneScale: 'big' }))).toMatchObject({ boneScale: 100 });
  });

  it('take the turn of the bone icon only when it is a number within a half turn', () => {
    expect(readSettings(JSON.stringify({ boneIconRotation: 45 }))).toMatchObject({ boneIconRotation: 45 });
    expect(readSettings(JSON.stringify({ boneIconRotation: -180 }))).toMatchObject({ boneIconRotation: -180 });
    expect(readSettings(JSON.stringify({ boneIconRotation: 400 }))).toMatchObject({ boneIconRotation: 0 });
    expect(readSettings(JSON.stringify({ boneIconRotation: 'x' }))).toMatchObject({ boneIconRotation: 0 });
  });

  it('drop tool letters that are not one capital letter or that two tools share', () => {
    const s = readSettings(JSON.stringify({ toolKeys: { select: 'Q', create: 'Q', rotate: 'ab', scale: '5' } }));
    expect(s.toolKeys).toEqual({ select: 'Q' });
  });
});

describe('key combinations of the commands', () => {
  it('drop a combination that is not written the way the editor writes it or that two commands share', () => {
    const s = readSettings(
      JSON.stringify({ keyMap: { undo: 'Ctrl+U', redo: 'Ctrl+U', save: 'Ctrl+Shift+Alt+S', open: 'ctrl+o', export: 5, frame: 'G' } }),
    );
    expect(s.keyMap).toEqual({ undo: 'Ctrl+U', frame: 'G' });
  });

  it('and a tool letter cannot take the key of a command, nor the other way round', () => {
    expect(assignToolKey('rotate', 'k')).toBe('Key edited channels');
    expect(hotkeyOf('rotate')).toBe('R');
    setBinding('frame', 'G');
    expect(assignToolKey('rotate', 'f')).toBeNull(); // F is free now
    expect(hotkeyOf('rotate')).toBe('F');
  });
});

describe('tool letters', () => {
  it('can be changed, and the key handler and the shortcuts table follow', () => {
    expect(toolForKey('q')).toBeUndefined();
    expect(setToolKey('rotate', 'q')).toBeNull();
    expect(hotkeyOf('rotate')).toBe('Q');
    expect(toolForKey('q')).toBe('rotate');
    expect(toolForKey('r')).toBeUndefined(); // the old letter is free
    expect(hotkeyGroups()[0].rows.find((r) => r.label === 'Rotate')?.keys).toEqual(['Q']);
  });

  it('refuse a letter that another tool has, and change nothing', () => {
    const owner = TOOLS.find((t) => t.hotkey === 'V')!.tool;
    expect(setToolKey('rotate', 'v')).toBe(owner);
    expect(hotkeyOf('rotate')).toBe('R');
  });

  it('go back to the default when the default letter is typed again', () => {
    setToolKey('rotate', 'q');
    expect(setToolKey('rotate', 'r')).toBeNull();
    expect(hotkeyOf('rotate')).toBe('R');
  });
});
