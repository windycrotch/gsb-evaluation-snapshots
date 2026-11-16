import { it, expect } from 'vitest';
import * as api from '../io/index.js';
it('keeps the complete io export contract explicit', () => {
  expect(Object.keys(api).sort()).toEqual([
    'MAX_WAV_BYTES',
    'MAX_WAV_CHANNELS',
    'analysisToCsv',
    'asDataView',
    'checkWavEncodable',
    'decodeWav',
    'encodeWav',
    'parseWav',
    'readFourCC',
    'scanRiff',
    'serializeAnalysis',
    'validateAnalysis',
    'writeFourCC',
  ]);
});
