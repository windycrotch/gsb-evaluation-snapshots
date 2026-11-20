import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Track } from "../src/Track";
import { deinit, getContext, init } from "../src/GlobalState";
import TextTrack from "../src/TextTrack";

const VTT_WITH_REGION = `WEBVTT

REGION
id:fred
width:40%

00:00.000 --> 00:01.000 region:fred
Hello

00:01.000 --> 00:02.000
World
`;

const VTT_NEW = `WEBVTT

00:00.000 --> 00:01.000
New track cue
`;

const VTT_OLD = `WEBVTT

00:00.000 --> 00:01.000
Old track cue
`;

const INVALID = "this is not a webvtt file";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

type FetchHandler = (url: string, signal: AbortSignal) => Promise<string>;

function stubFetch(handler: FetchHandler) {
    vi.stubGlobal("fetch", (url: string | URL, options?: { signal?: AbortSignal }) =>
        handler(String(url), options!.signal!).then(text => ({
            text: () => Promise.resolve(text),
        }))
    );
}

/** A fetch that stays pending until its request is aborted. */
function fetchUntilAbort() {
    stubFetch(
        (_url, signal) =>
            new Promise<string>((_resolve, reject) => {
                signal.addEventListener("abort", () =>
                    reject(new DOMException("The operation was aborted.", "AbortError"))
                );
            })
    );
}

async function flush() {
    // Let queued microtasks (fetch/parse continuations) settle.
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
}

describe("Track", () => {
    let element: HTMLMediaElement;
    let cuechangeCount: number;

    function tracks() {
        return getContext(element)!.tracks;
    }

    beforeEach(() => {
        element = {} as HTMLMediaElement;
        init(element);
        cuechangeCount = 0;
        getContext(element)!.tracksChanged.addEventListener("cuechange", () => cuechangeCount++);
        vi.stubGlobal("location", { href: "https://example.com/" });
    });

    afterEach(() => {
        deinit(element);
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("loads cues and regions, dispatches one cuechange per cue, and ends LOADED", async () => {
        stubFetch(() => Promise.resolve(VTT_WITH_REGION));
        const track = new Track(element, { src: "/subs.vtt" });

        await vi.waitFor(() => expect(track.readyState).toBe(Track.LOADED));

        expect(tracks()).toHaveLength(1);
        const textTrack = tracks()[0];
        expect(textTrack.cues).toHaveLength(2);
        expect(textTrack._regions).toHaveLength(1);
        expect(cuechangeCount).toBe(2);
    });

    it("remove() while loading: abort is not a failure, nothing is written, readyState never reaches LOADED", async () => {
        fetchUntilAbort();
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const track = new Track(element, { src: "/subs.vtt" });
        expect(track.readyState).toBe(Track.LOADING);

        track.remove();
        await flush();

        expect(tracks()).toHaveLength(0);
        expect(cuechangeCount).toBe(0);
        // Aborted mid-load: neither LOADED nor ERROR.
        expect(track.readyState).not.toBe(Track.LOADED);
        expect(track.readyState).not.toBe(Track.ERROR);
        expect(consoleError).not.toHaveBeenCalled();
    });

    it("discards a stale response that arrives after the track was replaced (out-of-order, same src)", async () => {
        const first = deferred<string>();
        const second = deferred<string>();
        // The first request ignores abort and resolves late, simulating a
        // response that was already in flight when the track was removed.
        let call = 0;
        stubFetch(() => (++call === 1 ? first.promise : second.promise));

        const oldTrack = new Track(element, { src: "/subs.vtt" });
        oldTrack.remove();
        const newTrack = new Track(element, { src: "/subs.vtt" });

        // The replacement track's response arrives first.
        second.resolve(VTT_NEW);
        await vi.waitFor(() => expect(newTrack.readyState).toBe(Track.LOADED));

        // The stale response arrives afterwards and must be discarded.
        first.resolve(VTT_OLD);
        await flush();

        expect(tracks()).toHaveLength(1);
        const visible = tracks()[0];
        expect(visible.cues).toHaveLength(1);
        expect(visible.cues![0].text).toBe("New track cue");
        expect(cuechangeCount).toBe(1);
        expect(oldTrack.readyState).not.toBe(Track.LOADED);
        expect(newTrack.readyState).toBe(Track.LOADED);
    });

    it("marks ERROR on invalid content without leaving partial cues or regions", async () => {
        stubFetch(() => Promise.resolve(INVALID));
        vi.spyOn(console, "error").mockImplementation(() => {});
        const track = new Track(element, { src: "/subs.vtt" });

        await vi.waitFor(() => expect(track.readyState).toBe(Track.ERROR));

        expect(tracks()).toHaveLength(1);
        expect(tracks()[0].cues ?? []).toHaveLength(0);
        expect(tracks()[0]._regions).toHaveLength(0);
        expect(cuechangeCount).toBe(0);
    });

    it("remove() after a successful load cleans up written cues and regions", async () => {
        stubFetch(() => Promise.resolve(VTT_WITH_REGION));
        const track = new Track(element, { src: "/subs.vtt" });
        await vi.waitFor(() => expect(track.readyState).toBe(Track.LOADED));
        const textTrack = tracks()[0] as TextTrack;
        expect(textTrack.cues).toHaveLength(2);
        expect(textTrack._regions).toHaveLength(1);

        track.remove();

        expect(textTrack.cues ?? []).toHaveLength(0);
        expect(textTrack._regions).toHaveLength(0);
        expect(tracks()).toHaveLength(0);
        // Removal itself must not introduce new cuechange events.
        expect(cuechangeCount).toBe(2);
    });

    it("repeated remove() does not throw and cleans up only once", async () => {
        stubFetch(() => Promise.resolve(VTT_WITH_REGION));
        const track = new Track(element, { src: "/subs.vtt" });
        await vi.waitFor(() => expect(track.readyState).toBe(Track.LOADED));
        const removeCue = vi.spyOn(TextTrack.prototype, "removeCue");
        const removeRegion = vi.spyOn(TextTrack.prototype, "_removeRegion");

        expect(() => {
            track.remove();
            track.remove();
        }).not.toThrow();

        expect(removeCue).toHaveBeenCalledTimes(2);
        expect(removeRegion).toHaveBeenCalledTimes(1);
        expect(tracks()).toHaveLength(0);
    });
});
