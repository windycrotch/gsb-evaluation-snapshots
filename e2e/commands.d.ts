/**
 * Types for the pointer-gesture commands registered in `vitest.config.mts`.
 * Radix's slider needs real pointer events that the built-in `userEvent` helpers
 * cannot produce against a slider track (the thumb captures the pointer).
 */
declare module "vitest/internal/browser" {
    interface BrowserCommands {
        /** Moves the pointer over an element's box without pressing. */
        pointerMove: (selector: string, x: number, y: number) => Promise<void>;
        /** Presses the pointer inside an element's box. */
        pointerDown: (selector: string, x: number, y: number) => Promise<void>;
        /** Drags the pressed pointer to a position inside an element's box. */
        pointerDragTo: (selector: string, x: number, y: number) => Promise<void>;
        /** Releases the pressed pointer. */
        pointerUp: () => Promise<void>;
    }
}
