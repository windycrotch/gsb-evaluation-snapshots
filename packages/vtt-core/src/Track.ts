import { addTrack, getContext, init, removeTrack, updateTextTrackDisplay } from "./GlobalState";
import TextTrack from "./TextTrack";
import VTTParser from "./VTTParser";

export interface HTMLTrackElementAttributes {
    kind?: TextTrackKind;
    src: string;
    srclang?: string;
    label?: string;
    default?: boolean;
    id?: string;
}

/**
 * Similar to the HTMLTrackElement, but for use in JS only. (Thus not a DOM element.)
 */
export class Track {
    kind: TextTrackKind;
    src: URL;
    srclang: string;
    label: string;
    default: boolean;
    #track: TextTrack;
    #readyState: number = 0;
    #element: HTMLMediaElement;
    get readyState() {
        return this.#readyState;
    }
    #abortController = new AbortController();
    // Once true, the load session is invalidated: no more cues, regions,
    // cuechange events or readyState transitions may result from it.
    #removed = false;
    get removed() {
        return this.#removed;
    }
    static NONE = 0;
    static LOADING = 1;
    static LOADED = 2;
    static ERROR = 3;
    constructor(element: HTMLMediaElement, attrs: HTMLTrackElementAttributes) {
        this.src = new URL(attrs.src.trim(), location.href);
        // XXX: we don't verify language tag
        this.srclang = attrs.srclang ? attrs.srclang.trim() : "";
        this.label = attrs.label ? attrs.label.trim() : "";
        this.default = !!attrs.default;
        this.#element = element;
        this.#track = new TextTrack(attrs.kind || "subtitles", this.default ? "showing" : "hidden", this.label, this.srclang, attrs.id);
        this.kind = this.#track.kind;
        addTrack(element, this.#track);
        this.#fetch();
    }
    async #fetch() {
        this.#readyState = Track.LOADING;
        try {
            const response = await fetch(this.src.href, {
                signal: this.#abortController.signal,
            });
            const text = await response.text();
            // Parse fully before touching the track, so a parse failure
            // cannot leave half-written cues behind.
            const parser = new VTTParser(text);
            // The track may have been removed while the response was in
            // flight (or an out-of-order response for a stale track may
            // arrive after a replacement track was added). A removed track
            // must not produce any visible effect.
            if (this.#removed) return;
            const context = getContext(this.#element);
            for (const cue of parser.cues) {
                cue.track = this.#track;
                this.#track.addCue(cue);
                context?.newlyIntroducedCues.add(cue);
                context?.tracksChanged.dispatchEvent(new CustomEvent("cuechange", {
                    detail: this.#track
                }))
            }
            for (const region of parser.regions) {
                this.#track._addRegion(region);
            }
            this.#readyState = Track.LOADED;
        } catch (e) {
            // An abort caused by remove() is not a load failure, and a
            // removed track must not transition readyState at all.
            if (this.#removed) return;
            console.error(e);
            this.#readyState = Track.ERROR;
        }
    }
    remove() {
        // Repeated remove() calls are a no-op.
        if (this.#removed) return;
        this.#removed = true;
        if (this.#readyState === Track.LOADING)
            this.#abortController.abort();
        // Clean up cues and regions that were already written.
        const context = getContext(this.#element);
        if (this.#track.cues) {
            for (const cue of [...this.#track.cues]) {
                context?.newlyIntroducedCues.delete(cue);
                this.#track.removeCue(cue);
            }
        }
        for (const region of [...this.#track._regions]) {
            this.#track._removeRegion(region);
        }
        removeTrack(this.#element, this.#track);
    }
}

Object.defineProperty(Track, "NONE", { value: 0, writable: false, enumerable: true, configurable: false });
Object.defineProperty(Track, "LOADING", { value: 1, writable: false, enumerable: true, configurable: false });
Object.defineProperty(Track, "LOADED", { value: 2, writable: false, enumerable: true, configurable: false });
Object.defineProperty(Track, "ERROR", { value: 3, writable: false, enumerable: true, configurable: false });
