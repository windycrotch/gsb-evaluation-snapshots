# SubtitlesUi

The SubtitlesUi component provides the user interface for subtitle selection and font size control. It keeps presentation separated from the subtitle engine and communicates via events. This component displays a menu in the settings popup that allows users to select subtitle tracks and adjust font size (when using custom engine).

## Configuration

Configuration example with defaults:

```javascript
const playerConfig = {
    subtitles: {
        showFontSizeControl: true,
        showPlaceholder: false
    }
};
```

| Setting Name      | Type    | Description                                                  |
| ----------------- | ------- | ------------------------------------------------------------ |
| `showFontSizeControl` | Boolean | If enabled, provides a UI to let the user change the subtitle text size. Only works with custom engine. |
| `showPlaceholder`     | Boolean | If enabled, displays a 'not available' placeholder if no subtitles are available, otherwise completely hides the menu. |

**Note:** This component shares the `subtitles` configuration namespace with the Subtitles component. Settings like `mode`, `fontSize`, etc. are read from the same config and also used by the Subtitles engine component.
