import { expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { renderPlayer } from "./player";

const SEEK_SLIDER = "[data-testid='seek-slider']";

async function waitForSliderRange() {
    const seek = page.getByRole("slider", { name: "Seek" });
    await expect.element(seek).toHaveAttribute("aria-valuemax", "4");
    return seek;
}

function sliderValue(seek: Awaited<ReturnType<typeof waitForSliderRange>>) {
    return Number(seek.element().getAttribute("aria-valuenow"));
}

async function expectSliderValue(seek: Awaited<ReturnType<typeof waitForSliderRange>>, expected: number, tolerance = 0.15) {
    await expect.poll(() => Math.abs(sliderValue(seek) - expected) <= tolerance).toBe(true);
}

async function sliderBox() {
    return page.getByTestId("seek-slider").element().getBoundingClientRect();
}

/** Presses on the slider track at `fraction` of its width. */
async function pressAt(fraction: number) {
    const box = await sliderBox();
    await commands.pointerDown(SEEK_SLIDER, box.width * fraction, box.height / 2);
}

/** Drags the pressed pointer to `fraction` of the slider's width. */
async function dragTo(fraction: number) {
    const box = await sliderBox();
    await commands.pointerDragTo(SEEK_SLIDER, box.width * fraction, box.height / 2);
}

test("dragging the progress bar previews the dragged time without media events winning", async () => {
    const video = await renderPlayer();
    const seek = await waitForSliderRange();

    await pressAt(0.1);
    await dragTo(0.75);

    // While the pointer is down the media must not be seeked and the thumb must
    // still show the drag position.
    await expectSliderValue(seek, 3);
    expect(video.currentTime).toBe(0);

    // Media events must not pull the thumb away mid-drag.
    video.dispatchEvent(new Event("timeupdate"));
    await expectSliderValue(seek, 3);

    await commands.pointerUp();
    await expect.poll(() => video.currentTime).toBeGreaterThan(2.5);
});

test("dragging while playback is running keeps the dragged value", async () => {
    const video = await renderPlayer();
    const seek = await waitForSliderRange();

    await userEvent.click(page.getByRole("button", { name: "Play" }));
    await expect.poll(() => video.currentTime).toBeGreaterThan(0);

    try {
        await pressAt(0.9);
        // Hold the pointer still for a few frames so the rAF-driven media clock
        // advances while the pointer is down.
        await expect.poll(() => video.currentTime).toBeGreaterThan(0.05);
        await dragTo(0.7);
        await expectSliderValue(seek, 2.8);

        // Let playback continue under the drag; the thumb must not follow it.
        const heldValue = sliderValue(seek);
        await expect.poll(() => video.currentTime).toBeGreaterThan(0.1);
        expect(Math.abs(sliderValue(seek) - heldValue)).toBeLessThan(0.05);

        await commands.pointerUp();
        await expect.poll(() => video.currentTime).toBeGreaterThan(2.5);
    } finally {
        video.pause();
    }
});

test("releasing the progress bar seeks once and then follows the media time", async () => {
    const video = await renderPlayer();
    const seek = await waitForSliderRange();

    await pressAt(0.25);
    await dragTo(0.5);
    await commands.pointerUp();

    // The committed time is applied to the media.
    await expect.poll(() => video.currentTime).toBeGreaterThan(1.5);
    await expectSliderValue(seek, 2);

    // Once the media reports the new time, the slider follows the media clock.
    await expect.poll(async () => {
        const mediaTime = Number(video.currentTime.toFixed(2));
        return Math.abs(sliderValue(seek) - mediaTime) < 0.2;
    }).toBe(true);
});

test("buffering progress during a drag does not interrupt the drag", async () => {
    const video = await renderPlayer();
    const seek = await waitForSliderRange();

    // Give the media a controllable buffered range.
    let end = 1;
    Object.defineProperty(video, "buffered", {
        configurable: true,
        get: () => ({
            length: 1,
            start: () => 0,
            end: () => end,
        }),
    });

    try {
        await pressAt(0.1);
        await dragTo(0.6);
        await expectSliderValue(seek, 2.4);

        // Buffer advances while the pointer is still down.
        end = 3;
        video.dispatchEvent(new Event("progress"));

        await expect.poll(() => page.getByTestId("buffered").elements().length).toBe(1);
        await expectSliderValue(seek, 2.4);
        expect(video.currentTime).toBe(0);

        // The drag can still continue after the buffered update.
        await dragTo(0.4);
        await expectSliderValue(seek, 1.6);

        await commands.pointerUp();
        await expect.poll(() => video.currentTime).toBeGreaterThan(1.2);
    } finally {
        Reflect.deleteProperty(video, "buffered");
    }
});

test("the progress bar enables once a seekable range first appears", async () => {
    const video = await renderPlayer();
    const seek = await waitForSliderRange();

    // Simulate media whose duration is unknown but which later reports a seekable
    // window (for example a live stream or a source that loads lazily).
    let seekableEnd: number | null = null;
    Object.defineProperty(video, "duration", {
        configurable: true,
        get: () => NaN,
    });
    Object.defineProperty(video, "seekable", {
        configurable: true,
        get: () => ({
            length: seekableEnd === null ? 0 : 1,
            start: () => 0,
            end: () => seekableEnd ?? 0,
        }),
    });

    try {
        video.dispatchEvent(new Event("durationchange"));
        // No seekable range yet: the bar must not accept a seek.
        await expect.poll(() => seek.element().hasAttribute("data-disabled")).toBe(true);

        seekableEnd = 6;
        video.dispatchEvent(new Event("loadedmetadata"));

        // The first seekable range must notify, so the bar becomes usable.
        const slider = page.getByRole("slider", { name: "Seek" });
        await expect.element(slider).toHaveAttribute("aria-valuemax", "6");
        await expect.poll(() => slider.element().hasAttribute("data-disabled")).toBe(false);
    } finally {
        Reflect.deleteProperty(video, "duration");
        Reflect.deleteProperty(video, "seekable");
    }
});

test("keyboard seeking still steps by one second and commits immediately", async () => {
    const video = await renderPlayer();
    const seek = await waitForSliderRange();

    await userEvent.click(seek);
    await userEvent.keyboard("{Home}");
    await expectSliderValue(seek, 0, 0.01);
    expect(video.currentTime).toBe(0);

    await userEvent.keyboard("{ArrowRight}");
    await expectSliderValue(seek, 1);

    // Shift uses ten keyboard increments, clamped to the end of the clip.
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await expectSliderValue(seek, 4, 0.01);
    await expect.poll(() => video.currentTime).toBeGreaterThan(3.5);

    // Keyboard commits are immediate, so the media moves without a pointer.
    await userEvent.keyboard("{PageDown}");
    await expectSlideSliderAndMedia(seek, video);
});

test("switching the source clears the old time, buffered ranges and tooltip", async () => {
    const video = await renderPlayer();
    const seek = await waitForSliderRange();

    // Play a little and buffer part of the clip.
    let bufferedEnd = 0;
    Object.defineProperty(video, "buffered", {
        configurable: true,
        get: () => ({
            length: bufferedEnd > 0 ? 1 : 0,
            start: () => 0,
            end: () => bufferedEnd,
        }),
    });

    try {
        bufferedEnd = 2;
        video.dispatchEvent(new Event("progress"));
        await expect.poll(() => page.getByTestId("buffered").elements().length).toBe(1);

        // Hovering the bar sets a tooltip percentage.
        const box = await sliderBox();
        await commands.pointerMove(SEEK_SLIDER, box.width * 0.5, box.height / 2);
        await expect.poll(() => {
            return Number(page.getByTestId("tooltip-percentage").element().textContent) > 0;
        }).toBe(true);

        // Seek into the clip, then switch to a new source.
        await pressAt(0.2);
        await dragTo(0.6);
        await commands.pointerUp();
        await expectSliderValue(seek, 2.4);
        // The drag moved the tooltip away from its initial position.
        await expect.poll(() => Number(page.getByTestId("tooltip-percentage").element().textContent)).toBeGreaterThan(0.3);

        bufferedEnd = 0;
        video.src = `${video.src.split("?")[0]}?reloaded=1`;
        video.load();

        // The old time, buffered ranges and hovered percentage must not survive
        // the source change.
        await expectSliderValue(seek, 0, 0.01);
        await expect.poll(() => page.getByTestId("buffered").elements().length).toBe(0);
        await expect.poll(() => page.getByTestId("tooltip-percentage").element().textContent).toBe("0");
    } finally {
        Reflect.deleteProperty(video, "buffered");
    }
});

async function expectSlideSliderAndMedia(
    seek: Awaited<ReturnType<typeof waitForSliderRange>>,
    video: HTMLVideoElement,
) {
    await expect.poll(() => Math.abs(sliderValue(seek) - video.currentTime) <= 0.2).toBe(true);
}
