/**
 * The MediaSession component bridges VisionPlayer with the browser Media Session API.
 * It populates the session metadata (title and artwork) as soon as media data is ready
 * and wires chapter data to next/previous track actions when available.
 * @exports module:src/controller/MediaSession
 * @author   Frank Kudermann - alphanull
 * @version  1.0.0
 * @license  MIT
 */
export default class MediaSession {

    /**
     * Reference to the main player instance.
     * @type {module:src/core/Player}
     */
    #player;

    /**
     * Holds tokens of subscriptions to player events, for later unsubscribe.
     * @type {number[]}
     */
    #subscriptions;

    /**
     * Reference to the current MediaSession instance.
     * @type {MediaSession}
     */
    #mediaSession;

    /**
     * Normalized list of chapters for quick lookup.
     * @type {module:src/core/Data~mediaItem_chapter[]}
     */
    #chapters = [];

    /**
     * Creates an instance of the MediaSession component.
     * @param {module:src/core/Player} player  Reference to the VisionPlayer instance.
     */
    constructor(player) {

        if (typeof navigator === 'undefined' || !navigator.mediaSession) return [false];
        if (!player.initConfig('mediaSession', true)) return [false];

        this.#player = player;

        this.#subscriptions = [
            ['data/ready', this.#onDataUpdate],
            ['data/update', this.#onDataUpdate],
            ['data/nomedia', this.#resetMetadata],
            ['media/ready', this.#onTimeUpdate],
            ['media/play', () => this.#updatePlaybackState('playing')],
            ['media/pause', () => this.#updatePlaybackState('paused')],
            ['media/ended', () => this.#updatePlaybackState('paused')],
            ['media/timeupdate', this.#onTimeUpdate]
        ].map(([event, handler]) => this.#player.subscribe(event, handler));

        if (!navigator.mediaSession) return;

        this.#mediaSession = navigator.mediaSession;
        try { this.#mediaSession.setActionHandler('play', this.#onPlayAction); } catch {}
        try { this.#mediaSession.setActionHandler('pause', this.#onPauseAction); } catch {}
        try { this.#mediaSession.setActionHandler('seekto', this.#onSeekTo); } catch {}
        try { this.#mediaSession.setActionHandler('previoustrack', this.#onPreviousPlaylist); } catch {}
        try { this.#mediaSession.setActionHandler('nexttrack', this.#onNextPlaylist); } catch {}
        try { this.#mediaSession.setActionHandler('seekbackward', this.#onPreviousChapter); } catch {}
        try { this.#mediaSession.setActionHandler('seekforward', this.#onNextChapter); } catch {}

    }

    /**
     * Central handler to (re)apply metadata and chapter state.
     * Accepts full media objects or partial data/update fragments.
     * @param   {Object} [update={}]  Full media item or partial update fragment.
     * @returns {void}
     */
    #onDataUpdate = (update = {}) => {

        const baseMedia = this.#player?.data?.getMediaData ? this.#player.data.getMediaData() : {},
              mediaItem = { ...baseMedia, ...update },
              chapters = Array.isArray(mediaItem?.chapters) && mediaItem.chapters.length
                  ? [...mediaItem.chapters].filter(({ start }) => typeof start === 'number').sort((a, b) => a.start - b.start)
                  : [];

        this.#chapters = chapters;

        if (!this.#mediaSession || typeof window?.MediaMetadata === 'undefined') return;

        const lang = this.#player.getConfig('locale.lang'),
              resolve = data => (typeof data === 'object' ? data?.[lang] ?? Object.values(data)[0] : data),
              title = resolve(mediaItem?.title) || '',
              artist = resolve(mediaItem?.titleSecondary) || '',
              overlays = mediaItem?.overlays,
              poster = mediaItem?.poster,
              overlayPoster = Array.isArray(overlays)
                  ? overlays.find(({ type, show }) => {
                      const isPoster = type === 'poster' || type === 'poster-end';
                      const isImage = type === 'image' && (!show || show === 'start' || show === 'always');
                      return isPoster || isImage;
                  })?.src
                  : null,
              artworkSrc = poster || overlayPoster,
              chapterInfo = this.#chapters.map(({ title: chTitle, start }) => ({
                  title: typeof chTitle === 'object' ? chTitle[lang] ?? Object.values(chTitle)[0] : chTitle,
                  startTime: start
              }));

        if (!title && !artworkSrc) this.#resetMetadata(); else {
            try {
                this.#mediaSession.metadata = new window.MediaMetadata({
                    title: title || '',
                    artist,
                    artwork: artworkSrc ? [{ src: artworkSrc }] : [],
                    chapterInfo
                });
            } catch {} // best-effort only
        }

    };

    /**
     * Clears session metadata.
     * @listens module:src/core/Data#data/nomedia
     */
    #resetMetadata = () => {

        if (!this.#mediaSession) return;
        try { this.#mediaSession.metadata = null; } catch {}
        this.#chapters = [];

    };

    /**
     * Handler for "next track" action: advances playlist.
     */
    #onNextPlaylist = () => {

        const index = this.#player.data.getMediaData('index'),
              all = this.#player.data.getMediaData('all'),
              length = Array.isArray(all?.media) ? all.media.length : 0;

        if (length > 1 && index < length - 1) this.#player.data.setMediaIndex(index + 1).catch(() => {});

    };

    /**
     * Handler for "previous track" action: moves playlist backward.
     */
    #onPreviousPlaylist = () => {

        const index = this.#player.data.getMediaData('index'),
              all = this.#player.data.getMediaData('all'),
              length = Array.isArray(all?.media) ? all.media.length : 0;

        if (length > 1 && index > 0) this.#player.data.setMediaIndex(index - 1).catch(() => {});

    };

    /**
     * Handler for "play" action via Media Session.
     */
    #onPlayAction = () => {

        try { this.#player.media.play(); } catch {}

    };

    /**
     * Handler for "pause" action via Media Session.
     */
    #onPauseAction = () => {

        try { this.#player.media.pause(); } catch {}

    };

    /**
     * Sets mediaSession playbackState if available.
     * @param {'none'|'paused'|'playing'} state  Playback state.
     * @listens module:src/core/Media#media/play
     * @listens module:src/core/Media#media/pause
     * @listens module:src/core/Media#media/ended
     */
    #updatePlaybackState = state => {

        try { if (this.#mediaSession) this.#mediaSession.playbackState = state; } catch {}

    };

    /**
     * Handler for "seekto" action via Media Session.
     * @param {Object} [details]  Seek details provided by Media Session.
     */
    #onSeekTo = details => {

        if (this.#player.getState('media.liveStream') === true) return;
        const { seekTime } = details || {};
        if (typeof seekTime !== 'number' || Number.isNaN(seekTime)) return;
        try { this.#player.media.seek(seekTime); } catch {}

    };

    /**
     * Updates mediaSession position state if supported; skipped for live.
     * @listens module:src/core/Media#media/timeupdate
     */
    #onTimeUpdate = () => {

        if (!navigator.mediaSession?.setPositionState) return;

        const live = this.#player.getState('media.liveStream'),
              duration = this.#player.getState('media.duration') ?? 0,
              position = this.#player.getState('media.currentTime') ?? 0,
              rate = this.#player.getState('media.playbackRate') ?? 1;

        try {
            navigator.mediaSession.setPositionState({
                duration: live ? 0 : duration,
                position: live ? 0 : position,
                playbackRate: rate
            });
        } catch {}

    };

    /**
     * Handler for "seek forward" action, mapped to next chapter.
     */
    #onNextChapter = () => {

        if (!this.#chapters.length) return;

        const current = this.#player.getState('media.currentTime'),
              chapterIndex = this.#getChapterIndex(current);

        if (chapterIndex < this.#chapters.length - 1) {
            this.#seekToChapter(chapterIndex + 1);
        }

    };

    /**
     * Handler for "seek backward" action, mapped to chapter rewind.
     */
    #onPreviousChapter = () => {

        if (!this.#chapters.length) return;

        const current = this.#player.getState('media.currentTime'),
              chapterIndex = this.#getChapterIndex(current),
              currentStart = this.#chapters[chapterIndex]?.start ?? 0,
              targetIndex = currentStart > current - 2 ? chapterIndex - 1 : chapterIndex;

        this.#seekToChapter(targetIndex < 0 ? 0 : targetIndex);

    };

    /**
     * Finds the active chapter index for the given playback time.
     * @param   {number} time  Current playback time in seconds.
     * @returns {number}       Chapter index.
     */
    #getChapterIndex = time => {

        let index = 0;
        for (let i = 0; i < this.#chapters.length; i += 1) {
            if (this.#chapters[i].start <= time) index = i;
            else break;
        }
        return index;

    };

    /**
     * Seeks the media element to a chapter start time.
     * @param {number} index  Chapter index to seek to.
     */
    #seekToChapter = index => {

        const chapter = this.#chapters[index];
        if (!chapter) return;
        this.#player.media.seek(chapter.start);

    };

    /**
     * This method removes all events, subscriptions and DOM nodes created by this component.
     */
    destroy() {

        this.#resetMetadata();
        this.#player.unsubscribe(this.#subscriptions);

        if (this.#mediaSession?.setActionHandler) {
            ['play', 'pause', 'seekto', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward'].forEach(action => {
                try { this.#mediaSession.setActionHandler(action, null); } catch {}
            });
        }

        this.#player = this.#mediaSession = null;
        this.#subscriptions = null;

    }
}
