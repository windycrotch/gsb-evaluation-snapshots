# MediaSession

The MediaSession Component bridges VisionPlayer to the browser Media Session API. It publishes metadata (title, secondary title, artwork, chapters) and wires transport actions (play/pause/seek, previous/next track, chapter seek) to the player so system media controls work consistently across engines (native, HLS/DASH, YouTube/Vimeo).

## Configuration

Configuration example with defaults:

```javascript
const playerConfig = {
    mediaSession: true
};
```

| Setting Name     | Type    | Description                                 |
|------------------|---------|---------------------------------------------|
| `mediaSession`    | Boolean | Enables or disables this component. |
