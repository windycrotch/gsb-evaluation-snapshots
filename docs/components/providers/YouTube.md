# YouTube

The YouTube engine plugs the IFrame API into VisionPlayer’s media API and controls the YouTube iFrame element. It exposes the standard Media API controls (load/play/pause/seek/loop/volume/mute/playbackRate) and mirrors state (time, buffered/played ranges, dimensions, live flag) so the rest of the player can treat YouTube like any other engine.

## Configuration

Configuration example with defaults:

```javascript
const playerConfig = {
    youtube: {
        lazyLoadLib: true,
        noCookie: false
    }
};
```

| Setting Name  | Type    | Description                                                     |
|---------------|---------|-----------------------------------------------------------------|
| `lazyLoadLib` | Boolean | If true, loads the YouTube Player API on engine activation as opposed to the earlier initialisation stage. |
| `noCookie`    | Boolean | If true, uses YouTube's no-cookie domain (youtube-nocookie.com) for the player iframe. Note: The API script itself must still be loaded from youtube.com. This reduces but does not eliminate cookies, and does not provide full GDPR compliance. Some browser console warnings from YouTube's scripts are normal and cannot be suppressed. |

## State

The engine binds the following properties onto `state.media`:

| Property        | Type        | Description                                          |
|-----------------|-------------|------------------------------------------------------|
| `src`           | String      | Current media source URL.                            |
| `duration`      | Number      | Duration in seconds (or `Infinity` for live).        |
| `currentTime`   | Number      | Current playhead position.                           |
| `remainingTime` | Number      | Duration minus current time, or `NaN` if unknown.    |
| `paused`        | Boolean     | Whether playback is paused.                          |
| `ended`         | Boolean     | Whether playback has ended.                          |
| `loop`          | Boolean     | Loop flag controlled via Media API.                  |
| `volume`        | Number      | Volume from 0..1 (mapped to YouTube 0..100).         |
| `muted`         | Boolean     | Mute flag.                                           |
| `playbackRate`  | Number      | Current playback speed.                              |
| `videoWidth`    | Number      | Video width in pixels.                               |
| `videoHeight`   | Number      | Video height in pixels.                              |
| `buffered`      | TimeRanges* | Buffered ranges (single-range shim).                 |
| `played`        | TimeRanges* | Played ranges (single-range shim).                   |
| `liveStream`    | Boolean     | True when stream is live/has no finite duration.     |

*Shim implements `length`, `start()`, `end()` for index 0.

## API

| Method                | Arguments                           | Returns                    | Description                                                            |
| --------------------- | ----------------------------------- | -------------------------- | ---------------------------------------------------------------------- |
| `media.load`          | `metaData` (Object), `options` (Object) | Promise (media metadata)   | Loads a YouTube source and resolves with current metadata.             |
| `media.getMetaData`   | —                                   | Object                     | Returns current metadata.                                              |
| `media.canPlay`       | `metaData` (Object)                  | `'probably'` or `''`       | Returns `'probably'` if a YouTube video ID can be extracted.           |
| `media.play`          | —                                   | —                          | Start playback.                                                        |
| `media.pause`         | —                                   | —                          | Pause playback.                                                        |
| `media.loop`          | `doLoop` (Boolean)                  | —                          | Enable/disable looping (handled in state change).                      |
| `media.playbackRate`  | `rate` (Number)                     | —                          | Set playback speed.                                                    |
| `media.seek`          | `time` (Number)                     | —                          | Seek to time in seconds.                                               |
| `media.volume`        | `volume` (Number)                   | —                          | Set volume (0..1, mapped to YouTube 0..100).                           |
| `media.mute`          | `mute` (Boolean)                    | —                          | Toggle mute state.                                                     |
| `media.getElement`    | —                                   | HTMLElement                | Returns the iframe container.                       |

## Events

### Relayed YouTube embed API Events

These standard media events are forwarded from the YouTube embed API:

| Event Name         | Payload | Description                                 |
|------------------------|----------|----------------------------------------------------|
| `media/loadstart`      | —        | Browser starts fetching media.                     |
| `media/ready`          | metaData | YouTube ready; metadata available.                 |
| `media/loadedmetadata` | —        | Metadata (duration/dimensions) loaded.             |
| `media/loadeddata`     | —        | First frame loaded.                                |
| `media/canplay`        | —        | Playback can start (may buffer).                   |
| `media/canplaythrough` | —        | Playback can finish without buffering.             |
| `media/play`           |          | Playback has been requested.                       |
| `media/playing`        |          | Playback has started.                              |
| `media/pause`          | —        | Playback paused.                                   |
| `media/ended`          | —        | Playback ended.                                    |
| `media/waiting`        | —        | Buffering.                                         |
| `media/seeked`         | —        | Seek completed.                                    |
| `media/timeupdate`     | —        | Playhead/time changed.                             |
| `media/progress`       | —        | Buffered ranges updated.                           |
| `media/ratechange`     | —        | Playback rate changed.                             |
| `media/volumechange`   | —        | Volume or mute changed.                            |
| `media/error`          | error    | Wrapped YouTube error.                             |
