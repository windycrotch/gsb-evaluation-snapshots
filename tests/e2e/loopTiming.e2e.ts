import { expect, test } from "@playwright/test";
import { callPlayer, center, expectNear, mouseDrag, openDemo, rowPoint, snapshot, touch, swipe } from "./helpers";

const desktop = () => test.skip(test.info().project.name !== "desktop", "mouse, wheel and keyboard");

test.beforeEach(async ({ page }) => openDemo(page));

test.describe("loop handle drags", () => {
  test("the loop is lifted while the handle is held and only commits on release", async ({ page }) => {
    await callPlayer(page, "setLoop", { start: 10, end: 20 });
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForTimeout(500);
    const before = await snapshot(page);
    expect(before.playState).toBe("playing");
    expect(before.position).toBeGreaterThanOrEqual(10);

    const from = await center(page, '[aria-label="Loop end"]');
    const to = await rowPoint(page, "timeline-loop", 0.5);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });

    const held = await snapshot(page);
    expect(held.playState).toBe("playing");
    expect(held.loop.start).toBe(0);
    expectNear(held.loop.end, held.duration, 0.01);
    const headWhileHeld = held.position;

    await page.mouse.up();
    const after = await snapshot(page);
    expect(after.playState).toBe("playing");
    expectNear(after.loop.end, after.duration / 2, after.duration * 0.03);
    expect(after.loop.start).toBe(0);
    // The playhead never teleported back to the old loop start during the drag.
    expect(after.position).toBeGreaterThanOrEqual(headWhileHeld - 0.05);
  });

  test("rapid successive drags leave one committed loop with the playhead inside it", async ({ page }) => {
    desktop();
    await mouseDrag(page, await center(page, '[aria-label="Loop end"]'), await rowPoint(page, "timeline-loop", 0.7));
    await mouseDrag(page, await center(page, '[aria-label="Loop start"]'), await rowPoint(page, "timeline-loop", 0.3));
    await mouseDrag(page, await center(page, '[aria-label="Loop end"]'), await rowPoint(page, "timeline-loop", 0.6));

    const s = await snapshot(page);
    expectNear(s.loop.start, s.duration * 0.3, s.duration * 0.03);
    expectNear(s.loop.end, s.duration * 0.6, s.duration * 0.03);

    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForTimeout(400);
    const moving = await snapshot(page);
    expect(moving.position).toBeGreaterThanOrEqual(moving.loop.start - 0.01);
    expect(moving.position).toBeLessThan(moving.loop.end);
  });

  test("a double-click while dragging restores the full song with a single commit", async ({ page }) => {
    desktop();
    await mouseDrag(page, await center(page, '[aria-label="Loop end"]'), await rowPoint(page, "timeline-loop", 0.6));
    const partial = await snapshot(page);
    expect(partial.loop.end).toBeLessThan(partial.duration - 1);

    await page.evaluate(() => {
      const w = window as unknown as { __gdCount?: number };
      w.__gdCount = 0;
      window.__gd!.player.subscribe(() => {
        w.__gdCount = (w.__gdCount ?? 0) + 1;
      });
    });
    const band = await rowPoint(page, "timeline-loop", 0.1);
    await page.mouse.dblclick(band.x, band.y);

    const reset = await snapshot(page);
    expectNear(reset.loop.start, 0, 0.01);
    expectNear(reset.loop.end, reset.duration, 0.01);
    // lift + unchanged commit + second lift + full commit: no extra transition per pointer event.
    const notifications = await page.evaluate(() => (window as unknown as { __gdCount: number }).__gdCount);
    expect(notifications).toBeLessThanOrEqual(4);
  });

  test("touch drag lifts and commits the loop", async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "touch");
    const from = await center(page, '[aria-label="Loop end"]');
    const to = await rowPoint(page, "timeline-loop", 0.5);
    await touch(page, swipe(from, to));
    const s = await snapshot(page);
    expectNear(s.loop.end, s.duration / 2, s.duration * 0.03);
    expect(s.loop.start).toBe(0);
  });
});

test.describe("loop delay vs new loop commits", () => {
  test("committing a new loop during the delay ends the wait and plays from the new start", async ({ page }) => {
    await callPlayer(page, "setLoop", { start: 1, end: 1.6 });
    await callPlayer(page, "setLoopMode", { type: "automatic", delay: 2 });
    await callPlayer(page, "dispatch", { type: "toggle-play" });
    await page.waitForFunction(() => window.__gd!.player.getState().playState === "waiting");

    const from = await center(page, '[aria-label="Loop end"]');
    const to = await rowPoint(page, "timeline-loop", 0.5);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    expect((await snapshot(page)).playState).toBe("waiting");
    await page.mouse.up();

    const committed = await snapshot(page);
    expect(committed.playState).toBe("playing");
    expect(committed.mode).toBe("playing");
    expect(committed.position).toBeLessThan(0.5);
    expectNear(committed.loop.end, committed.duration / 2, committed.duration * 0.03);

    await page.waitForTimeout(800);
    const later = await snapshot(page);
    expect(later.playState).toBe("playing");
    expect(later.position).toBeGreaterThan(committed.position + 0.3);
  });

  test("a no-op drag during the delay keeps the remaining wait and then restarts at the loop start", async ({ page }) => {
    desktop();
    // Build the loop through the UI so the timeline's own geometry matches the player.
    await mouseDrag(page, await center(page, '[aria-label="Loop end"]'), await rowPoint(page, "timeline-loop", 0.08));
    const built = await snapshot(page);
    expectNear(built.loop.end, built.duration * 0.08, built.duration * 0.02);
    await callPlayer(page, "setLoopMode", { type: "automatic", delay: 2 });
    await callPlayer(page, "dispatch", { type: "toggle-play" });
    await page.waitForFunction(() => window.__gd!.player.getState().playState === "waiting");
    const remaining = await snapshot(page);
    expect(remaining.position).toBeGreaterThan(4);

    const handle = await center(page, '[aria-label="Loop start"]');
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.up();

    const still = await snapshot(page);
    expect(still.playState).toBe("waiting");
    expect(still.mode).toBe("silent");
    expectNear(still.loop.start, built.loop.start, 0.01);

    await page.waitForFunction(() => window.__gd!.player.getState().playState === "playing", null, { timeout: 4000 });
    const resumed = await snapshot(page);
    expectNear(resumed.position, built.loop.start, 0.3);
  });
});

