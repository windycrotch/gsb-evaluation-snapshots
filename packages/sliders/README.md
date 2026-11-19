# React AV Sliders

This package contains progress and volume slider components based of Radix UI's slider component for use with React AV.

## Installation

```bash
npm i @react-av/core @radix-ui/react-slider @react-av/sliders
yarn add @react-av/core @radix-ui/react-slider @react-av/sliders
pnpm i @react-av/core @radix-ui/react-slider @react-av/sliders
```

## Usage

See the [documentation](https://react-av.wykerd.dev) for more information.

`ProgressBarRoot` disables seeking until the media exposes a finite, positive
duration, or — for live media with an unbounded duration — a non-empty seekable
range. Keep its track mounted while loading so the control retains its layout.

While the pointer drags the bar the thumb follows the drag, and media events do
not move it. The seek is applied once, on release; the thumb keeps the committed
time until the media reports it and then follows the media clock again. Buffered
ranges can advance mid-drag without interrupting the gesture, and switching the
source (`emptied`/`loadstart`, or a replaced media element) clears the old time,
buffered ranges and hovered percentage.

Arrow keys seek one second or adjust volume by five percentage points.
`keyboardStep` customizes these increments independently of pointer precision.
`step` controls pointer precision, defaulting to `0.001` seconds for seeking and
`0.0001` for volume. Shift+Arrow and Page Up/Down use ten keyboard increments;
Home and End move to the limits. Right-to-left and inverted directions are respected.
