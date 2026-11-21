import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { CURVES_LESSON, FOX_LESSON, IK_LESSON, LESSONS, MESH_LESSON, RIG_LESSON, SKINS_LESSON, EXPORT_LESSON } from '../src/core/lessons';

type BoneActions = typeof import('../src/store/boneActions');
type DocModule = typeof import('../src/store/doc');
type UiModule = typeof import('../src/store/ui');
const UI = '/src/store/ui.ts';
const BONES = '/src/store/boneActions.ts';
const DOC = '/src/store/doc.ts';

/** Starts clean once (not at every reload, so what the editor remembers can be tested), then opens the demo from the welcome window. */
async function openFresh(page: Page) {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('fresh')) {
      sessionStorage.setItem('fresh', '1');
      localStorage.clear();
    }
  });
  await page.goto('/');
}
/** Starts a lesson the way a person does: opens Help and presses the button of the lesson. */
async function startFromHelp(page: Page, id: string) {
  await page.evaluate(async (url) => {
    const { uiStore } = (await import(url)) as UiModule;
    uiStore.patch({ helpOpen: true });
  }, UI);
  await page.locator(`[data-learn="lesson-${id}"]`).click();
}
async function openDemoWithLesson(page: Page) {
  await openFresh(page);
  await page.locator('.overlay .choice.primary').click();
  await expect.poll(() => page.locator('.row .label').count()).toBeGreaterThan(5);
}