test.describe("freeze and speed interleaving", () => {
  test("the frozen sound follows the scrub and returns to frozen at the drop", async ({ page }) => {
    desktop();
    await page.getByRole("button", { name: "Freeze" }).click();
    const grip = await center(page, '[aria-label="Playhead"]');
    const drop = await rowPoint(page, "timeline-ruler", 0.35);
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(drop.x, drop.y, { steps: 5 });
    expect((await snapshot(page)).mode).toBe("scrubbing");
    await page.mouse.up();

    const frozen = await snapshot(page);
    expect(frozen.playState).toBe("frozen");
    expect(frozen.mode).toBe("frozen");
    expectNear(frozen.position, frozen.duration * 0.35, frozen.duration * 0.03);
    await page.waitForTimeout(600);
    const later = await snapshot(page);
    expect(later.playState).toBe("frozen");
    expectNear(later.position, frozen.position, 0.01);
  });

  test("touch: the frozen sound follows the scrub and returns to frozen at the drop", async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "touch");
    await page.getByRole("button", { name: "Freeze" }).click();
    const grip = await center(page, '[aria-label="Playhead"]');
    const drop = await rowPoint(page, "timeline-ruler", 0.35);
    await touch(page, [
      ["touchStart", [{ ...grip, id: 1 }]],
      ["touchMove", [{ x: grip.x + 20, y: grip.y, id: 1 }]],
    ]);
    expect((await snapshot(page)).mode).toBe("scrubbing");
    await touch(page, [["touchMove", [{ ...drop, id: 1 }]], ["touchEnd"]]);

    const frozen = await snapshot(page);
    expect(frozen.playState).toBe("frozen");
    expect(frozen.mode).toBe("frozen");
    expectNear(frozen.position, frozen.duration * 0.35, frozen.duration * 0.03);
  });

  test("changing speed while frozen only retimes the transport: the frozen point stays put", async ({ page }) => {
    desktop();
    await page.getByRole("button", { name: "Freeze" }).click();
    const frozenAt = (await snapshot(page)).position;

    await page.getByRole("button", { name: "Playback settings" }).click();
    const track = page.getByRole("slider", { name: "Speed" });
    const box = (await track.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
    await page.keyboard.press("Escape");

    const changed = await snapshot(page);
    expect(changed.speed).toBeLessThan(0.75);
    expect(changed.mode).toBe("frozen");
    await page.waitForTimeout(500);
    const held = await snapshot(page);
    expect(held.playState).toBe("frozen");
    expectNear(held.position, frozenAt, 0.01);
  });

  test("scrubbing while changing speed streams one fixed position and drops there", async ({ page }) => {
    desktop();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    const grip = await center(page, '[aria-label="Playhead"]');
    const drop = await rowPoint(page, "timeline-ruler", 0.4);
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(drop.x, drop.y, { steps: 4 });
    expect((await snapshot(page)).mode).toBe("scrubbing");

    await callPlayer(page, "setSpeed", 0.5);
    const scrubbing = await snapshot(page);
    expect(scrubbing.mode).toBe("scrubbing");
    const heldPosition = scrubbing.position;
    await page.waitForTimeout(400);
    expectNear((await snapshot(page)).position, heldPosition, 0.01);

    await page.mouse.up();
    const dropped = await snapshot(page);
    expect(dropped.playState).toBe("playing");
    expectNear(dropped.position, dropped.duration * 0.4, dropped.duration * 0.03);
  });

  test("speed changes while playing keep one continuous, never-backward playhead", async ({ page }) => {
    await callPlayer(page, "dispatch", { type: "toggle-play" });
    await page.waitForTimeout(800);
    const first = (await snapshot(page)).position;

    await callPlayer(page, "setSpeed", 1.5);
    const second = (await snapshot(page)).position;
    expect(second).toBeGreaterThanOrEqual(first - 0.05);
    await page.waitForTimeout(500);

    await callPlayer(page, "setSpeed", 0.4);
    const third = (await snapshot(page)).position;
    expect(third).toBeGreaterThanOrEqual(second - 0.05);
    await page.waitForTimeout(500);

    const fourth = await snapshot(page);
    expect(fourth.playState).toBe("playing");
    expect(fourth.mode).toBe("playing");
    expect(fourth.position).toBeGreaterThan(third);
  });
});
