import { buildSSTVFilename } from '@/hooks/useAudioProcessor';

describe('buildSSTVFilename', () => {
  const date = new Date('2025-03-04T05:06:07.890Z');

  test('reflects the current mode rather than a fixed mode', () => {
    expect(buildSSTVFilename('ROBOT36', 1, date)).toContain('robot36');
    expect(buildSSTVFilename('PD120', 1, date)).toContain('pd120');
    expect(buildSSTVFilename('PD180', 1, date)).toContain('pd180');
    expect(buildSSTVFilename('ROBOT36', 1, date)).not.toBe(buildSSTVFilename('PD120', 1, date));
  });

  test('slugifies multi-word mode keys', () => {
    expect(buildSSTVFilename('SCOTTIE_S1', 1, date)).toContain('scottie-s1');
    expect(buildSSTVFilename('SCOTTIE_S2', 1, date)).toContain('scottie-s2');
  });

  test('includes the session id', () => {
    expect(buildSSTVFilename('PD120', 7, date)).toContain('session7');
    expect(buildSSTVFilename('PD120', 7, date)).not.toBe(buildSSTVFilename('PD120', 8, date));
  });

  test('is a timestamped PNG', () => {
    const name = buildSSTVFilename('ROBOT36', 2, date);
    expect(name.startsWith('sstv-decode-robot36-session2-')).toBe(true);
    expect(name.endsWith('.png')).toBe(true);
    // Timestamp has no characters that are invalid in a filename.
    const timestamp = name.slice('sstv-decode-robot36-session2-'.length, -'.png'.length);
    expect(timestamp).toMatch(/^[0-9T-]+$/);
  });
});
