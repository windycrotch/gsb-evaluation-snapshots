/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { createMediaStore } from "../src/state";

type FakeElement = {
    currentTime: number;
    duration: number;
    seeking: boolean;
    buffered: TimeRanges;
    seekable: TimeRanges;
    listeners: Map<string, Set<() => void>>;
    addEventListener: (event: string, handler: () => void) => void;
    removeEventListener: (event: string, handler: () => void) => void;
    dispatch: (event: string) => void;
};

function ranges(list: Array<[number, number]>): TimeRanges {
    return {
        length: list.length,
        start: (index: number) => list[index]![0],
        end: (index: number) => list[index]![1],
    };
}

function createFakeElement(): FakeElement {
    const listeners = new Map<string, Set<() => void>>();
    return {
        currentTime: 0,
        duration: 10,
        seeking: false,
        buffered: ranges([]),
        seekable: ranges([]),
        listeners,
        addEventListener(event, handler) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(handler);
        },
        removeEventListener(event, handler) {
            listeners.get(event)?.delete(handler);
        },
        dispatch(event) {
            listeners.get(event)?.forEach(handler => handler());
        },
    };
}

function attach(element: FakeElement | null): HTMLMediaElement | null {
    return element as unknown as HTMLMediaElement | null;
}

function setup(element: FakeElement) {
    const store = createMediaStore();
    store.mediaElement.setState(attach(element));
    return store;
}

describe("buffered store", () => {
    it("publishes ranges on progress and skips unchanged ranges", () => {
        const element = createFakeElement();
        const store = setup(element);
        let notifications = 0;
        store.buffered.subscribe(() => notifications++);

        expect(store.buffered.getState()).toBeNull();

        element.buffered = ranges([[0, 2]]);
        element.dispatch("progress");
        expect(store.buffered.getState()?.length).toBe(1);
        expect(store.buffered.getState()?.end(0)).toBe(2);
        expect(notifications).toBe(1);

        // Same ranges: no notification.
        element.dispatch("progress");
        expect(notifications).toBe(1);

        element.buffered = ranges([[0, 3.5]]);
        element.dispatch("progress");
        expect(store.buffered.getState()?.end(0)).toBe(3.5);
        expect(notifications).toBe(2);
    });

    it("returns a stable snapshot rather than a live TimeRanges object", () => {
        const element = createFakeElement();
        const store = setup(element);

        element.buffered = ranges([[0, 2]]);
        element.dispatch("progress");
        const snapshot = store.buffered.getState();

        // Mutating the element's ranges must not mutate the published snapshot.
        element.buffered = ranges([[0, 8]]);
        expect(snapshot?.end(0)).toBe(2);
    });

    it("drops ranges when the source is emptied", () => {
        const element = createFakeElement();
        const store = setup(element);

        element.buffered = ranges([[0, 2]]);
        element.dispatch("progress");
        expect(store.buffered.getState()).not.toBeNull();

        element.buffered = ranges([]);
        element.dispatch("emptied");
        expect(store.buffered.getState()).toBeNull();
    });

    it("does not leak the previous element's ranges into a replacement element", () => {
        const first = createFakeElement();
        first.buffered = ranges([[0, 4]]);
        const store = setup(first);
        first.dispatch("progress");
        expect(store.buffered.getState()?.end(0)).toBe(4);

        const second = createFakeElement();
        store.mediaElement.setState(attach(second));
        expect(store.buffered.getState()).toBeNull();

        second.buffered = ranges([[0, 1]]);
        second.dispatch("progress");
        expect(store.buffered.getState()?.end(0)).toBe(1);
    });
});

describe("seekable store", () => {
    it("publishes the first non-empty range set", () => {
        const element = createFakeElement();
        const store = setup(element);
        let notifications = 0;
        store.seekable.subscribe(() => notifications++);

        expect(store.seekable.getState()).toBeNull();

        // Empty ranges are not seekable yet.
        element.dispatch("loadedmetadata");
        expect(store.seekable.getState()).toBeNull();
        expect(notifications).toBe(0);

        element.seekable = ranges([[0, 10]]);
        element.dispatch("loadedmetadata");
        expect(store.seekable.getState()?.end(0)).toBe(10);
        expect(notifications).toBe(1);
    });

    it("publishes ranges that already exist when the element is registered", () => {
        const element = createFakeElement();
        element.seekable = ranges([[0, 7]]);

        const store = createMediaStore();
        store.mediaElement.setState(attach(element));
        expect(store.seekable.getState()?.end(0)).toBe(7);
    });

    it("clears ranges when the element is replaced", () => {
        const first = createFakeElement();
        first.seekable = ranges([[0, 5]]);
        const store = setup(first);
        expect(store.seekable.getState()?.end(0)).toBe(5);

        store.mediaElement.setState(null);
        expect(store.seekable.getState()).toBeNull();
    });
});

describe("current time store", () => {
    it("resets to zero when the media element is replaced", () => {
        const first = createFakeElement();
        first.currentTime = 6;
        const store = setup(first);
        first.dispatch("timeupdate");
        expect(store.currentTime.getState()).toBe(6);

        const second = createFakeElement();
        store.mediaElement.setState(attach(second));
        expect(store.currentTime.getState()).toBe(0);
    });

    it("resets to zero when the current source is emptied", () => {
        const element = createFakeElement();
        const store = setup(element);
        element.currentTime = 4;
        element.dispatch("timeupdate");
        expect(store.currentTime.getState()).toBe(4);

        element.currentTime = 0;
        element.dispatch("emptied");
        expect(store.currentTime.getState()).toBe(0);
    });

    it("seeks within the seekable window when the duration is unbounded", () => {
        const element = createFakeElement();
        element.duration = Infinity;
        element.seekable = ranges([[5, 20]]);
        const store = setup(element);

        store.currentTime.setState(100);
        expect(element.currentTime).toBe(20);

        store.currentTime.setState(1);
        expect(element.currentTime).toBe(5);

        store.currentTime.setState(12);
        expect(element.currentTime).toBe(12);
    });

    it("ignores seeks before a seekable window is known for unbounded media", () => {
        const element = createFakeElement();
        element.duration = Infinity;
        element.seekable = ranges([]);
        const store = setup(element);

        store.currentTime.setState(3);
        expect(element.currentTime).toBe(0);
    });
});
