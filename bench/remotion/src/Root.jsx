import React, { useLayoutEffect, useRef } from 'react';
import { AbsoluteFill, Composition, useCurrentFrame, useVideoConfig } from 'remotion';
import BENCH from '../../shared.js';

// The same scene as HTML elements, each moved from the frame's time.
const Dom = () => {
  const frame = useCurrentFrame(), { fps } = useVideoConfig(), ref = useRef(null), els = useRef(null);
  useLayoutEffect(() => { if (!els.current) els.current = BENCH.dom(ref.current); BENCH.applyDom(els.current, frame / fps); }, [frame, fps]);
  return <AbsoluteFill><div ref={ref} /></AbsoluteFill>;
};

// The same scene drawn on a canvas with the code motlab uses.
const Canvas = () => {
  const frame = useCurrentFrame(), { fps } = useVideoConfig(), ref = useRef(null);
  useLayoutEffect(() => { BENCH.drawCanvas(ref.current.getContext('2d'), frame / fps); }, [frame, fps]);
  return <canvas ref={ref} width={BENCH.W} height={BENCH.H} />;
};

export const Root = () => (
  <>
    <Composition id="Dom" component={Dom} durationInFrames={BENCH.TOTAL * 30} fps={30} width={BENCH.W} height={BENCH.H} />
    <Composition id="Canvas" component={Canvas} durationInFrames={BENCH.TOTAL * 30} fps={30} width={BENCH.W} height={BENCH.H} />
  </>
);
