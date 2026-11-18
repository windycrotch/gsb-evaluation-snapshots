/**
 * Label maps: the model grid as one byte per cell, row-major, holding the
 * index of the color block printed there (backend: services/label_map.py).
 * 2M cells travel as ~2.7 MB instead of ~45 MB of pixel coordinates.
 */
import type { ColorBlockSummary, ImageDimensions } from '../api/types';

/** Cells no block covers; block indices are 0..254. */
export const EMPTY_LABEL = 255;

type LabelMapParams = {
  colorBlocks: ColorBlockSummary[];
  labels: Uint8Array;
  imageDimensions: ImageDimensions;
};

/** Request params with block colors and the grid's label map. */
export function withLabelMap<T extends LabelMapParams>({ colorBlocks, labels, ...rest }: T) {
  return {
    ...rest,
    colorBlocks: colorBlocks.map(({ r, g, b, hex }) => ({ r, g, b, hex })),
    labelMap: toBase64(labels),
  };
}

/** Decode a response label map into row-major block indices. */
export function decodeLabelMap(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const labels = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) labels[i] = binary.charCodeAt(i);
  return labels;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}