for (const locale of ['en-US', 'ru-RU'] as const) {
  const lang = locale === 'ru-RU' ? 'ru' : 'en';
  test.describe(`the fox lesson (${locale})`, () => {
    test.use({ locale });

    test('starts by itself with the first demo, and is passed with the real keys and clicks of the editor', async ({ page }) => {
      await openDemoWithLesson(page);
      const card = page.locator('.learn');
      const step = (i: number) => FOX_LESSON.steps[i];
      await expect(card).toBeVisible();
      await expect(card.locator('.learn-title')).toHaveText(FOX_LESSON.title[lang]);
      await expect(card.locator('.learn-step-title')).toHaveText(step(0).title[lang]);
      await expect(card.locator('.learn-text')).toHaveText(step(0).text[lang]);
      await expect(page.locator('[data-learn-hl]')).toHaveCount(1);
      await expect(page.locator('[data-learn="tree"]')).toHaveAttribute('data-learn-hl', '');

      // 1. pick a bone (a click in the hierarchy)
      await page.locator('.left .row').nth(2).click();
      await expect(card.locator('.learn-step-title')).toHaveText(step(1).title[lang]);
      await expect(page.locator('aside.right')).toHaveAttribute('data-learn-hl', '');
      await expect(page.locator('[data-learn="tree"]')).not.toHaveAttribute('data-learn-hl', '');

      // 2. change it (the same action a drag or an Inspector field makes)
      const turn = (rotation: number) =>
        page.evaluate(
          async ([doc, bones, rot]) => {
            const { docStore } = (await import(doc)) as DocModule;
            const { setBonePose } = (await import(bones)) as BoneActions;
            const id = docStore.get().skeleton.bones[2].id;
            setBonePose([{ id, props: { rotation: rot } }]);
          },
          [DOC, BONES, rotation] as const,
        );
      await turn(25);
      await expect(card.locator('.learn-step-title')).toHaveText(step(2).title[lang]);

      // 3. Tab switches to Animate
      await page.keyboard.press('Tab');
      await expect(card.locator('.learn-step-title')).toHaveText(step(3).title[lang]);
      await expect(page.locator('[data-learn="play"]')).toHaveAttribute('data-learn-hl', '');

      // 4. Space plays, Space stops
      await page.keyboard.press('Space');
      await expect(card.locator('.learn-step-title')).toHaveText(step(4).title[lang]);
      await page.keyboard.press('Space');

      // 5. a key of our own: the pose of the selected bone at another time, with Auto key on
      await page.evaluate(async (url) => {
        const { uiStore } = (await import(url)) as UiModule;
        uiStore.patch({ time: 0.37, playing: false });
      }, UI);
      await turn(-40);
      await expect(card.locator('.learn-step-title')).toHaveText(step(5).title[lang]);
      await expect(page.locator('[data-learn="export"]')).toHaveAttribute('data-learn-hl', '');

      // 6. Ctrl+E opens Export: the lesson is over
      await page.keyboard.press('Control+e');
      await expect(page.locator('.overlay .dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(card.locator('.learn-count')).toHaveText('6/6');
      await expect(card.locator('.learn-text')).toHaveText(FOX_LESSON.outro[lang]);
      await expect(page.locator('[data-learn-hl]')).toHaveCount(0);

      // Done closes it, and it does not come back after a reload (it was finished and offered once)
      await card.getByRole('button', { name: lang === 'ru' ? 'Готово' : 'Done' }).click();
      await expect(card).toHaveCount(0);
      await page.reload();
      await expect(page.locator('.learn')).toHaveCount(0);
    });

    test('can be skipped, folded and closed at any time, and is offered again from the welcome window', async ({ page }) => {
      await openDemoWithLesson(page);
      const card = page.locator('.learn');
      await expect(card.locator('.learn-count')).toHaveText('0/6');

      await card.locator('.btn.ghost').click(); // skip the first step
      await expect(card.locator('.learn-step-title')).toHaveText(FOX_LESSON.steps[1].title[lang]);

      await card.getByRole('button', { name: lang === 'ru' ? 'Свернуть урок' : 'Fold the lesson' }).click();
      await expect(card.locator('.learn-body')).toHaveCount(0);
      await expect(page.locator('[data-learn-hl]')).toHaveCount(0); // folded: no frame either
      await card.getByRole('button', { name: lang === 'ru' ? 'Развернуть урок' : 'Unfold the lesson' }).click();
      await expect(page.locator('[data-learn-hl]')).toHaveCount(1);

      await card.getByRole('button', { name: lang === 'ru' ? 'Закрыть урок' : 'Close the lesson' }).click();
      await expect(card).toHaveCount(0);
      await expect(page.locator('[data-learn-hl]')).toHaveCount(0);

      // the editor keeps working, and the lesson comes back only when asked: Help → the lesson button
      await page.evaluate(async (url) => {
        const { uiStore } = (await import(url)) as UiModule;
        uiStore.patch({ helpOpen: true });
      }, UI);
      await page.locator('.dialog .btn').first().click();
      await expect(page.locator('.learn')).toBeVisible();
      await expect(page.locator('.learn .learn-count')).toHaveText('0/6');
    });

    test('the card and the frame stay inside a small window and the page does not stretch', async ({ page }) => {
      await page.setViewportSize({ width: 1100, height: 560 });
      await openDemoWithLesson(page);
      const box = await page.evaluate(() => {
        const r = document.querySelector('.learn')!.getBoundingClientRect();
        const wrap = document.querySelector('.viewport-wrap')!.getBoundingClientRect();
        const d = document.documentElement;
        return {
          inside: r.left >= wrap.left && r.right <= wrap.right && r.top >= wrap.top && r.bottom <= wrap.bottom,
          wide: d.scrollWidth - d.clientWidth,
          tall: d.scrollHeight - d.clientHeight,
        };
      });
      expect(box.inside).toBe(true);
      expect(box.wide).toBeLessThanOrEqual(0);
      expect(box.tall).toBeLessThanOrEqual(0);
    });

    test('axe finds nothing wrong with the card and the frame', async ({ page }) => {
      await openDemoWithLesson(page);
      await expect(page.locator('.learn')).toBeVisible();
      const r = await new AxeBuilder({ page }).analyze();
      expect(r.violations.map((v) => `${v.impact} ${v.id} x${v.nodes.length}: ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
    });
  });
}

test('a link to the demo starts the lesson once, and not again for a visitor who closed it', async ({ page }) => {
  await openFresh(page);
  await page.goto('/?demo=wave');
  await expect(page.locator('.learn')).toBeVisible();
  // the link opened Animate and started the playback: those steps count at once, in whatever order they happened
  await expect(page.locator('.learn .learn-count')).toHaveText(/^[2-9]\/6$/);
  await page.locator('.learn').getByRole('button', { name: 'Close the lesson' }).click();
  await page.goto('/?demo=wave');
  await expect(page.locator('.learn')).toHaveCount(0);
});

type SlotActions = typeof import('../src/store/slotActions');
type SessionActions = typeof import('../src/store/sessionActions');
const SLOTS = '/src/store/slotActions.ts';
const SESSION = '/src/store/sessionActions.ts';

for (const locale of ['en-US', 'ru-RU'] as const) {
  const lang = locale === 'ru-RU' ? 'ru' : 'en';
  test.describe(`the rig lesson (${locale})`, () => {
    test.use({ locale });

    test('is passed from an empty project: pictures, a bone drawn with B, a picture on it, a turn, playback', async ({ page }) => {
      await openFresh(page);
      await page.locator('.overlay .choice').nth(1).click(); // New project: no lesson starts by itself
      await expect(page.locator('.learn')).toHaveCount(0);
      await startFromHelp(page, 'rig');
      const card = page.locator('.learn');
      const step = (i: number) => RIG_LESSON.steps[i];
      await expect(card.locator('.learn-title')).toHaveText(RIG_LESSON.title[lang]);
      await expect(card.locator('.learn-step-title')).toHaveText(step(0).title[lang]);
      await expect(page.locator('[data-learn="images"]')).toHaveAttribute('data-learn-hl', '');

      // 1. the button of the step adds two sample pictures
      await card.getByRole('button', { name: step(0).helper!.label[lang] }).click();
      await expect(card.locator('.learn-step-title')).toHaveText(step(1).title[lang]);

      // 2. a bone drawn with the key and the mouse
      await page.keyboard.press('b');
      const area = await page.locator('.viewport-wrap').boundingBox();
      expect(area).not.toBeNull();
      // not from the middle: an empty project shows a card there that takes the pointer
      const at = (fx: number, fy: number) => [area!.x + area!.width * fx, area!.y + area!.height * fy] as const;
      await page.mouse.move(...at(0.2, 0.7));
      await page.mouse.down();
      await page.mouse.move(...at(0.35, 0.55), { steps: 6 });
      await page.mouse.move(...at(0.5, 0.35), { steps: 6 });
      await page.mouse.up();
      await expect(card.locator('.learn-step-title')).toHaveText(step(2).title[lang]);

      // 3. a picture on the new bone (what dropping it into the viewport does)
      await page.evaluate(
        async ([sessionUrl, slotUrl, docUrl]) => {
          const { docStore } = (await import(docUrl)) as DocModule;
          const session = (await import(sessionUrl)) as SessionActions;
          const slots = (await import(slotUrl)) as SlotActions;
          const bones = docStore.get().skeleton.bones;
          const id = bones[bones.length - 1].id;
          session.selectBone(id);
          slots.addImageToScene(docStore.get().images[0].name, 0, 0, id);
        },
        [SESSION, SLOTS, DOC] as const,
      );
      await expect(card.locator('.learn-step-title')).toHaveText(step(3).title[lang]);

      // 4. Tab, 5. a turn at another time (Auto key), 6. Space
      await page.keyboard.press('Tab');
      await expect(card.locator('.learn-step-title')).toHaveText(step(4).title[lang]);
      await page.evaluate(
        async ([ui, bonesUrl, docUrl]) => {
          const { uiStore } = (await import(ui)) as UiModule;
          const { docStore } = (await import(docUrl)) as DocModule;
          const { setBonePose } = (await import(bonesUrl)) as BoneActions;
          uiStore.patch({ time: 0.4 });
          const bones = docStore.get().skeleton.bones;
          setBonePose([{ id: bones[bones.length - 1].id, props: { rotation: 35 } }]);
        },
        [UI, BONES, DOC] as const,
      );
      await expect(card.locator('.learn-step-title')).toHaveText(step(5).title[lang]);
      await page.keyboard.press('Space');
      await expect(card.locator('.learn-count')).toHaveText('6/6');
      await expect(card.locator('.learn-text')).toHaveText(RIG_LESSON.outro[lang]);
      await page.keyboard.press('Space');
    });

    test('the first lesson leads to the second one when it is over', async ({ page }) => {
      await openDemoWithLesson(page);
      const card = page.locator('.learn');
      for (let i = 0; i < FOX_LESSON.steps.length; i++) await card.locator('.btn.ghost').click();
      await expect(card.locator('.learn-text')).toHaveText(FOX_LESSON.outro[lang]);
      await card.getByRole('button', { name: RIG_LESSON.title[lang] }).click();
      await expect(card.locator('.learn-title')).toHaveText(RIG_LESSON.title[lang]);
      await expect(card.locator('.learn-count')).toHaveText('0/6');
    });
  });
}

for (const locale of ['en-US', 'ru-RU'] as const) {
  const lang = locale === 'ru-RU' ? 'ru' : 'en';
  test.describe(`the mesh lesson (${locale})`, () => {
    test.use({ locale });

    test('is passed on a picture of the demo: Quad, Bind with the real buttons, the brush with W, a bend', async ({ page }) => {
      await openDemoWithLesson(page);
      await startFromHelp(page, 'mesh');
      const card = page.locator('.learn');
      const step = (i: number) => MESH_LESSON.steps[i];
      await expect(card.locator('.learn-title')).toHaveText(MESH_LESSON.title[lang]);
      await expect(card.locator('.learn-step-title')).toHaveText(step(0).title[lang]);

      // 1. a picture that is still a plain region
      const ids = await page.evaluate(
        async ([docUrl, sessionUrl]) => {
          const { docStore } = (await import(docUrl)) as DocModule;
          const session = (await import(sessionUrl)) as SessionActions;
          const sk = docStore.get().skeleton;
          const slot = sk.slots.find((s) => {
            const att = s.attachment ? sk.skins[0].attachments[s.id]?.[s.attachment] : undefined;
            return att?.type === 'region';
          })!;
          session.selectSlot(slot.id);
          return { bone: slot.bone };
        },
        [DOC, SESSION] as const,
      );
      await expect(card.locator('.learn-step-title')).toHaveText(step(1).title[lang]);

      // 2. Quad, 3. Bind (the buttons of the Inspector)
      await page
        .locator('aside.right')
        .getByRole('button', { name: /^(Quad|Квадрат)$/ })
        .click();
      await expect(card.locator('.learn-step-title')).toHaveText(step(2).title[lang]);
      await page
        .locator('aside.right')
        .getByRole('button', { name: /^(Bind to|Привязать к)/ })
        .click();
      await expect(card.locator('.learn-step-title')).toHaveText(step(3).title[lang]);

      // 4. W: the brush
      await page.keyboard.press('w');
      await expect(card.locator('.learn-step-title')).toHaveText(step(4).title[lang]);
      await page.keyboard.press('v');

      // 5. Tab, 6. a turn of the bone at another time bends the mesh
      await page.keyboard.press('Tab');
      await expect(card.locator('.learn-step-title')).toHaveText(step(5).title[lang]);
      await page.evaluate(
        async ([ui, bonesUrl, bone]) => {
          const { uiStore } = (await import(ui)) as UiModule;
          const { setBonePose } = (await import(bonesUrl)) as BoneActions;
          uiStore.patch({ time: 0.43 });
          setBonePose([{ id: bone, props: { rotation: 33 } }]);
        },
        [UI, BONES, ids.bone] as const,
      );
      await expect(card.locator('.learn-count')).toHaveText('6/6');
      await expect(card.locator('.learn-text')).toHaveText(MESH_LESSON.outro[lang]);
    });

    test('the second lesson leads to the third when it is over', async ({ page }) => {
      await openDemoWithLesson(page);
      await startFromHelp(page, 'rig');
      const card = page.locator('.learn');
      for (let i = 0; i < RIG_LESSON.steps.length; i++) await card.locator('.btn.ghost').click();
      await card.getByRole('button', { name: MESH_LESSON.title[lang] }).click();
      await expect(card.locator('.learn-title')).toHaveText(MESH_LESSON.title[lang]);
    });
  });
}

for (const locale of ['en-US', 'ru-RU'] as const) {
  const lang = locale === 'ru-RU' ? 'ru' : 'en';
  for (const width of [1100, 1440]) {
    test.describe(`the Lessons button (${locale}, ${width}px)`, () => {
      test.use({ locale, viewport: { width, height: 720 } });

      test('sits in the top bar with a dot until a lesson is finished, lists every lesson and starts the one that is picked', async ({
        page,
      }) => {
        await openFresh(page);
        await page.locator('.overlay .choice').nth(1).click(); // New project
        const button = page
          .locator('.topbar .menu')
          .filter({ has: page.locator('.tb-label') })
          .locator('button')
          .first();
        await expect(button).toBeVisible();
        await expect(page.locator('.topbar .lessons-dot')).toHaveCount(1);
        // the words are shown when there is room, only the icon in a narrow window
        await expect(page.locator('.topbar .tb-label')).toBeVisible({ visible: width > 1340 });
        // nothing spills past the window, and the button is not pushed out
        const room = await page.evaluate(() => ({
          wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          right: document.querySelector('.topbar .btn.primary')!.getBoundingClientRect().right,
        }));
        expect(room.wide).toBeLessThanOrEqual(0);
        expect(room.right).toBeLessThanOrEqual(width);

        await button.click();
        const items = page.locator('.topbar .menu-item');
        await expect(items).toHaveCount(LESSONS.length);
        await items.nth(1).click();
        await expect(page.locator('.learn .learn-title')).toHaveText(RIG_LESSON.title[lang]);
      });
    });
  }

  test.describe(`the tutorial button of an empty project (${locale})`, () => {
    test.use({ locale });
    test('loads the demo and starts the first lesson', async ({ page }) => {
      await openFresh(page);
      await page.locator('.overlay .choice').nth(1).click();
      await page.locator('.vp-empty-card .btn').nth(1).click();
      await expect(page.locator('.learn .learn-title')).toHaveText(FOX_LESSON.title[lang]);
      await expect.poll(() => page.locator('.row .label').count()).toBeGreaterThan(5);
    });
  });
}

type IkActions = typeof import('../src/store/ikActions');
const IK = '/src/store/ikActions.ts';

for (const locale of ['en-US', 'ru-RU'] as const) {
  const lang = locale === 'ru-RU' ? 'ru' : 'en';
  test.describe(`the IK lesson (${locale})`, () => {
    test.use({ locale });

    test('is passed on the demo: a bone picked, I, an IK target, V, a pull, Tab, a key on the target, Space', async ({ page }) => {
      await openDemoWithLesson(page);
      await startFromHelp(page, 'ik');
      const card = page.locator('.learn');
      const step = (i: number) => IK_LESSON.steps[i];
      await expect(card.locator('.learn-title')).toHaveText(IK_LESSON.title[lang]);

      // 1. the head bone (its parent is not the root, so the chain has two bones)
      const head = await page.evaluate(
        async ([docUrl, sessionUrl]) => {
          const { docStore } = (await import(docUrl)) as DocModule;
          const session = (await import(sessionUrl)) as SessionActions;
          const id = docStore.get().skeleton.bones.find((b) => b.name === 'head')!.id;
          session.selectBone(id);
          return id;
        },
        [DOC, SESSION] as const,
      );
      await expect(card.locator('.learn-step-title')).toHaveText(step(1).title[lang]);
      await expect(page.locator('[data-learn="tool-ik"]')).toHaveAttribute('data-learn-hl', '');

      // 2. the key I picks the tool; the drag is the action it ends in
      await page.keyboard.press('i');
      await page.evaluate(
        async ([ikUrl, bone]) => {
          const ik = (await import(ikUrl)) as IkActions;
          ik.createIkFromDrag(bone, null, 160, 220);
        },
        [IK, head] as const,
      );
      await expect(card.locator('.learn-step-title')).toHaveText(step(2).title[lang]);
      await page.keyboard.press('v');

      // 3. the target is pulled (the same edit a drag of it makes)
      const move = (x: number) =>
        page.evaluate(
          async ([docUrl, bonesUrl, px]) => {
            const { docStore } = (await import(docUrl)) as DocModule;
            const { setBonePose } = (await import(bonesUrl)) as BoneActions;
            const target = docStore.get().skeleton.bones.at(-1)!.id;
            setBonePose([{ id: target, props: { x: px } }]);
          },
          [DOC, BONES, x] as const,
        );
      await move(190);
      await expect(card.locator('.learn-step-title')).toHaveText(step(3).title[lang]);

      // 4. Tab, 5. a key on the target at another time, 6. Space
      await page.keyboard.press('Tab');
      await expect(card.locator('.learn-step-title')).toHaveText(step(4).title[lang]);
      await page.evaluate(async (url) => {
        const { uiStore } = (await import(url)) as UiModule;
        uiStore.patch({ time: 0.45 });
      }, UI);
      await move(230);
      await expect(card.locator('.learn-step-title')).toHaveText(step(5).title[lang]);
      await page.keyboard.press('Space');
      await expect(card.locator('.learn-count')).toHaveText('6/6');
      await expect(card.locator('.learn-text')).toHaveText(IK_LESSON.outro[lang]);
      await page.keyboard.press('Space');
    });

    test('the third lesson leads to the fourth when it is over', async ({ page }) => {
      await openDemoWithLesson(page);
      await startFromHelp(page, 'mesh');
      const card = page.locator('.learn');
      for (let i = 0; i < MESH_LESSON.steps.length; i++) await card.locator('.btn.ghost').click();
      await card.getByRole('button', { name: IK_LESSON.title[lang] }).click();
      await expect(card.locator('.learn-title')).toHaveText(IK_LESSON.title[lang]);
    });
  });
}

type KeyframeActions = typeof import('../src/store/keyframeActions');
type KeyRefs = typeof import('../src/core/keyrefs');
const KEYFRAMES = '/src/store/keyframeActions.ts';
const KEYREFS = '/src/core/keyrefs.ts';

for (const locale of ['en-US', 'ru-RU'] as const) {
  const lang = locale === 'ru-RU' ? 'ru' : 'en';
  test.describe(`the curves lesson (${locale})`, () => {
    test.use({ locale });

    test('is passed on the demo: Tab, a key selected, an interpolation, the real graph button, a handle, Space', async ({ page }) => {
      await openDemoWithLesson(page);
      await startFromHelp(page, 'curves');
      const card = page.locator('.learn');
      const step = (i: number) => CURVES_LESSON.steps[i];
      await expect(card.locator('.learn-title')).toHaveText(CURVES_LESSON.title[lang]);

      // 1. Tab
      await page.keyboard.press('Tab');
      await expect(card.locator('.learn-step-title')).toHaveText(step(1).title[lang]);
      await expect(page.locator('[data-learn="timeline"]')).toHaveAttribute('data-learn-hl', '');

      // 2. a key of the animation on the timeline (selected like a click on its diamond does)
      const ref = await page.evaluate(
        async ([docUrl, uiUrl, refsUrl]) => {
          const { docStore } = (await import(docUrl)) as DocModule;
          const { uiStore } = (await import(uiUrl)) as UiModule;
          const { encodeKey } = (await import(refsUrl)) as KeyRefs;
          const anim = docStore.get().skeleton.animations.find((a) => a.id === uiStore.get().animationId)!;
          const bone = Object.keys(anim.bones).find((id) => (anim.bones[id].rotate?.length ?? 0) > 1)!;
          const key = { kind: 'bone' as const, target: bone, prop: 'rotate', time: anim.bones[bone].rotate![0].time };
          uiStore.patch({ selectedKeys: [encodeKey(key)] });
          return key;
        },
        [DOC, UI, KEYREFS] as const,
      );
      await expect(card.locator('.learn-step-title')).toHaveText(step(2).title[lang]);

      // 3. the interpolation of the key (what the right-click menu does)
      await page.evaluate(
        async ([url, key]) => {
          const { setKeysCurve } = (await import(url)) as KeyframeActions;
          setKeysCurve([key], 'stepped');
        },
        [KEYFRAMES, ref] as const,
      );
      await expect(card.locator('.learn-step-title')).toHaveText(step(3).title[lang]);

      // 4. the real button of the graph
      await page.locator('[data-learn="graph"]').click();
      await expect(card.locator('.learn-step-title')).toHaveText(step(4).title[lang]);
      await expect(page.locator('[data-learn="timeline"]')).toHaveAttribute('data-learn-hl', '');

      // 5. a handle of the curve
      await page.evaluate(
        async ([url, key]) => {
          const { setKeyCurveHandle } = (await import(url)) as KeyframeActions;
          setKeyCurveHandle(key, 0, 1, 0.45, 0.2);
        },
        [KEYFRAMES, ref] as const,
      );
      await expect(card.locator('.learn-step-title')).toHaveText(step(5).title[lang]);

      // 6. Space (a focused button would take it as a click, so the focus goes back to the page first)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('Space');
      await expect(card.locator('.learn-count')).toHaveText('6/6');
      await expect(card.locator('.learn-text')).toHaveText(CURVES_LESSON.outro[lang]);
      await page.keyboard.press('Space');
    });

    test('the fourth lesson leads to the fifth when it is over', async ({ page }) => {
      await openDemoWithLesson(page);
      await startFromHelp(page, 'ik');
      const card = page.locator('.learn');
      for (let i = 0; i < IK_LESSON.steps.length; i++) await card.locator('.btn.ghost').click();
      await card.getByRole('button', { name: CURVES_LESSON.title[lang] }).click();
      await expect(card.locator('.learn-title')).toHaveText(CURVES_LESSON.title[lang]);
    });
  });
}

for (const locale of ['en-US', 'ru-RU'] as const) {
  const lang = locale === 'ru-RU' ? 'ru' : 'en';
  const name = (en: string, ru: string) => (lang === 'ru' ? ru : en);
  test.describe(`the skins lesson (${locale})`, () => {
    test.use({ locale });

    test('is passed on the demo: a skin, a switch, an event, Tab, the diamond, Space', async ({ page }) => {
      await openDemoWithLesson(page);
      await startFromHelp(page, 'skins');
      const card = page.locator('.learn');
      const step = (i: number) => SKINS_LESSON.steps[i];
      await expect(card.locator('.learn-title')).toHaveText(SKINS_LESSON.title[lang]);
      await expect(card.locator('.learn-step-title')).toHaveText(step(0).title[lang]);
      await expect(page.locator('[data-learn="tree"]')).toHaveAttribute('data-learn-hl', '');

      // 1. the plus of the Skins section (a new skin is shown at once)
      await page.getByRole('button', { name: name('New skin', 'Новый скин'), exact: true }).click();
      await expect(card.locator('.learn-step-title')).toHaveText(step(1).title[lang]);

      // 2. back to another skin by a click on its row
      await page.locator('.row', { hasText: /^arctic$/ }).click();
      await expect(card.locator('.learn-step-title')).toHaveText(step(2).title[lang]);

      // 3. the plus of the Events section
      await page.getByRole('button', { name: name('New event', 'Новое событие'), exact: true }).click();
      await expect(card.locator('.learn-step-title')).toHaveText(step(3).title[lang]);

      // 4. Tab (the plus button was clicked and holds the focus, so it goes back to the page first)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('Tab');
      await expect(card.locator('.learn-step-title')).toHaveText(step(4).title[lang]);

      // 5. the diamond of the new event (the last one in the list)
      await page
        .getByRole('button', { name: name('Fire this event at the playhead', 'Вызвать это событие в текущем кадре'), exact: true })
        .last()
        .click();
      await expect(card.locator('.learn-step-title')).toHaveText(step(5).title[lang]);

      // 6. Space (a focused button would take it as a click, so the focus goes back to the page first)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('Space');
      await expect(card.locator('.learn-count')).toHaveText('6/6');
      await expect(card.locator('.learn-text')).toHaveText(SKINS_LESSON.outro[lang]);
      await page.keyboard.press('Space');
    });

    test('the fifth lesson leads to the sixth when it is over', async ({ page }) => {
      await openDemoWithLesson(page);
      await startFromHelp(page, 'curves');
      const card = page.locator('.learn');
      for (let i = 0; i < CURVES_LESSON.steps.length; i++) await card.locator('.btn.ghost').click();
      await card.getByRole('button', { name: SKINS_LESSON.title[lang] }).click();
      await expect(card.locator('.learn-title')).toHaveText(SKINS_LESSON.title[lang]);
    });
  });
}

for (const locale of ['en-US', 'ru-RU'] as const) {
  const lang = locale === 'ru-RU' ? 'ru' : 'en';
  const name = (en: string, ru: string) => (lang === 'ru' ? ru : en);
  test.describe(`the export lesson (${locale})`, () => {
    test.use({ locale });

    test('is passed on the demo: the Export button, the real ZIP download, the real player page download', async ({ page }) => {
      await openDemoWithLesson(page);
      await startFromHelp(page, 'export');
      const card = page.locator('.learn');
      const step = (i: number) => EXPORT_LESSON.steps[i];
      await expect(card.locator('.learn-title')).toHaveText(EXPORT_LESSON.title[lang]);
      await expect(card.locator('.learn-step-title')).toHaveText(step(0).title[lang]);
      await expect(page.locator('[data-learn="export"]')).toHaveAttribute('data-learn-hl', '');

      // 1. the real button of the top bar
      await page.locator('[data-learn="export"]').click();
      await expect(card.locator('.learn-step-title')).toHaveText(step(1).title[lang]);

      // 2. the ZIP (the button is enabled when the export is built)
      const zipButton = page.getByRole('button', { name: name('Download ZIP', 'Скачать ZIP'), exact: true });
      await expect(zipButton).toBeEnabled();
      const zip = page.waitForEvent('download');
      await zipButton.click();
      expect((await zip).suggestedFilename()).toMatch(/spine-4\.3\.zip$/);
      await expect(card.locator('.learn-step-title')).toHaveText(step(2).title[lang]);

      // 3. the player page
      const player = page.waitForEvent('download');
      await page.getByRole('button', { name: name('Save player page', 'Сохранить страницу-плеер'), exact: true }).click();
      expect((await player).suggestedFilename()).toMatch(/-player\.html$/);
      await expect(card.locator('.learn-count')).toHaveText('3/3');
      await expect(card.locator('.learn-text')).toHaveText(EXPORT_LESSON.outro[lang]);
    });

    test('the sixth lesson leads to the seventh when it is over', async ({ page }) => {
      await openDemoWithLesson(page);
      await startFromHelp(page, 'skins');
      const card = page.locator('.learn');
      for (let i = 0; i < SKINS_LESSON.steps.length; i++) await card.locator('.btn.ghost').click();
      await card.getByRole('button', { name: EXPORT_LESSON.title[lang] }).click();
      await expect(card.locator('.learn-title')).toHaveText(EXPORT_LESSON.title[lang]);
    });
  });
}
