import type { ScanFolderSource } from '../../../types';
import type { ImportFormatAdapter } from '../types';
import { dicomFormatAdapter } from './dicom';
import { galileosFormatAdapter } from './galileos';
import { oneVolumeFormatAdapter } from './onevolume';

export const importFormatAdapters: ImportFormatAdapter[] = [
  galileosFormatAdapter,
  dicomFormatAdapter,
  oneVolumeFormatAdapter,
];

export async function findImportAdapter(source: ScanFolderSource) {
  for (const adapter of importFormatAdapters) {
    if (await adapter.matches(source)) return adapter;
  }
}

export { dicomFormatAdapter, galileosFormatAdapter, oneVolumeFormatAdapter };
