---
"@react-av/vtt-core": patch
---

Attach WebVTT voice (`<v>`) objects to the cue text node tree so speaker annotations and their contents render through `getCueAsHTML`, and load the cue custom elements (`vtt-cue-root`, `vtt-cue-bgbox`, `vtt-region`) in the DOM renderer instead of importing the track container module twice.
