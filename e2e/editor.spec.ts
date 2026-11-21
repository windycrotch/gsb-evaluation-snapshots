import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type DocModule = typeof import('../src/store/doc');
type UiModule = typeof import('../src/store/ui');
// the dev server serves the sources, so the page can import the stores themselves
const DOC = '/src/store/doc.ts';
const UI = '/src/store/ui.ts';

/** Opens the editor on the demo fox, with the welcome window closed. */
async function openDemo(page: Page) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.locator('.overlay .choice.primary').click();
  // the demo is in when the hierarchy lists its bones (an empty project has only the root)
  await expect.poll(() => page.locator('.row .label').count()).toBeGreaterThan(5);
}

test('the demo rig loads and the hierarchy lists its bones', async ({ page }) => {
  await openDemo(page);
  await expect.poll(() => page.locator('.row .label').count()).toBeGreaterThan(5);
});

test('Ctrl+Z undoes an edit on a Russian keyboard layout too', async ({ page }) => {
  await openDemo(page);
  const fps = () => page.evaluate(async (url) => ((await import(url)) as DocModule).docStore.get().skeleton.fps, DOC);
  const before = await fps();
  await page.evaluate(async (url) => {
    const { docStore } = (await import(url)) as DocModule;
    docStore.update('Test edit', (d) => {
      d.skeleton.fps = 12;
    });
  }, DOC);
  expect(await fps()).toBe(12);
  // the key that is Z on a Latin layout types "я" on a Russian one
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'я', code: 'KeyZ', ctrlKey: true, bubbles: true })));
  await expect.poll(fps).toBe(before);
});

test('the icon of every icon button sits in the middle of the button', async ({ page }) => {
  await openDemo(page);
  const off = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.icon-btn')]
      .map((b) => {
        const svg = b.querySelector('svg');
        if (!svg || !b.offsetWidth) return 0;
        const a = b.getBoundingClientRect();
        const c = svg.getBoundingClientRect();
        return Math.max(Math.abs(a.left + a.width / 2 - (c.left + c.width / 2)), Math.abs(a.top + a.height / 2 - (c.top + c.height / 2)));
      })
      .reduce((m, v) => Math.max(m, v), 0),
  );
  expect(off).toBeLessThan(0.75);
});

for (const locale of ['en-US', 'ru-RU']) {
  for (const width of [1100, 1440, 1920]) {
    test.describe(`${locale} at ${width}px`, () => {
      test.use({ locale });
      test('nothing spills sideways', async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await openDemo(page);
        const spill = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(spill).toBeLessThanOrEqual(0);
      });
    });
  }
}

// the panels dragged to their smallest: no panel may grow a sideways scrollbar, whatever is selected and in either language
type ActionsModule = typeof import('../src/store/actions');
const ACTIONS = '/src/store/actions.ts';
for (const locale of ['en-US', 'ru-RU']) {
  test.describe(`panels at their minimum width (${locale})`, () => {
    test.use({ locale });
    test('no panel scrolls sideways for any bone or slot, in Setup and in Animate', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openDemo(page);
      const bad = await page.evaluate(
        async (urls) => {
          const { uiStore } = (await import(urls[0])) as UiModule;
          const { docStore } = (await import(urls[1])) as DocModule;
          const A = (await import(urls[2])) as ActionsModule;
          uiStore.patch({ panel: { left: 200, right: 230, bottom: 130 } });
          const sk = docStore.get().skeleton;
          const wide = new Set<string>();
          const look = (what: string) => {
            for (const sel of ['.left .panel-body', '.right .panel-body']) {
              for (const el of document.querySelectorAll<HTMLElement>(sel)) {
                if (el.scrollWidth <= el.clientWidth + 1) continue;
                // name the widest thing inside, so that a failure says where to look
                const edge = el.getBoundingClientRect().left + el.clientWidth;
                const culprit = [...el.querySelectorAll<HTMLElement>('*')].filter((c) => c.getBoundingClientRect().right > edge + 1).pop();
                wide.add(
                  `${what} ${sel} +${el.scrollWidth - el.clientWidth} at ${culprit?.tagName}.${culprit?.className} "${culprit?.textContent?.slice(0, 30)}"`,
                );
              }
            }
          };
          const settle = () => new Promise((r) => setTimeout(r, 30));
          for (const mode of ['setup', 'animate'] as const) {
            A.setMode(mode);
            if (mode === 'animate' && sk.animations[0]) A.selectAnimation(sk.animations[0].id);
            for (const b of sk.bones) {
              A.selectBone(b.id);
              await settle();
              look(`${mode} bone ${b.name}`);
            }
            for (const s of sk.slots) {
              A.selectSlot(s.id);
              A.setTool('mesh');
              await settle();
              look(`${mode} slot ${s.name}`);
              A.setTool('select');
            }
          }
          return [...wide];
        },
        [UI, DOC, ACTIONS],
      );
      expect(bad).toEqual([]);
    });
  });
}

