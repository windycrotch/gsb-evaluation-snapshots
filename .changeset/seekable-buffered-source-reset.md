---
"@react-av/core": patch
---

Publish the first seekable range as soon as the media becomes seekable and clear
buffered and seekable ranges when the source changes or the media element is
replaced. Ranges are returned as stable snapshots instead of live `TimeRanges`
objects, and the current time resets to `0` on a source change. Seeking also
works for unbounded media by clamping to the seekable window.
