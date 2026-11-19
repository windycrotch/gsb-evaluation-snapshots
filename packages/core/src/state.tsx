import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

const MediaStoreContext = createContext<MediaStore | null>(null);

export enum MediaReadyState {
    HAVE_NOTHING = 0,
    HAVE_METADATA = 1,
    HAVE_CURRENT_DATA = 2,
    HAVE_FUTURE_DATA = 3,
    HAVE_ENOUGH_DATA = 4,
}

export enum MediaNetworkState {
    NETWORK_EMPTY = 0,
    NETWORK_IDLE = 1,
    NETWORK_LOADING = 2,
    NETWORK_NO_SOURCE = 3,
}

export type StoreListener = () => void;
export type StoreListenerUnsubscribe = () => void;

export interface StateStore<T> {
    getState: () => T;
    getServerSnapshot?: () => T;
    setState: (state: T) => void;
    subscribe: (callback: StoreListener) => StoreListenerUnsubscribe;
}

export function createStateStore<T>(initialState: T): StateStore<T> {
    let state = initialState;
    const listeners = new Set<StoreListener>();

    function getState() {
        return state;
    }

    function setState(newState: T) {
        state = newState;
        listeners.forEach((listener) => listener());
    }

    function subscribe(callback: StoreListener) {
        listeners.add(callback);
        return () => {
            listeners.delete(callback);
        };
    }

    return {
        getState,
        getServerSnapshot: () => initialState,
        setState,
        subscribe,
    };
}

export interface MediaStore {
    mediaElement: StateStore<HTMLMediaElement | null>;
    audioOnly: StateStore<boolean>;
    muted: StateStore<boolean>;
    readyState: StateStore<MediaReadyState>;
    networkState: StateStore<MediaNetworkState>;
    error: StateStore<MediaError | null>;
    ended: StateStore<boolean>;
    buffered: StateStore<TimeRanges | null>;
    seeking: StateStore<boolean>;
    seekable: StateStore<TimeRanges | null>;
    playing: StateStore<boolean>;
    loop: StateStore<boolean>;
    volume: StateStore<number>;
    playbackRate: StateStore<number>;
    duration: StateStore<number>;
    currentTime: StateStore<number>;
    fullscreen: StateStore<boolean>;
    opaque: (key: string) => StateStore<unknown>;
}

function timeRangesCompare(a: TimeRanges, b: TimeRanges) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a.start(i) !== b.start(i) || a.end(i) !== b.end(i)) return false;
    }
    return true;
}

/**
 * Media elements expose `TimeRanges` objects that are backed by live state, and
 * some browsers hand out the same object on every read. Copy the ranges into a
 * plain, immutable snapshot so that change detection and store snapshots stay
 * stable until the media actually reports a different range.
 */
function snapshotTimeRanges(ranges: TimeRanges): TimeRanges {
    const starts: number[] = [];
    const ends: number[] = [];

    for (let i = 0; i < ranges.length; i++) {
        starts.push(ranges.start(i));
        ends.push(ranges.end(i));
    }

    return {
        length: starts.length,
        start: (index: number) => starts[index] ?? 0,
        end: (index: number) => ends[index] ?? 0,
    };
}

function createMutedStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<boolean> {
    const listeners = new Set<StoreListener>();
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('volumechange', handler);
        
        cleanup = () => {
            element.removeEventListener('volumechange', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            return mediaElement.getState()?.muted ?? false;
        },
        setState(muted) {
            const element = mediaElement.getState();
            if (!element) return;
            element.muted = muted;
            listeners.forEach((listener) => listener());
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaReadyStateStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<MediaReadyState> {
    const listeners = new Set<StoreListener>();
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('abort', handler);
        element.addEventListener('canplay', handler);
        element.addEventListener('canplaythrough', handler);
        element.addEventListener('emptied', handler);
        element.addEventListener('error', handler);
        element.addEventListener('loadeddata', handler);
        element.addEventListener('loadedmetadata', handler);
        element.addEventListener('loadstart', handler);
        element.addEventListener('stalled', handler);
        element.addEventListener('suspend', handler);
        element.addEventListener('waiting', handler);
        element.addEventListener('seeking', handler);
        element.addEventListener('seeked', handler);
        element.addEventListener('ended', handler);
        
        cleanup = () => {
            element.removeEventListener('abort', handler);
            element.removeEventListener('canplay', handler);
            element.removeEventListener('canplaythrough', handler);
            element.removeEventListener('emptied', handler);
            element.removeEventListener('error', handler);
            element.removeEventListener('loadeddata', handler);
            element.removeEventListener('loadedmetadata', handler);
            element.removeEventListener('loadstart', handler);
            element.removeEventListener('stalled', handler);
            element.removeEventListener('suspend', handler);
            element.removeEventListener('waiting', handler);
            element.removeEventListener('seeking', handler);
            element.removeEventListener('seeked', handler);
            element.removeEventListener('ended', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return MediaReadyState.HAVE_NOTHING;
            return element.readyState;
        },
        setState() {
            // Do nothing
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaNetworkStateStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<MediaNetworkState> {
    const listeners = new Set<StoreListener>();
    let lastState: MediaNetworkState | null = null;
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            if (!element) return;
            if (element.networkState === lastState) return;
            listeners.forEach((listener) => listener());
            lastState = element.networkState;
        };
        element.addEventListener('loadstart', handler);
        element.addEventListener('suspend', handler);
        element.addEventListener('abort', handler);
        element.addEventListener('error', handler);
        element.addEventListener('emptied', handler);
        element.addEventListener('stalled', handler);
        element.addEventListener('loadedmetadata', handler);
        element.addEventListener('loadeddata', handler);
        element.addEventListener('canplay', handler);
        element.addEventListener('canplaythrough', handler);
        element.addEventListener('waiting', handler);
        element.addEventListener('seeking', handler);
        element.addEventListener('seeked', handler);
        element.addEventListener('ended', handler);
        element.addEventListener('progress', handler);
        
        cleanup = () => {
            element.removeEventListener('loadstart', handler);
            element.removeEventListener('suspend', handler);
            element.removeEventListener('abort', handler);
            element.removeEventListener('error', handler);
            element.removeEventListener('emptied', handler);
            element.removeEventListener('stalled', handler);
            element.removeEventListener('loadedmetadata', handler);
            element.removeEventListener('loadeddata', handler);
            element.removeEventListener('canplay', handler);
            element.removeEventListener('canplaythrough', handler);
            element.removeEventListener('waiting', handler);
            element.removeEventListener('seeking', handler);
            element.removeEventListener('seeked', handler);
            element.removeEventListener('ended', handler);
            element.removeEventListener('progress', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return MediaNetworkState.NETWORK_EMPTY;
            return element.networkState;
        },
        setState() {
            // Do nothing
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaErrorStateStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<MediaError | null> {
    const listeners = new Set<StoreListener>();
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('error', handler);
        
        cleanup = () => {
            element.removeEventListener('error', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return null;
            return element.error;
        },
        setState() {
            // Do nothing
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaEndedStateStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<boolean> {
    const listeners = new Set<StoreListener>();
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('ended', handler);
        element.addEventListener('seeked', handler);
        element.addEventListener('play', handler);
        element.addEventListener('durationchange', handler);
        
        cleanup = () => {
            element.removeEventListener('ended', handler);
            element.removeEventListener('seeked', handler);
            element.removeEventListener('play', handler);
            element.removeEventListener('durationchange', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return false;
            return element.ended;
        },
        setState() {
            // Do nothing
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaBufferedStateStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<TimeRanges | null> {
    const listeners = new Set<StoreListener>();
    let lastRanges: TimeRanges | null = null;
    let cleanup: StoreListenerUnsubscribe = () => {};

    function update() {
        const element = mediaElement.getState();
        if (!element) {
            // The media element was removed: drop its ranges.
            if (lastRanges === null) return;
            lastRanges = null;
            listeners.forEach((listener) => listener());
            return;
        }

        const nextRanges = snapshotTimeRanges(element.buffered);
        const next = nextRanges.length > 0 ? nextRanges : null;
        if (lastRanges === null && next === null) return;
        if (lastRanges && next && timeRangesCompare(next, lastRanges)) return;
        lastRanges = next;
        listeners.forEach((listener) => listener());
    }

    function clearRanges() {
        // Never keep ranges from a previous source around.
        if (lastRanges === null) return;
        lastRanges = null;
        listeners.forEach((listener) => listener());
    }

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) {
            clearRanges();
            return;
        }
        element.addEventListener('progress', update);
        element.addEventListener('loadedmetadata', update);
        element.addEventListener('emptied', clearRanges);
        element.addEventListener('loadstart', clearRanges);

        update();

        cleanup = () => {
            element.removeEventListener('progress', update);
            element.removeEventListener('loadedmetadata', update);
            element.removeEventListener('emptied', clearRanges);
            element.removeEventListener('loadstart', clearRanges);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return null;
            return lastRanges;
        },
        setState() {
            // Do nothing
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

export function createMediaSeekingStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<boolean> {
    const listeners = new Set<StoreListener>();
    let lastSeeking: boolean = false;
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            if (element?.seeking === lastSeeking) return;
            listeners.forEach((listener) => listener());
            lastSeeking = element?.seeking ?? false;
        };
        element.addEventListener('seeking', handler);
        element.addEventListener('seeked', handler);
        
        cleanup = () => {
            element.removeEventListener('seeking', handler);
            element.removeEventListener('seeked', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return false;
            return element.seeking;
        },
        setState() {
            // Do nothing
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

export function createMediaSeekableStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<TimeRanges | null> {
    const listeners = new Set<StoreListener>();
    let lastRanges: TimeRanges | null = null;
    let cleanup: StoreListenerUnsubscribe = () => {};

    function clearRanges() {
        // Seekable ranges belong to the previous source; drop them on a source change.
        if (lastRanges === null) return;
        lastRanges = null;
        listeners.forEach((listener) => listener());
    }

    function detectChanges() {
        cleanup();
        clearRanges();

        const element = mediaElement.getState();
        if (!element) return;
        const media = element;
        function handler () {
            const seekable = media.seekable;
            if (!seekable) return;
            const nextRanges = snapshotTimeRanges(seekable);
            // Publish the first non-empty range set too, so components can enable seeking
            // as soon as the media becomes seekable.
            if (lastRanges && timeRangesCompare(nextRanges, lastRanges)) return;
            if (!lastRanges && nextRanges.length === 0) return;
            lastRanges = nextRanges;
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('seeking', handler);
        element.addEventListener('seeked', handler);
        element.addEventListener('progress', handler);
        element.addEventListener('canplay', handler);
        element.addEventListener('canplaythrough', handler);
        element.addEventListener('loadedmetadata', handler);
        element.addEventListener('durationchange', handler);
        element.addEventListener('emptied', clearRanges);
        element.addEventListener('loadstart', clearRanges);

        // The element may already be seekable when it is registered (for example
        // metadata loaded before the store was created), so publish right away.
        handler();

        cleanup = () => {
            element.removeEventListener('seeking', handler);
            element.removeEventListener('seeked', handler);
            element.removeEventListener('progress', handler);
            element.removeEventListener('canplay', handler);
            element.removeEventListener('canplaythrough', handler);
            element.removeEventListener('loadedmetadata', handler);
            element.removeEventListener('durationchange', handler);
            element.removeEventListener('emptied', clearRanges);
            element.removeEventListener('loadstart', clearRanges);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return null;
            return lastRanges;
        },
        setState() {
            // Do nothing
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaPlayingStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<boolean> {
    const listeners = new Set<StoreListener>();
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('play', handler);
        element.addEventListener('pause', handler);

        cleanup = () => {
            element.removeEventListener('play', handler);
            element.removeEventListener('pause', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return false;
            return !element.paused;
        },
        setState(playing) {
            const element = mediaElement.getState();
            if (!element) return;
            if (playing && element.paused) element.play();
            if (!playing && !element.paused) element.pause();
            listeners.forEach((listener) => listener());
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaLoopStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<boolean> {
    const listeners = new Set<StoreListener>();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return false;
            return element.loop;
        },
        setState(loop) {
            const element = mediaElement.getState();
            if (!element) return;
            element.loop = loop;
            listeners.forEach((listener) => listener());
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaVolumeStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<number> {
    const listeners = new Set<StoreListener>();
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('volumechange', handler);

        cleanup = () => {
            element.removeEventListener('volumechange', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return 1;
            return element.volume;
        },
        setState(volume) {
            const element = mediaElement.getState();
            if (!element) return;
            element.volume = Math.max(0, Math.min(1, volume));
            listeners.forEach((listener) => listener());
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaPlaybackRateStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<number> {
    const listeners = new Set<StoreListener>();
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('ratechange', handler);
        
        cleanup = () => {
            element.removeEventListener('ratechange', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return 1;
            return element.playbackRate;
        },
        setState(rate) {
            const element = mediaElement.getState();
            if (!element) return;
            element.playbackRate = rate;
            listeners.forEach((listener) => listener());
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaDurationStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<number> {
    const listeners = new Set<StoreListener>();
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        cleanup();

        const element = mediaElement.getState();
        if (!element) return;
        function handler () {
            listeners.forEach((listener) => listener());
        };
        element.addEventListener('durationchange', handler);
        
        cleanup = () => {
            element.removeEventListener('durationchange', handler);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState();
            if (!element) return 0;
            if (Number.isNaN(element.duration)) return 0;
            return element.duration;
        },
        setState() {
            // Do nothing
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

function createMediaCurrentTimeStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<number> {
    const listeners = new Set<StoreListener>();
    let currentTime = 0;
    let currentElement: HTMLMediaElement | null = null;
    let cleanup: StoreListenerUnsubscribe = () => {};

    function publish(nextTime: number) {
        if (nextTime === currentTime) return;
        currentTime = nextTime;
        listeners.forEach(listener => listener());
    }

    function update() {
        const element = mediaElement.getState();
        const nextTime = element?.currentTime ?? 0;
        publish(Number.isFinite(nextTime) && !Number.isNaN(nextTime) ? nextTime : 0);
    }

    function reset() {
        // A source change invalidates the previous source's playback position.
        publish(0);
    }

    function detectChanges() {
        cleanup();
        const element = mediaElement.getState();
        // A replaced (or removed) media element is a source change: never let the
        // previous source's playback position leak into the new one.
        if (element !== currentElement) {
            currentElement = element;
            publish(0);
        }
        if (!element) return;
        const events = ['timeupdate', 'seeking', 'seeked', 'loadedmetadata'];
        events.forEach(event => element.addEventListener(event, update));
        element.addEventListener('emptied', reset);
        element.addEventListener('loadstart', reset);
        update();
        cleanup = () => {
            events.forEach(event => element.removeEventListener(event, update));
            element.removeEventListener('emptied', reset);
            element.removeEventListener('loadstart', reset);
        };
    }

    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            return currentTime;
        },
        setState(time) {
            const element = mediaElement.getState();
            if (!element) return;
            if (!Number.isFinite(time) || Number.isNaN(time)) return;

            const duration = element.duration;
            if (Number.isFinite(duration)) {
                element.currentTime = Math.min(Math.max(time, 0), Math.max(duration, 0));
            } else {
                // Live or otherwise unbounded media: clamp to the seekable window
                // instead, so seeking still works once a range is known.
                const seekable = element.seekable;
                if (!seekable || seekable.length === 0) return;
                const start = seekable.start(0);
                const end = seekable.end(seekable.length - 1);
                if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
                element.currentTime = Math.min(Math.max(time, start), end);
            }

            update();
        },
        subscribe(callback) {
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
            }
        },
    }
}

type NativeFullscreenMediaElement = HTMLMediaElement & {
    webkitDisplayingFullscreen?: boolean;
    webkitEnterFullscreen?: () => void;
    webkitExitFullscreen?: () => void;
};

function createMediaFullscreenStore(mediaElement: StateStore<HTMLMediaElement | null>): StateStore<boolean> {
    const listeners = new Set<StoreListener>();
    let cleanup: StoreListenerUnsubscribe = () => {};

    function detectChanges() {
        if (listeners.size === 0) return;
        cleanup();

        const element = mediaElement.getState();
        function handler() {
            listeners.forEach((listener) => listener());
        }

        element?.addEventListener('webkitbeginfullscreen', handler);
        element?.addEventListener('webkitendfullscreen', handler);
        document.addEventListener('fullscreenchange', handler);
        // vendor prefixes for fullscreenchange
        document.addEventListener('webkitfullscreenchange', handler);
        document.addEventListener('mozfullscreenchange', handler);
        document.addEventListener('MSFullscreenChange', handler);

        cleanup = () => {
            element?.removeEventListener('webkitbeginfullscreen', handler);
            element?.removeEventListener('webkitendfullscreen', handler);
            document.removeEventListener('fullscreenchange', handler);
            document.removeEventListener('webkitfullscreenchange', handler);
            document.removeEventListener('mozfullscreenchange', handler);
            document.removeEventListener('MSFullscreenChange', handler);
        };
    }
    
    mediaElement.subscribe(detectChanges);
    detectChanges();

    return {
        getState() {
            const element = mediaElement.getState() as NativeFullscreenMediaElement | null;
            if (!element) return false;
            // @ts-ignore
            const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;

            return element.webkitDisplayingFullscreen === true || fullscreenElement === element.parentElement;
        },
        setState(fullscreen) {
            const element = mediaElement.getState() as NativeFullscreenMediaElement | null;
            if (!element) return;
            if (element.parentElement?.getAttribute('data-media-container') !== 'true') 
                throw new Error('Fullscreen only works if the media element is inside a media container');
            // @ts-ignore
            const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;

            // @ts-ignore
            const enterFullscreen = element.parentElement?.requestFullscreen || element.parentElement?.webkitRequestFullscreen || element.parentElement?.mozRequestFullScreen || element.parentElement?.msRequestFullscreen;
            // @ts-ignore
            const exitFullscreen = document.exitFullscreen || document.webkitCancelFullScreen || document.mozCancelFullScreen || document.msExitFullscreen;

            try {
                if (!fullscreen && element.webkitDisplayingFullscreen) {
                    element.webkitExitFullscreen?.();
                } else if (!fullscreen && fullscreenElement === element.parentElement) {
                    exitFullscreen?.call(document)?.catch(() => { });
                } else if (fullscreen && enterFullscreen) {
                    enterFullscreen.call(element.parentElement)?.catch(() => { });
                } else if (fullscreen) {
                    element.webkitEnterFullscreen?.();
                }
            } catch {
                return;
            }
            
            listeners.forEach((listener) => listener());
        },
        subscribe(callback) {
            listeners.add(callback);
            if (listeners.size === 1) detectChanges();
            return () => {
                listeners.delete(callback);
                if (listeners.size === 0) cleanup();
            }
        },
    }
}

export function createMediaStore(): MediaStore {
    const mediaElement = createStateStore<HTMLMediaElement | null>(null);

    function withMediaSnapshot<T>(store: StateStore<T>): StateStore<T> {
        const snapshot = store.getState();
        return {
            ...store,
            getServerSnapshot: () => snapshot,
            subscribe(callback) {
                const unsubscribeStore = store.subscribe(callback);
                const unsubscribeElement = mediaElement.subscribe(callback);
                return () => {
                    unsubscribeStore();
                    unsubscribeElement();
                };
            },
        };
    }

    const opaqueStores = new Map<string, StateStore<unknown>>();

    return {
        mediaElement,
        audioOnly: {
            getState() {
                return mediaElement.getState()?.tagName === 'AUDIO';
            },
            getServerSnapshot: () => false,
            setState() {
                // Do nothing
            },
            subscribe(callback) {
                return mediaElement.subscribe(callback);
            },
        },
        muted: withMediaSnapshot(createMutedStore(mediaElement)),
        readyState: withMediaSnapshot(createMediaReadyStateStore(mediaElement)),
        networkState: withMediaSnapshot(createMediaNetworkStateStore(mediaElement)),
        error: withMediaSnapshot(createMediaErrorStateStore(mediaElement)),
        ended: withMediaSnapshot(createMediaEndedStateStore(mediaElement)),
        buffered: withMediaSnapshot(createMediaBufferedStateStore(mediaElement)),
        seeking: withMediaSnapshot(createMediaSeekingStore(mediaElement)),
        seekable: withMediaSnapshot(createMediaSeekableStore(mediaElement)),
        playing: withMediaSnapshot(createMediaPlayingStore(mediaElement)),
        loop: withMediaSnapshot(createMediaLoopStore(mediaElement)),
        volume: withMediaSnapshot(createMediaVolumeStore(mediaElement)),
        playbackRate: withMediaSnapshot(createMediaPlaybackRateStore(mediaElement)),
        duration: withMediaSnapshot(createMediaDurationStore(mediaElement)),
        currentTime: withMediaSnapshot(createMediaCurrentTimeStore(mediaElement)),
        fullscreen: withMediaSnapshot(createMediaFullscreenStore(mediaElement)),
        opaque: (key: string) => {
            if (opaqueStores.has(key)) 
                return opaqueStores.get(key)!;

            const store = createStateStore<unknown>(null);
            opaqueStores.set(key, store);

            return store;
        }
    }
}

export function useMediaStore() {
    const store = useContext(MediaStoreContext);
    if (!store) {
        throw new Error('useMediaStore must be used within a MediaStoreProvider');
    }
    return store;
}

export function MediaStoreProvider({ children }: { children: React.ReactNode }) {
    const store = useMemo(() => createMediaStore(), []);
    return <MediaStoreContext.Provider value={store}>{children}</MediaStoreContext.Provider>;
}

export function useStateStoreValue<T>(store: StateStore<T>): T {
    return useSyncExternalStore(store.subscribe, store.getState, store.getServerSnapshot ?? store.getState);
}

export function useStateStore<T>(store: StateStore<T>): readonly [T, (value: T) => void] {
    return [useStateStoreValue(store), store.setState] as const;
}

export function useMediaOpaque(key: string) {
    const store = useMediaStore();

    return useStateStore(store.opaque(key));
}

export function useMediaElement() {
    const store = useMediaStore();
    return useStateStoreValue(store.mediaElement);
}

export function useMediaElementState() {
    const store = useMediaStore();
    return useStateStore(store.mediaElement);
}

export function useMediaAudioOnly() {
    const store = useMediaStore();
    return useStateStoreValue(store.audioOnly);
}

export function useMediaMuted() {
    const store = useMediaStore();
    return useStateStore(store.muted);
}

export function useMediaReadyState() {
    const store = useMediaStore();
    return useStateStoreValue(store.readyState);
}

export function useMediaNetworkState() {
    const store = useMediaStore();
    return useStateStoreValue(store.networkState);
}

export function useMediaError() {
    const store = useMediaStore();
    return useStateStoreValue(store.error);
}

export function useMediaEnded() {
    const store = useMediaStore();
    return useStateStoreValue(store.ended);
}

export function useMediaBuffered() {
    const store = useMediaStore();
    return useStateStoreValue(store.buffered);
}

export function useMediaSeeking() {
    const store = useMediaStore();
    return useStateStoreValue(store.seeking);
}

export function useMediaSeekable() {
    const store = useMediaStore();
    return useStateStoreValue(store.seekable);
}

export function useMediaPlaying() {
    const store = useMediaStore();
    return useStateStore(store.playing);
}

export function useMediaLoop() {
    const store = useMediaStore();
    return useStateStore(store.loop);
}

export function useMediaVolume() {
    const store = useMediaStore();
    return useStateStore(store.volume);
}

export function useMediaPlaybackRate(initialRate?: number) {
    const store = useMediaStore();
    const pendingInitialRate = useRef(initialRate);

    useEffect(() => {
        if (pendingInitialRate.current === undefined) return;

        function applyInitialRate() {
            if (!store.mediaElement.getState() || pendingInitialRate.current === undefined) return;
            store.playbackRate.setState(pendingInitialRate.current);
            pendingInitialRate.current = undefined;
            unsubscribe();
        }

        const unsubscribe = store.mediaElement.subscribe(applyInitialRate);
        applyInitialRate();
        return unsubscribe;
    }, [store]);

    return useStateStore(store.playbackRate);
}

export function useMediaDuration() {
    const store = useMediaStore();
    return useStateStoreValue(store.duration);
}

export function useMediaCurrentTime() {
    const store = useMediaStore();
    return useStateStore(store.currentTime);
}

export function useMediaCurrentTimeFine() {
    const store = useMediaStore();
    const element = useMediaElement();
    const [currentTime, setCurrentTime] = useState(0);
    const [sampledElement, setSampledElement] = useState(element);

    if (sampledElement !== element) {
        // Reset during render so that the first frame with a new element never
        // shows the previous source's time, even before effects run.
        setSampledElement(element);
        setCurrentTime(0);
    }

    useEffect(() => {
        if (!element) return;
        const media = element;
        let handle: number | undefined;

        function updateTime() {
            if (Number.isFinite(media.currentTime))
                setCurrentTime(media.currentTime);
        }

        function tick() {
            updateTime();
            handle = undefined;
            if (!media.paused && !media.ended)
                handle = requestAnimationFrame(tick);
        }

        function handlePlaybackChange() {
            if (handle !== undefined) cancelAnimationFrame(handle);
            tick();
        }

        function handleTimeChange() {
            if (media.paused) updateTime();
        }

        function handleSourceChange() {
            // Drop the old source's time immediately rather than waiting for the
            // next event; otherwise the bar shows the previous clip's position.
            if (handle !== undefined) cancelAnimationFrame(handle);
            handle = undefined;
            setCurrentTime(0);
            if (!media.paused && !media.ended)
                handle = requestAnimationFrame(tick);
        }

        const events = ['play', 'pause', 'ended'];
        events.forEach(event => media.addEventListener(event, handlePlaybackChange));
        const unsubscribe = store.currentTime.subscribe(handleTimeChange);
        media.addEventListener('emptied', handleSourceChange);
        media.addEventListener('loadstart', handleSourceChange);
        handlePlaybackChange();

        return () => {
            if (handle !== undefined) cancelAnimationFrame(handle);
            unsubscribe();
            events.forEach(event => media.removeEventListener(event, handlePlaybackChange));
            media.removeEventListener('emptied', handleSourceChange);
            media.removeEventListener('loadstart', handleSourceChange);
        }
    }, [element, store]);

    return [currentTime, store.currentTime.setState] as const;
}

export function useMediaFullscreen() {
    const store = useMediaStore();
    return useStateStore(store.fullscreen);
}
