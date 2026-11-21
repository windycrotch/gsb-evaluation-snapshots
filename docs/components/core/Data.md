# Data

The `Data` component is responsible for managing, parsing, and validating the media metadata used by the player. It supports single media items as well as complex playlist structures, including multiple quality levels, encodings, subtitle tracks, and overlays. It exposes an API for dynamic switching of streams or media entries, integrates MIME-type and capability checks, and handles fallback scenarios for unplayable or malformed data.

This component ensures that only valid and playable streams are used, while offering flexibility through configuration options such as lenient parsing or skipping invalid entries. Additionally, it dispatches lifecycle events to signal when media is ready, parsed, or in case of errors.

**Note:** this component is **mandatory** and required for normal player operations, so it cannot be switched off.

## Configuration

Configuration example with defaults:

```javascript
const playerConfig = {
    data: {
        skipInvalidItems: false,
        skipInvalidRepresentations: false,
        skipEmptyData: false,
        disablePlayCheck: false,
        lenientPlayCheck: false,
        lenientPlayCheckBlob: true,
        preferredQuality: false,
        preferredLanguage: true
    }
};
```

| Setting Name           | Type            | Description                                                  |
| ---------------------- | --------------- | ------------------------------------------------------------ |
| `skipInvalidItems`     | Boolean         | Ignore (skip) invalid media items rather than throwing an error. |
| `skipInvalidRepresentations`   | Boolean         | Ignore invalid representations instead of throwing errors for them. |
| `skipEmptyData`   | Boolean         | Ignore empty media data (eg is `null` or `undefined`) and do not throw an error. Useful if you want to assign mediaData not immediatly on player instantiation. |
| `disablePlayCheck`     | Boolean         | Skip any play checks and trust the source to be playable. |
| `lenientPlayCheck`     | Boolean         | Check only file extensions, but do not use `canPlay`.    |
| `lenientPlayCheckBlob` | Boolean         | Assume `blob:` URLs are valid without checking.              |
| `preferredQuality`     | Number / String / Boolean | Quality setting that should be preferred when loading new media, or `false` to not set such a preference and use autoselect instead. |
| `preferredLanguage`    | String / Boolean | Language that should be preferred when loading new media, `true` to use the player locale as preferred default or `false` to not set any preference at all. |

## API

The following API functions are added to the player instance to control the component:

| Method                   | Arguments                                                           | Returns                                                  | Description                                                                                                                                            |
|--------------------------|---------------------------------------------------------------------|----------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------|
| `data.getMediaData`      | `selector` (String/Number)                                          | Object                                                   | Returns a specific media item (by index), the full data (`all`), the current stream (`current`) or the active index (`index`).                        |
| `data.setMediaData`      | `mediaData` (Object/String)<br>`index` (Number)                     | Promise (parsed media data)                              | Assigns media data; string inputs are auto-loaded as source or JSON. Rejects with DataError on parse failure.                                          |
| `data.updateMediaData`   | `updateData` (Object), `options` (Object)                           | —                                                        | Merge updates into a media item (`options.index` defaults to current; optional `options.property` for partial updates). Fires `data/update` when updating the current item. |
| `data.setMediaIndex`     | `index` (Number)<br>`options` (Object)                              | Promise (media metadata)                                 | Switches to the media at index, sets the matching engine, and loads it. If `options` are omitted, uses current media state (volume/mute/seek/playbackRate/paused). |
| `data.getPreferredMetaData` | `options` (Object)<br>`media` (Object)                           | Object or `false`                                        | Finds a playable source (respects preferred quality/language defaults); result includes `mediaEngine`/`mediaType` when available.                     |
| `data.error`             | `messageOrKey` (String)<br>`error` (Object)                        | —                                                        | Emits a data/error event with the given message (translate key or text) and optional error details.                                                    |

## Events

### Published own Events

| Event Name     | Payload Properties | Description                                                  |
| -------------- | -------------------- | ------------------------------------------------------------ |
| `data/update`  | Object              | Fired when current media data is updated (merge).            |
| `data/parsed`  | `data`&nbsp;(Object)      | Fired when the full media data has been parsed. Payload contains the full `data` object. |
| `data/ready`   | `mediaItem`&nbsp;(Object) | Fired when a media item has been assigned (but media is not fully loaded yet). Payload contains an object with the currently selected mediaItem |
| `data/error`   | `msgObj`&nbsp;(Object)    | Fired when a data related error occurs (for example a parsing error due to wrong media data format). Payload contains an object with error data. |
| `data/nomedia` |                      | Fired when no usable media data is found.                    |
