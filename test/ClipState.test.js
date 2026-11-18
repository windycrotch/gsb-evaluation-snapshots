import assert from 'assert';
import './helpers/setup';
import ClipState, { CHUNK_SIZE } from '../src/ClipState';

// A tiny "file" split into a deterministic number of fixed-size chunks so we
// can reason about positions without touching the network.
const CHUNKS_COUNT = 10;
const FILE_SIZE = CHUNKS_COUNT * CHUNK_SIZE;

const readyChunk = (index) => ({ index, duration: 1 });

context('ClipState', () => {
  let clipState;

  beforeEach(() => {
    clipState = new ClipState(FILE_SIZE, 0, 1);
  });

  context('#seek', () => {
    it('updates the playhead, the allowed boundary and the finished flag together', () => {
      clipState.seek(0.5, 0.8);

      assert.equal(clipState.chunkIndex, 5);
      assert.equal(clipState.lastAllowedChunkIndex, 8);
      assert.equal(clipState.chunksBufferingFinished, false);
    });

    it('marks buffering as finished when the new playhead reaches the allowed boundary', () => {
      clipState.seek(0.5, 0.5);

      assert.equal(clipState.chunkIndex, 5);
      assert.equal(clipState.lastAllowedChunkIndex, 5);
      assert.equal(clipState.chunksBufferingFinished, true);
    });

    it('marks buffering as finished when seeking to the end of the file', () => {
      clipState.seek(1, 1);

      assert.equal(clipState.chunkIndex, 9);
      assert.equal(clipState.lastAllowedChunkIndex, 9);
      assert.equal(clipState.chunksBufferingFinished, true);
    });

    it('clamps positions past the end to the last chunk', () => {
      clipState.seek(2, 1);

      assert.equal(clipState.chunkIndex, 9);
      assert.equal(clipState.chunksBufferingFinished, true);
    });

    it('starts at the first chunk for a position of 0', () => {
      clipState.seek(0, 1);

      assert.equal(clipState.chunkIndex, 0);
      assert.equal(clipState.chunksBufferingFinished, false);
    });

    it('notifies listeners when the playhead jumps across chunks', () => {
      const manualChanges = [];
      clipState.on('chunkIndexManuallyChanged', (index) => manualChanges.push(index));

      clipState.seek(0.7, 1);

      assert.deepEqual(manualChanges, [7]);
      assert.equal(clipState.chunkIndex, 7);
    });

    it('does not notify when the seek lands on the same chunk', () => {
      clipState.seek(0.55, 1);
      const manualChanges = [];
      clipState.on('chunkIndexManuallyChanged', (index) => manualChanges.push(index));

      clipState.seek(0.51, 1);

      assert.deepEqual(manualChanges, []);
      assert.equal(clipState.chunkIndex, 5);
    });
  });

  context('allowed boundary moving forward', () => {
    beforeEach(() => {
      // Start with a boundary that finishes buffering early.
      clipState.seek(0.2, 0.2);
      assert.equal(clipState.chunkIndex, 2);
      assert.equal(clipState.lastAllowedChunkIndex, 2);
      assert.equal(clipState.chunksBufferingFinished, true);
    });

    it('re-arms buffering when the boundary moves forward but stays before EOF', () => {
      clipState.lastAllowedChunkIndex = 0.8;

      assert.equal(clipState.lastAllowedChunkIndex, 8);
      assert.equal(clipState.chunksBufferingFinished, false);
    });

    it('re-arms buffering when the new boundary reaches EOF but the playhead is behind', () => {
      clipState.lastAllowedChunkIndex = 1;

      assert.equal(clipState.lastAllowedChunkIndex, 9);
      // The playhead (index 2) is still behind the EOF boundary, so buffering
      // must continue rather than stay finished.
      assert.equal(clipState.chunksBufferingFinished, false);
    });

    it('keeps buffering finished when the boundary does not move forward', () => {
      // Boundary 0.1 clamps up to index 1, which is still behind the playhead.
      clipState.lastAllowedChunkIndex = 0.1;

      assert.equal(clipState.lastAllowedChunkIndex, 1);
      assert.equal(clipState.chunksBufferingFinished, true);
    });

    it('re-arms buffering and keeps the playhead consistent via #seek', () => {
      clipState.seek(0.5, 0.9);

      assert.equal(clipState.chunkIndex, 5);
      assert.equal(clipState.lastAllowedChunkIndex, 9);
      assert.equal(clipState.chunksBufferingFinished, false);
    });
  });

  context('allowed boundary moving backward', () => {
    it('finishes buffering once the playhead catches up with the smaller boundary', () => {
      clipState.seek(0.5, 0.5);

      assert.equal(clipState.chunkIndex, 5);
      assert.equal(clipState.lastAllowedChunkIndex, 5);
      assert.equal(clipState.chunksBufferingFinished, true);
    });

    it('keeps buffering active when the boundary still lies ahead of the playhead', () => {
      clipState.seek(0.2, 0.7);
      clipState.seek(0.2, 0.5);

      assert.equal(clipState.chunkIndex, 2);
      assert.equal(clipState.lastAllowedChunkIndex, 5);
      assert.equal(clipState.chunksBufferingFinished, false);
    });
  });

  context('chunkIndex setter', () => {
    it('updates the stored index even when buffering is considered finished', () => {
      clipState.chunks.forEach((_, index, chunks) => {
        chunks[index] = readyChunk(index);
      });

      clipState.chunkIndex = clipState.totalChunksCount - 1;

      // Previously the setter returned early without persisting the index.
      assert.equal(clipState.chunkIndex, clipState.totalChunksCount - 1);
      assert.equal(clipState.chunksBufferingFinished, true);
    });

    it('still advances naturally without firing the manual-change event', () => {
      const manualChanges = [];
      clipState.on('chunkIndexManuallyChanged', (index) => manualChanges.push(index));

      clipState.chunkIndex = 1;

      assert.equal(clipState.chunkIndex, 1);
      assert.equal(clipState.chunksBufferingFinished, false);
      assert.deepEqual(manualChanges, []);
    });
  });
});
