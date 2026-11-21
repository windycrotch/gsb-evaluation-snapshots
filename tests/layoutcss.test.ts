/** Layout rules that were broken once and are cheap to keep: an icon sits in the middle of its button, a long dialog keeps its buttons in view, a narrow window loses the least needed controls first. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../src/styles/app.css'), 'utf8');
const rule = (selector: string): string => {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  return css.slice(at, css.indexOf('}', at));
};

describe('layout rules', () => {
  it('an icon button has no default button padding, which pushed every icon to the right', () => {
    expect(rule('.icon-btn')).toMatch(/padding:\s*0;/);
  });

  it('the buttons of a dialog stay in view when the form is long', () => {
    expect(rule('.dialog-foot')).toMatch(/position:\s*sticky;/);
  });

  it('a section bar is centred: the same space above and below its content', () => {
    expect(rule('.section-label.bar')).toMatch(/padding:\s*4px 12px;/);
  });

  it('the fields and buttons of the timeline bar are as tall as a control', () => {
    expect(rule('.tl-gap')).toMatch(/height:\s*var\(--h-control\)/);
    expect(css).toMatch(/\.tl-bar \.btn\.sm\s*\{\s*height:\s*var\(--h-control\)/);
  });

  it('the timeline bar gives up its controls in order as the panel narrows (labels, the time group, the options, the tail)', () => {
    const widths = [...css.matchAll(/@container \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
    for (const w of [1360, 1180, 1020, 760]) expect(widths).toContain(w);
  });

  it('the top bar keeps Export in view: the secondary buttons are dropped in two steps', () => {
    expect(css).toMatch(/@media \(max-width: 1240px\)\s*\{\s*\.tb-opt\s*\{\s*display:\s*none;/);
    expect(css).toMatch(/@media \(max-width: 1130px\)\s*\{\s*\.tb-opt2\s*\{\s*display:\s*none;/);
  });
});
