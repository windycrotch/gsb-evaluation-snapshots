import { it, expect } from 'vitest';
import * as api from '../index.js';
it('keeps the complete root export contract explicit', () => {
  expect(Object.keys(api).sort()).toEqual([
    'AudioBuffer',
    'MAX_WAV_CHANNELS',
    'NAME',
    'VERSION',
    'analysisToCsv',
    'analyzeAudio',
    'checkWavEncodable',
    'decodeWav',
    'describe',
    'encodeWav',
    'fft',
    'generateSine',
    'generateWhiteNoise',
    'ifft',
    'istft',
    'parseWav',
    'serializeAnalysis',
    'stft',
  ]);
});
