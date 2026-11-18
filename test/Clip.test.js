import assert from 'assert';
import './helpers/setup';
import Clip from '../src/Clip';
import { CHUNK_SIZE } from '../src/ClipState';
import Chunk from '../src/Chunk';
import {
  FakeAudioContext,
  FakeLoader,
  flushMicrotasks,
  installFakeAudioContext,
  tickClock,
} from './helpers/fakes';

const CHUNKS_COUNT = 10;
const FILE_SIZE = CHUNKS_COUNT * CHUNK_SIZE;
const CHUNK_DURATION = 1;
const TEST_URL = 'blob:fake-mp3';

// Small, locally fabricated "MP3" chunks. The bytes themselves are never
// decoded (the fake AudioContext stubs decoding), only their fixed duration
// and chunk bookkeeping matter.
const buildChunks = (count) =>
  Array.from({ length: count }, (_, index) => {
    const raw = new Uint8Array(CHUNK_SIZE + 1).fill((index + 1) % 256);
    return new Chunk({ index, raw, duration: CHUNK_DURATION });
  });

const createClip = ({ initialPosition = 0, lastAllowedPosition = 1 } = {}) => {
  const context = installFakeAudioContext(FakeAudioContext);

  const clip = new Clip({
    url: TEST_URL,
    fileSize: FILE_SIZE,
    initialPosition,
    lastAllowedPosition,
    silenceChunks: [],
    useMediaSource: false,
  });

  // Avoid any real network activity: replace the real loader with a stub and
  // pre-populate the clip state with ready local chunks.
  clip._loader = new FakeLoader(CHUNK_DURATION);
  clip._clipState._chunks = buildChunks(CHUNKS_COUNT);
  clip.buffer = () => Promise.resolve();

  return { clip, context };
};

