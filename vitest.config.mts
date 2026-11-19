import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import type { BrowserCommandContext } from "vitest/node";
import { defineConfig } from "vitest/config";

const packageSources = fileURLToPath(new URL("./packages/$1/src", import.meta.url));

/**
 * Moves the pointer over an element (relative to its own box) without pressing.
 * Used by tests that need a pointer gesture Radix's slider can follow; the
 * built-in `userEvent.dragAndDrop` cannot target a slider track, because the
 * thumb captures the pointer.
 */
async function pointerMove(
    { page }: BrowserCommandContext,
    selector: string,
    x: number,
    y: number,
) {
    const frame = page.frameLocator("[data-vitest=\"true\"]");
    const box = await frame.locator(selector).boundingBox();
    if (!box) throw new Error(`Cannot find element for pointer move: ${selector}`);
    await page.mouse.move(box.x + x, box.y + y);
}

/** Presses the pointer at the given element-relative position. */
async function pointerDown(
    { page }: BrowserCommandContext,
    selector: string,
    x: number,
    y: number,
) {
    const frame = page.frameLocator("[data-vitest=\"true\"]");
    const box = await frame.locator(selector).boundingBox();
    if (!box) throw new Error(`Cannot find element for pointer down: ${selector}`);
    await page.mouse.move(box.x + x, box.y + y);
    await page.mouse.down();
}

/** Drags the pressed pointer to the given element-relative position. */
async function pointerDragTo(
    { page }: BrowserCommandContext,
    selector: string,
    x: number,
    y: number,
) {
    const frame = page.frameLocator("[data-vitest=\"true\"]");
    const box = await frame.locator(selector).boundingBox();
    if (!box) throw new Error(`Cannot find element for pointer drag: ${selector}`);
    await page.mouse.move(box.x + x, box.y + y, { steps: 5 });
}

/** Releases the pressed pointer. */
async function pointerUp({ page }: BrowserCommandContext) {
    await page.mouse.up();
}

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: "unit",
                    environment: "node",
                    include: ["packages/*/test/**/*.test.ts"],
                },
            },
            {
                resolve: {
                    alias: [{ find: /^@react-av\/([\w-]+)$/, replacement: packageSources }],
                    dedupe: ["react", "react-dom", "@radix-ui/react-slider"],
                },
                test: {
                    name: "e2e",
                    include: ["e2e/**/*.test.{ts,tsx}"],
                    browser: {
                        enabled: true,
                        headless: true,
                        provider: playwright(),
                        instances: [{ browser: "chromium" }, { browser: "webkit" }],
                        commands: {
                            pointerMove,
                            pointerDown,
                            pointerDragTo,
                            pointerUp,
                        },
                    },
                },
            },
        ],
    },
});