test('wide panels in a narrow window give way to the viewport, and no column is crushed below its minimum', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await openDemo(page);
  await page.evaluate(async (url) => {
    const { uiStore } = (await import(url)) as UiModule;
    uiStore.patch({ panel: { left: 480, right: 480, bottom: 400 } });
  }, UI);
  const w = await page.evaluate(() => ({
    left: document.querySelector('.left')!.getBoundingClientRect().width,
    right: document.querySelector('.right')!.getBoundingClientRect().width,
    center: document.querySelector('.center')!.getBoundingClientRect().width,
    spill: document.documentElement.scrollWidth - window.innerWidth,
  }));
  expect(w.left).toBeGreaterThanOrEqual(200);
  expect(w.right).toBeGreaterThanOrEqual(230);
  expect(w.center).toBeGreaterThanOrEqual(300);
  expect(w.spill).toBeLessThanOrEqual(0);
});

for (const size of [
  { width: 1100, height: 560 },
  { width: 1280, height: 700 },
]) {
  test(`menus and windows stay inside the window and never stretch the page (${size.width}x${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    await openDemo(page);
    const bad = await page.evaluate(
      async (urls) => {
        const { uiStore } = (await import(urls[0])) as UiModule;
        const de = document.documentElement;
        const out: string[] = [];
        const stretched = () => de.scrollHeight > innerHeight + 1 || de.scrollWidth > innerWidth + 1;
        for (const b of [...document.querySelectorAll<HTMLButtonElement>('.menu > button')].filter((x) => x.offsetParent)) {
          const name = b.getAttribute('aria-label') ?? b.textContent ?? '?';
          b.click();
          await new Promise((r) => setTimeout(r, 120));
          const r = document.querySelector('.menu-pop')?.getBoundingClientRect();
          if (stretched() || !r || r.top < 0 || r.left < 0 || r.bottom > innerHeight + 0.5 || r.right > innerWidth + 0.5)
            out.push(`menu ${name}`);
          b.click();
          await new Promise((r) => setTimeout(r, 60));
        }
        for (const k of ['exportOpen', 'helpOpen', 'updatesOpen', 'feedbackOpen', 'settingsOpen', 'welcomeOpen', 'paletteOpen'] as const) {
          uiStore.patch({ [k]: true });
          await new Promise((r) => setTimeout(r, 150));
          const d = document.querySelector('.overlay > *')?.getBoundingClientRect();
          if (stretched() || !d || d.top < 0 || d.bottom > innerHeight + 0.5) out.push(`window ${k}`);
          uiStore.patch({ [k]: false });
        }
        return out;
      },
      [UI],
    );
    expect(bad).toEqual([]);
  });
}

test('the welcome window has the language switch', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  const lang = page.locator('.overlay .lang');
  await expect(lang).toBeVisible();
  await lang.getByRole('radio', { name: 'RU' }).click();
  await expect(page.locator('.overlay .dialog')).toContainText('Добро пожаловать');
  await lang.getByRole('radio', { name: 'EN' }).click();
  await expect(page.locator('.overlay .dialog')).toContainText('Welcome');
});

test('the Export window groups its settings', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(async (url) => {
    const { uiStore } = (await import(url)) as UiModule;
    uiStore.patch({ exportOpen: true });
  }, UI);
  const labels = page.locator('.dialog .section-label');
  await expect(labels.filter({ hasText: 'Skeleton data' })).toBeVisible();
  await expect(labels.getByText('Atlas', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Download ZIP/ })).toBeVisible();
});

test('a link with ?demo=wave opens the fox playing the wave, without the welcome window', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/?demo=wave');
  await expect(page.locator('.overlay .choice.primary')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        async (urls) => {
          const { uiStore } = (await import(urls[0])) as UiModule;
          const { docStore } = (await import(urls[1])) as DocModule;
          const ui = uiStore.get();
          const anim = docStore.get().skeleton.animations.find((a) => a.id === ui.animationId);
          return `${ui.mode}:${anim?.name}:${ui.playing}`;
        },
        [UI, DOC],
      ),
    )
    .toBe('animate:wave:true');
});

type ViewActions = typeof import('../src/store/viewActions');
const VIEWS = '/src/store/viewActions.ts';

test('the Metrics window checks the animations: a broken cycle is listed and one click puts it right', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(async (url) => {
    const { toggleView } = (await import(url)) as ViewActions;
    toggleView('metrics');
  }, VIEWS);
  const metrics = page.locator('.metrics');
  await expect(metrics.getByText('The animations and the names look fine')).toBeVisible();

  // the seam of the walk cycle is broken: the last key of a rotation is turned 30 degrees
  await page.evaluate(async (url) => {
    const { docStore } = (await import(url)) as DocModule;
    docStore.update('Break the loop', (d) => {
      const walk = d.skeleton.animations.find((a) => a.name === 'walk')!;
      for (const bone of Object.values(walk.bones)) {
        const keys = bone.rotate;
        if (keys && keys.length > 1) {
          keys[keys.length - 1].value = [keys[keys.length - 1].value[0] + 30];
          return;
        }
      }
    });
  }, DOC);
  const row = metrics.locator('.warn', { hasText: 'The end of this cycle is not the same as its start' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Fix' }).click();
  await expect(metrics.getByText('The animations and the names look fine')).toBeVisible();
});

type SetActions = typeof import('../src/store/selectionSetActions');
type SessionActions = typeof import('../src/store/sessionActions');
const SET_ACTIONS = '/src/store/selectionSetActions.ts';
const SESSION = '/src/store/sessionActions.ts';

test('the track filter can keep only the bones of a selection set', async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press('Tab'); // Animate: the timeline lists the tracks of the animation
  // a set of the first two animated bones
  const names = await page.evaluate(
    async ([docUrl, uiUrl, setUrl, sessionUrl]) => {
      const { docStore } = (await import(docUrl)) as DocModule;
      const { uiStore } = (await import(uiUrl)) as UiModule;
      const { saveSelectionSet } = (await import(setUrl)) as SetActions;
      const { selectBone } = (await import(sessionUrl)) as SessionActions;
      const doc = docStore.get().skeleton;
      const anim = doc.animations.find((a) => a.id === uiStore.get().animationId)!;
      const animated = Object.keys(anim.bones).filter((id) => Object.keys(anim.bones[id]).length > 0);
      selectBone(animated[0]);
      selectBone(animated[1], true);
      saveSelectionSet('pair');
      const nameOf = (id: string) => doc.bones.find((b) => b.id === id)!.name;
      return { inSet: [nameOf(animated[0]), nameOf(animated[1])], outside: nameOf(animated[2]) };
    },
    [DOC, UI, SET_ACTIONS, SESSION] as const,
  );
  const labels = page.locator('.tl-label');
  await expect(labels.filter({ hasText: names.outside }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Filter the tracks: kinds, names, selected only' }).click();
  await page.getByLabel('Only the bones of a set').selectOption({ label: 'pair' });
  await expect(labels.filter({ hasText: names.inSet[0] }).first()).toBeVisible();
  await expect(labels.filter({ hasText: names.inSet[1] }).first()).toBeVisible();
  await expect(labels.filter({ hasText: new RegExp(`^${names.outside}$`) })).toHaveCount(0);
  // and "Show all" brings everything back
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(labels.filter({ hasText: new RegExp(`^${names.outside}$`) }).first()).toBeVisible();
});

type MeshActions = typeof import('../src/store/meshActions');
const MESH_ACTIONS = '/src/store/meshActions.ts';

test('a selected mesh vertex has two number fields that place it exactly', async ({ page }) => {
  await openDemo(page);
  // a mesh that is not a link, with its first vertex picked (a click on the vertex does the same)
  const found = await page.evaluate(
    async ([docUrl, actionsUrl]) => {
      const { docStore } = (await import(docUrl)) as DocModule;
      const { setSelection } = (await import(actionsUrl)) as ActionsModule;
      const skin = docStore.get().skeleton.skins[0];
      for (const [slot, by] of Object.entries(skin.attachments))
        for (const att of Object.values(by))
          if (att.type === 'mesh' && !att.link) {
            setSelection({ slot, attachment: att.name, bones: [], vertices: [0] });
            return { slot, name: att.name };
          }
      return null;
    },
    [DOC, ACTIONS] as const,
  );
  expect(found).not.toBeNull();
  const worldOf = () =>
    page.evaluate(
      async ([meshUrl, slot, name]) => {
        const { getMesh, setupMats } = (await import(meshUrl)) as MeshActions;
        const mesh = getMesh(slot, name)!;
        const { mats, slotMat } = setupMats();
        const m = slotMat(slot);
        if (mesh.weights) {
          const [bone, x, y] = mesh.weights[0][0];
          const bm = mats.get(bone)!;
          return [bm.a * x + bm.b * y + bm.x, bm.c * x + bm.d * y + bm.y];
        }
        return [m.a * mesh.vertices[0] + m.b * mesh.vertices[1] + m.x, m.c * mesh.vertices[0] + m.d * mesh.vertices[1] + m.y];
      },
      [MESH_ACTIONS, found!.slot, found!.name] as const,
    );
  const x = page.locator('.frow', { hasText: 'Vertex X' }).locator('input');
  await expect(x).toBeVisible();
  await x.fill('12.5');
  await x.press('Enter');
  await expect.poll(async () => (await worldOf())[0]).toBeCloseTo(12.5, 1);
  const y = page.locator('.frow', { hasText: 'Vertex Y' }).locator('input');
  await y.fill('-7');
  await y.press('Enter');
  await expect.poll(async () => (await worldOf())[1]).toBeCloseTo(-7, 1);
});

test('the Metrics window runs the rig test and a click on a finding selects the bone and the mesh', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(async (url) => {
    const { toggleView } = (await import(url)) as ViewActions;
    toggleView('metrics');
  }, VIEWS);
  const metrics = page.locator('.metrics');
  // nothing is run until it is asked for
  await expect(metrics.getByText('A mesh folds over when this bone turns')).toHaveCount(0);
  await metrics.getByRole('button', { name: 'Run the rig test' }).click();
  const first = metrics.locator('.warn', { hasText: 'A mesh folds over when this bone turns' }).first();
  await expect(first).toBeVisible();
  await first.locator('b').click();
  const selection = await page.evaluate(async (url) => {
    const { uiStore } = (await import(url)) as UiModule;
    const s = uiStore.get().selection;
    return { bones: s.bones.length, slot: s.slot !== null, attachment: s.attachment !== null };
  }, UI);
  expect(selection).toEqual({ bones: 1, slot: true, attachment: true });
  // editing the rig makes the answer old
  await page.evaluate(async (url) => {
    const { docStore } = (await import(url)) as DocModule;
    docStore.update('Edit', (d) => {
      d.skeleton.bones[1].rotation += 1;
    });
  }, DOC);
  await expect(metrics.getByText('The rig was edited after this test: run it again.')).toBeVisible();
});
