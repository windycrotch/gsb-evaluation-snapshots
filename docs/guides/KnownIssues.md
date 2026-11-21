# Known Issues

Following is a list of known issues with VisionPlayer. Most of them are limitations due to browser restrictions or bugs. If you find a new issue or know a workaround for an existing issue, please report it to the [issue tracker](https://github.com/alphanull/visionplayer/issues).

- When using system wide media controls in conjunction with the MediaSession component, next / previous buttons are disabled when using the YouTube or Vimeo engines (for unknown reasons) even if the media item is part of a playlist

- If you have active developer tools in your browser, using the YouTube provider may result in a uncaught exception activating the debugger. This is a known problem with the Youtube iFrame API and cannot be resolved, but despite the exception the player still works fine.

- For switching to Picture in Picture mode in the Vimeo provider, you need to click in the video area first to "activate" the iframe, or else PiP mode will be rejected.

- Sharpen Video Filter does not work on Safari - see [https://bugs.webkit.org](https://bugs.webkit.org/show_bug.cgi?id=184601). Not solvable unless Apple gets its act together - and it is generally recommended to use a "proper" browser anyways, like Firefox or Chrome.

- If the ambient visualizer is enabled (as in the demo), you may get the warning *Canvas2D: Multiple readback operations using getImageData are faster with the willReadFrequently attribute set to true.* Actually, with that setting enabled, performance gets **worse** (up to five times!) on both a windows and a mac laptop. However, an Android tablet showed better performance with this setting, while an iPad did not show much difference. Not sure why exactly this is the case - seems like different rendering pipelines are triggered - and what would be the best heuristics to select the optimal setting. So for now, `willReadFrequently` is disabled until the situation is resolved.
