import { describe, expect, it } from 'vitest';
import { decodeLabelMap, EMPTY_LABEL, withLabelMap } from './labelMap';

function decode(base64: string): number[] {
  return Array.from(atob(base64), char => char.charCodeAt(0));
}

describe('withLabelMap', () => {
  it('sends block colors and the grid label map, without counts or labels', () => {
    const labels = Uint8Array.from([0, 1, EMPTY_LABEL, 1, 1, 0]);
    const payload = withLabelMap({
      colorBlocks: [
        { r: 255, g: 0, b: 0, hex: '#ff0000', count: 2 },
        { r: 0, g: 0, b: 255, hex: '#0000ff', count: 3 },
      ],
      labels,
      imageDimensions: { width: 3, height: 2 },
      layerCount: 4,
    });

    expect(payload.colorBlocks).toEqual([
      { r: 255, g: 0, b: 0, hex: '#ff0000' },
      { r: 0, g: 0, b: 255, hex: '#0000ff' },
    ]);
    expect(decode(payload.labelMap)).toEqual([0, 1, EMPTY_LABEL, 1, 1, 0]);
    expect(payload).toMatchObject({ imageDimensions: { width: 3, height: 2 }, layerCount: 4 });
    expect('labels' in payload).toBe(false);
  });

  it('encodes grids larger than one conversion chunk', () => {
    const width = 300;
    const height = 200;
    const labels = new Uint8Array(width * height);
    const payload = withLabelMap({
      colorBlocks: [{ r: 1, g: 2, b: 3, hex: '#010203', count: labels.length }],
      labels,
      imageDimensions: { width, height },
    });
    const cells = decode(payload.labelMap);
    expect(cells).toHaveLength(width * height);
    expect(cells.every(cell => cell === 0)).toBe(true);
  });
});

describe('decodeLabelMap', () => {
  it('round-trips a withLabelMap payload', () => {
    const width = 3;
    const height = 2;
    const labels = Uint8Array.from([0, 1, EMPTY_LABEL, 1, 1, 0]);
    const payload = withLabelMap({
      colorBlocks: [
        { r: 255, g: 0, b: 0, hex: '#ff0000', count: 2 },
        { r: 0, g: 0, b: 255, hex: '#0000ff', count: 3 },
      ],
      labels,
      imageDimensions: { width, height },
    });
    expect(decodeLabelMap(payload.labelMap)).toEqual(labels);
  });
});
