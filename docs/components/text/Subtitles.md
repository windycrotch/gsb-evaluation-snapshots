# Subtitles

The Subtitles component enables custom and native subtitle rendering with track selection and layout control. It handles dynamic switching, SRT-to-VTT conversion and custom rendering with external renderer registration. Also includes native iOS subtitle support via real `<track>` elements, including fullscreen integration and cross-UI handover.

## Configuration

Configuration example with defaults:

```javascript
const playerConfig = {
    subtitles: {
        mode: 'custom',
        allowHTML: 'none',
        adaptLayout: true,
        fontSize: 'medium',
        showFontSizeControl: true,
        showPlaceholder: false,
        preferredSubtitles: false
    }
};
```

| Setting Name      | Type    | Description                                                  |
| ----------------- | ------- | ------------------------------------------------------------ |
| `mode`            | String  | Either `'custom'` or `'native'`. Defines whether the browser engine or the player's renderer is used. |
| `allowHTML`       | String  | Controls HTML support in subtitles. Values: `'none'`, `'basic'`, `'all'`. |
| `adaptLayout`     | Boolean | Adjusts layout depending on other visible UI elements like controller or title. Only for custom engine. |
| `fontSize`        | String  | Text size setting: `'small'`, `'medium'`, `'big'`.           |
| `showFontSizeControl` | Boolean | Enables UI to let the user change subtitle size. (used by the actual UI)            |
| `showPlaceholder`     | Boolean | If enabled, display a 'not available' placeholder if no subtitles are available, otherwise completely hide the menu. (used by the actual UI) |
| `preferredSubtitles`     | Boolean | If enabled, try to display subtitles: if `true`, use the player locale as default, or use a string as language code and try to match with available subs. |

## Media Data

This component extends the Media Format:

```javascript
const mediaData = {
    // ... other media data ...
    text: [
        {
            type: 'subtitles',
            language: 'de',
            src: '/demo/trailer/text/mediaplayer-trailer.de.vtt',
            default: true
        },
        {
            type: 'subtitles',
            language: 'en',
            src: '/demo/trailer/text/mediaplayer-trailer.en.vtt'
        }
    ]
}
```

| Data Property | Type    | Description                                                  |
| ------------- | ------- | ------------------------------------------------------------ |
| `src`         | String  | URL of the subtitle resource.                                |
| `type`        | String  | Text track type, only types `'subtitles'` and `'captions'` will be handled. |
| `language`    | String  | Language code of the subtitle resource.                      |
| `default`     | Boolean | If `true`, this track is selected by default.                |

## State

The following properties are exposed to the player's global `state.media` object:

| State Name        | Type   | Description                                                  |
| ----------------- | ------ | ------------------------------------------------------------ |
| `activeTextTrack` | Number | Index of the currently active subtitle track, or `-1` if none. |

## Events

### Published own Events:

| Event Name           | Payload Properties                        | Payload Type                                 | Description                                                  |
| -------------------- | ----------------------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| `subtitles/active`   | index<br /> language<br /> src<br />type | Number<br /> String<br />String<br /> String | Fired when a subtitle track becomes active. Payload contains an object with various information like the language or type. |

### Subscribed own Events:

| Event Name         | Payload Properties | Description                                                 |
| ------------------ | ------------------ | ----------------------------------------------------------- |
| `subtitles/update` |                    | Rebuilds the subtitle menu based on available `TextTracks`. |
| `subtitles/selected` | index<br /> language<br /> type | Number<br /> String<br /> String | Fired by SubtitlesUi when a subtitle track is selected. |
| `subtitles/fontsize` | fontSize           | String                                       | Fired by SubtitlesUi when the user changes the subtitle font size. |

## API

### `registerRenderer(renderer)`

Registers a custom renderer object that can handle the actual subtitle layout, like line placement etc.

| Parameter | Type   | Description                                                  |
| --------- | ------ | ------------------------------------------------------------ |
| `renderer` | Object | The renderer object. Must implement an `update(activeCues)` method. |
