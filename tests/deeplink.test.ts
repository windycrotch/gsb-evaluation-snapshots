import { describe, expect, it } from 'vitest';
import { demoRequest } from '../src/editor/deeplink';

describe('demo deep link', () => {
  it('asks for the demo, with or without an animation', () => {
    expect(demoRequest('?demo')).toBe('');
    expect(demoRequest('?demo=wave')).toBe('wave');
    expect(demoRequest('?lang=ru&demo=Jump')).toBe('Jump');
  });

  it('ignores a link that does not ask for it, and keeps the name short', () => {
    expect(demoRequest('')).toBeNull();
    expect(demoRequest('?lang=ru')).toBeNull();
    expect(demoRequest(`?demo=${'x'.repeat(200)}`)).toHaveLength(64);
  });
});