context('Clip', () => {
  let activeClip = null;

  afterEach(() => {
    if (activeClip) {
      activeClip.stop();
      activeClip = null;
    }
  });

  context('pause and resume', () => {
    it('continues from the paused position instead of jumping back to 0', async () => {
      const { clip, context } = createClip();
      activeClip = clip;

      clip.play();
      await flushMicrotasks();
      // Prime the currentTime reading so the session-start bookkeeping
      // (`_lastContextTimeAtStart`) is initialized before time advances.
      assert.equal(clip.currentTime, 0);
      tickClock(context, 0.5);

      const positionBeforePause = clip.currentTime;
      assert.ok(positionBeforePause > 0.4 && positionBeforePause < 0.6);

      clip.pause();
      assert.equal(clip.paused, true);

      // While paused the reported position must not snap back to the start.
      tickClock(context, 1);
      assert.equal(clip.currentTime, positionBeforePause);

      clip.resume();
      await flushMicrotasks();
      assert.equal(clip.paused, false);

      // Right after resuming, before any further clock time passes, the
      // playhead is still exactly at the pause point.
      assert.equal(clip.currentTime, positionBeforePause);

      // Advance half a second of audio-context time. The internal clock must
      // continue from the pause point, not restart at 0: the playhead grows by
      // roughly the elapsed time and never jumps back.
      tickClock(context, 0.5);
      const positionAfterResume = clip.currentTime;
      assert.ok(positionAfterResume > positionBeforePause);
      assert.ok(Math.abs(positionAfterResume - (positionBeforePause + 0.5)) < 1e-9);

      // And another reading keeps accumulating instead of resetting.
      tickClock(context, 0.25);
      const positionLater = clip.currentTime;
      assert.ok(positionLater > positionAfterResume);
    });

    it('does not keep advancing the playhead while paused', async () => {
      const { clip, context } = createClip();
      activeClip = clip;

      clip.play();
      await flushMicrotasks();
      clip.currentTime; // prime session bookkeeping
      tickClock(context, 0.3);
      const position = clip.currentTime;
      assert.ok(position > 0.2 && position < 0.4);

      clip.pause();
      tickClock(context, 5);

      assert.equal(clip.currentTime, position);
    });
  });

  context('setCurrentPosition', () => {
    it('moves the playhead across chunks and restarts the clock at the jump', async () => {
      const { clip, context } = createClip();
      activeClip = clip;

      clip.play();
      await flushMicrotasks();
      clip.currentTime; // prime session bookkeeping
      tickClock(context, 0.5);

      const stopEvents = [];
      clip.on('stop', () => stopEvents.push(true));

      clip.setCurrentPosition(0.5, 1);
      await flushMicrotasks();
      clip.currentTime; // prime the new session's bookkeeping

      assert.equal(clip._initialChunk, 5);
      assert.equal(clip._clipState.chunkIndex, 5);
      assert.equal(clip._playbackProgress, 0);
      assert.equal(clip._bufferingOffset, 0);
      assert.equal(clip.ended, false);
      assert.equal(clip._buffering, false);
      assert.equal(clip._buffered, false);
      assert.ok(stopEvents.length >= 1);

      tickClock(context, 0.5);
      // Offset = 5 chunks * 1s, plus half a second of local progress.
      assert.ok(Math.abs(clip.currentTime - 5.5) < 1e-9);
    });

    it('jumping backward stays at the new (earlier) position', async () => {
      const { clip, context } = createClip();
      activeClip = clip;

      clip.play();
      await flushMicrotasks();
      clip.currentTime;
      tickClock(context, 0.5);
      clip.setCurrentPosition(0.8, 1);
      await flushMicrotasks();
      clip.currentTime;
      tickClock(context, 0.5);
      assert.ok(clip.currentTime > 8);

      clip.setCurrentPosition(0.2, 1);
      await flushMicrotasks();
      clip.currentTime;
      tickClock(context, 0.25);

      assert.equal(clip._initialChunk, 2);
      assert.equal(clip._clipState.chunkIndex, 2);
      assert.ok(clip.currentTime >= 2 && clip.currentTime < 2.5);
    });

    it('updates the allowed boundary together with the playhead', () => {
      const { clip } = createClip();
      activeClip = clip;

      clip.setCurrentPosition(0.5, 0.7);

      assert.equal(clip._clipState.chunkIndex, 5);
      assert.equal(clip._clipState.lastAllowedChunkIndex, 7);
      assert.equal(clip._clipState.chunksBufferingFinished, false);
    });

    it('re-arms buffering when the boundary moves forward past the old finish line', () => {
      const { clip } = createClip();
      activeClip = clip;

      // Finish buffering at a small boundary first.
      clip.setCurrentPosition(0.2, 0.2);
      assert.equal(clip._clipState.chunksBufferingFinished, true);

      // Move the boundary forward, still before EOF: buffering resumes.
      clip.setCurrentPosition(0.2, 0.8);
      assert.equal(clip._clipState.lastAllowedChunkIndex, 8);
      assert.equal(clip._clipState.chunksBufferingFinished, false);
    });

    it('finishes buffering when the new boundary is behind the playhead', () => {
      const { clip } = createClip();
      activeClip = clip;

      clip.setCurrentPosition(0.6, 0.6);

      assert.equal(clip._clipState.chunkIndex, 6);
      assert.equal(clip._clipState.lastAllowedChunkIndex, 6);
      assert.equal(clip._clipState.chunksBufferingFinished, true);
    });

    it('notifies the loader that the playhead jumped so chunks get re-fetched', () => {
      const { clip } = createClip();
      activeClip = clip;

      clip._clipState.on('chunkIndexManuallyChanged', (index) =>
        clip._loader.onManualChunkChange(index)
      );

      clip.setCurrentPosition(0.7, 1);

      assert.deepEqual(clip._loader.rebufferedIndices, [7]);
    });

    it('resets the buffer-change latch so buffering hints fire around the new spot', async () => {
      const { clip, context } = createClip();
      activeClip = clip;

      clip.play();
      await flushMicrotasks();
      tickClock(context, 0.1);
      // Prime the latch.
      clip._onBufferChange(false);
      assert.equal(clip._lastBufferChange, false);

      clip.setCurrentPosition(0.4, 1);

      assert.equal(clip._lastBufferChange, null);
    });
  });

  context('currentTime', () => {
    it('reports 0 before playback starts', () => {
      const { clip } = createClip();
      activeClip = clip;

      assert.equal(clip.currentTime, 0);
    });

    it('never returns a negative position', () => {
      const { clip } = createClip();
      activeClip = clip;

      clip.play();
      assert.ok(clip.currentTime >= 0);
    });
  });
});
