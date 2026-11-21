import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type UiModule = typeof import('../src/store/ui');
type DocModule = typeof import('../src/store/doc');
type ActionsModule = typeof import('../src/store/actions');
const UI = '/src/store/ui.ts';

async function openDemo(page: Page) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.locator('.overlay .choice.primary').click();
  // the demo is in when the hierarchy lists its bones (an empty project has only the root)
  await expect.poll(() => page.locator('.row .label').count()).toBeGreaterThan(5);
}

/** What axe found, as short lines: the rule, how bad, and the first element. */
async function scan(page: Page) {
  const r = await new AxeBuilder({ page }).analyze();
  return r.violations.map((v) => `${v.impact} ${v.id} x${v.nodes.length}: ${v.nodes[0]?.target.join(' ')}`);
}

for (const locale of ['en-US', 'ru-RU']) {
  test.describe(`accessibility (axe) ${locale}`, () => {
    test.use({ locale });

    test('the welcome window', async ({ page }) => {
      await page.addInitScript(() => localStorage.clear());
      await page.goto('/');
      await expect(page.locator('.overlay .dialog')).toBeVisible();
      expect(await scan(page)).toEqual([]);
    });

    test('the editor with the demo rig', async ({ page }) => {
      await openDemo(page);
      expect(await scan(page)).toEqual([]);
    });

    test('inspector states: Animate mode, a weighted mesh, an IK bone', async ({ page }) => {
      await openDemo(page);
      const seen: string[] = [];
      for (const state of ['animate wave', 'mesh weights', 'ik bone'] as const) {
        await page.evaluate(
          async ([doc, actions, which]) => {
            const { docStore } = (await import(doc)) as DocModule;
            const A = (await import(actions)) as ActionsModule;
            const sk = docStore.get().skeleton;
            const bone = (re: RegExp) => {
              const b = sk.bones.find((x) => re.test(x.name));
              if (!b) throw new Error(`no bone ${re} in ${sk.bones.map((x) => x.name).join(', ')}`);
              return b;
            };
            if (which === 'animate wave') {
              A.setMode('animate');
              A.selectAnimation(sk.animations.find((a) => a.name === 'wave')!.id);
              A.selectBone(bone(/tail/).id);
            } else if (which === 'mesh weights') {
              A.setMode('setup');
              A.selectSlot(sk.slots.find((s) => s.name === 'tail')!.id);
              A.setTool('mesh');
            } else {
              A.setMode('setup');
              A.setTool('select');
              A.selectBone(bone(/ik/).id);
            }
          },
          ['/src/store/doc.ts', '/src/store/actions.ts', state],
        );
        await page.waitForTimeout(250);
        seen.push(...(await scan(page)).map((s) => `${state}: ${s}`));
      }
      expect(seen).toEqual([]);
    });

    test('the windows: Export, Settings, Help', async ({ page }) => {
      await openDemo(page);
      const seen: string[] = [];
      for (const k of ['exportOpen', 'settingsOpen', 'helpOpen'] as const) {
        await page.evaluate(
          async ([url, key]) => {
            const { uiStore } = (await import(url)) as UiModule;
            uiStore.patch({ [key]: true });
          },
          [UI, k],
        );
        await expect(page.locator('.overlay .dialog')).toBeVisible();
        seen.push(...(await scan(page)).map((s) => `${k}: ${s}`));
        await page.keyboard.press('Escape');
        await expect(page.locator('.overlay .dialog')).toHaveCount(0);
      }
      expect(seen).toEqual([]);
    });
  });
}
