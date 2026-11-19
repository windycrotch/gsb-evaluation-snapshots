---
"@react-av/sliders": patch
---

Keep the progress bar in step with a pointer drag. While dragging, the thumb
follows the pointer instead of media events, and the seek is applied only on
release. The thumb then holds the committed time until the media reports it, so
letting go no longer snaps back to the old time. Buffering that advances mid-drag
no longer interrupts the gesture, and switching the source clears the old time,
buffered ranges and hovered percentage. The bar also enables as soon as a
seekable range first appears for live media with an unbounded duration.
