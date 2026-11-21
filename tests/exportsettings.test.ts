/** Export settings: what a damaged or foreign file does, and the round trip through a file. */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EXPORT_SETTINGS,
  exportSettingsFromText,
  exportSettingsToText,
  loadExportSettings,
  readExportSettings,
  rememberExportSettings,
} from '../src/core/export/settings';

describe('export settings', () => {
  it('reads defaults from nothing, and from rubbish', () => {
    expect(readExportSettings(undefined)).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(readExportSettings('x')).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(readExportSettings({ scale: 7, maxSize: '2048', padding: -1, format: 'xml', pot: 1, filter: 'Cubic' })).toEqual(
      DEFAULT_EXPORT_SETTINGS,
    );
  });

  it('keeps the valid fields and defaults the rest', () => {
    const s = readExportSettings({ scale: 0.5, trim: true, rotate: true, filter: 'Nearest', maxSize: 99 });
    expect(s).toEqual({ ...DEFAULT_EXPORT_SETTINGS, scale: 0.5, trim: true, rotate: true, filter: 'Nearest' });
  });

  it('survives a trip through a file', () => {
    const s = { ...DEFAULT_EXPORT_SETTINGS, format: 'binary' as const, padding: 4, pretty: true, trim: true, filter: 'Nearest' as const };
    expect(exportSettingsFromText(exportSettingsToText(s))).toEqual(s);
  });

  it('refuses a file that is not an export settings file', () => {
    expect(exportSettingsFromText('{"scale":0.5}')).toBeNull();
    expect(exportSettingsFromText('not json')).toBeNull();
    expect(exportSettingsFromText('[]')).toBeNull();
    expect(exportSettingsFromText('null')).toBeNull();
  });

  it('is kept between sessions', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    const s = { ...DEFAULT_EXPORT_SETTINGS, rotate: true, scale: 0.75 };
    rememberExportSettings(s);
    expect(loadExportSettings()).toEqual(s);
    localStorage.setItem('bone2d.export', '{broken');
    expect(loadExportSettings()).toEqual(DEFAULT_EXPORT_SETTINGS);
    vi.unstubAllGlobals();
  });
});

describe('the mix table file', () => {
  const anims = [
    { id: 'a', name: 'walk' },
    { id: 'b', name: 'run' },
    { id: 'c', name: 'idle' },
  ];
  it('names the animations, drops pairs with a missing one, and says nothing for an empty table', async () => {
    const { mixesToText } = await import('../src/core/export/mixes');
    const text = mixesToText(anims, {
      default: 0.2,
      pairs: [
        { from: 'a', to: 'b', time: 0.35 },
        { from: 'a', to: 'zzz', time: 1 },
      ],
    })!;
    expect(JSON.parse(text)).toMatchObject({ defaultMix: 0.2, mixes: [{ from: 'walk', to: 'run', duration: 0.35 }] });
    expect(mixesToText(anims, { default: 0, pairs: [] })).toBeNull();
    expect(mixesToText(anims, undefined)).toBeNull();
    expect(mixesToText(anims, { default: 0, pairs: [{ from: 'a', to: 'zzz', time: 1 }] })).toBeNull();
  });
  it('is a setting that defaults on', () => {
    expect(DEFAULT_EXPORT_SETTINGS.mixes).toBe(true);
    expect(readExportSettings({ mixes: false }).mixes).toBe(false);
  });
});
