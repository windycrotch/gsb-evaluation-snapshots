# Vimeo

The Vimeo engine connects the Vimeo Player API with VisionPlayer’s media API and controls the Vimeo iFrame Element. It mirrors play/pause/seek/loop/volume/mute, playback rate, picture-in-picture, quality and language selection, publishes Media API events, and keeps player state (time, buffered/played ranges, dimensions) in sync. Subtitles are surfaced via the subtitle renderer (VTT).

## Configuration

Configuration example with defaults:

```javascript
const playerConfig = {
    vimeo: {
        lazyLoadLib: true,
        doNotTrack: true
    }
};
```

| Setting Name  | Type    | Description                                                   |
|---------------|---------|---------------------------------------------------------------|
| `lazyLoadLib` | Boolean | If true, loads the Vimeo Player API on engine activation as opposed to the initialisation stage. |
| `doNotTrack`  | Boolean | If true, enables Vimeo's Do Not Track parameter to reduce tracking and cookie usage. Note: Essential cookies (e.g., for security and bot protection) may still be set even when enabled. |

## State

The engine binds the following properties onto `state.media`:

| Property            | Type        | Description                                          |
|---------------------|-------------|------------------------------------------------------|
| `src`               | String      | Current media source URL.                            |
| `videoId`           | String      | Vimeo video id.                                      |
| `duration`          | Number      | Duration in seconds (or `Infinity`).                 |
| `currentTime`       | Number      | Current playhead position.                           |
| `remainingTime`     | Number      | Duration minus current time, or `NaN` if unknown.    |
| `paused`            | Boolean     | Whether playback is paused.                          |
| `ended`             | Boolean     | Whether playback has ended.                          |
| `loop`              | Boolean     | Loop flag controlled via Media API.                  |
| `volume`            | Number      | Volume from 0..1.                                    |
| `muted`             | Boolean     | Mute flag.                                           |
| `playbackRate`      | Number      | Current playback speed.                              |
| `videoWidth`        | Number      | Video width in pixels.                               |
| `videoHeight`       | Number      | Video height in pixels.                              |
| `buffered`          | TimeRanges* | Buffered ranges (single-range shim).                 |
| `played`            | TimeRanges* | Played ranges (single-range shim).                   |
| `pictureInPicture`  | Boolean     | PiP active flag.                                     |

*Shim implements `length`, `start()`, `end()` for index 0.

## API

| Method                          | Arguments                               | Returns                  | Description                                              |
| ------------------------------- | --------------------------------------- | ------------------------ | -------------------------------------------------------- |
| `media.load`                    | `metaData` (Object), `options` (Object) | Promise (media metadata) | Loads a Vimeo source and resolves with current metadata. |
| `media.getMetaData`             | —                                       | Object                   | Returns current metadata (includes `videoId`).           |
| `media.canPlay`                 | `metaData` (Object)                     | `'probably'` or `''`     | Returns `'probably'` if a Vimeo video ID can be extracted. |
| `media.play`                    | —                                       | —                        | Start playback.                                          |
| `media.pause`                   | —                                       | —                        | Pause playback.                                          |
| `media.loop`                    | `doLoop` (Boolean)                      | —                        | Enable/disable looping.                                  |
| `media.playbackRate`            | `rate` (Number)                         | —                        | Set playback speed.                                      |
| `media.seek`                    | `time` (Number)                         | —                        | Seek to time in seconds.                                 |
| `media.volume`                  | `volume` (Number)                       | —                        | Set volume.                                              |
| `media.mute`                    | `mute` (Boolean)                        | —                        | Toggle mute state.                                       |
| `media.getElement`              | —                                       | HTMLElement              | Returns the Vimeo iframe element (or wrapper if not yet mounted). |
| `media.requestPictureInPicture` | —                                       | —                        | Request Picture-in-Picture.                              |
| `media.exitPictureInPicture`    | —                                       | —                        | Exit Picture-in-Picture.                                 |

## Events

### Relayed Vimeo API Events

These standard media events are forwarded from the Vimeo API:

| Event Name         | Payload | Description                                          |
|--------------------------------|-------------------------|----------------------------------------------------------------------|
| `media/loadstart`              | —                       | Browser starts fetching media.                                       |
| `media/ready`                  | metaData                | Vimeo ready; metadata available.                                     |
| `media/loadedmetadata`         | —                       | Metadata (duration/dimensions) loaded.                               |
| `media/loadeddata`             | —                       | First frame loaded.                                                  |
| `media/canplay`                | —                       | Playback can start (may buffer).                                     |
| `media/canplaythrough`         | —                       | Playback can finish without buffering.                               |
| `media/play`                   |                         | Playback has been requested.                       |
| `media/playing`                |                         | Playback has started.                              |
| `media/pause`                  | —                       | Playback paused.                                                     |
| `media/ended`                  | —                       | Playback ended.                                                      |
| `media/waiting`                | —                       | Buffering.                                                           |
| `media/seeked`                 | —                       | Seek completed.                                                      |
| `media/timeupdate`             | —                       | Playhead/time changed.                                               |
| `media/progress`               | —                       | Buffered ranges updated.                                             |
| `media/ratechange`             | —                       | Playback rate changed.                                               |
| `media/volumechange`           | —                       | Volume or mute changed.                                              |
| `media/enterpictureinpicture`  | —                       | Entered PiP.                                                         |
| `media/leavepictureinpicture`  | —                       | Left PiP.                                                            |
| `media/error`                  | error                   | Wrapped Vimeo error.                                                 |
