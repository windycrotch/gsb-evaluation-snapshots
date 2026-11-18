import type { ImportProgress, SliceWindowLevel, ViewerSlices } from './types';
import { ImportStage } from './types';

export const APP_ROUTES = {
  import: '/',
  viewer: '/viewer',
} as const;

export const PLANE_COLORS = {
  axial: '#38bdf8',
  coronal: '#f59e0b',
  sagittal: '#a78bfa',
} as const;

export const DEFAULT_IMPORT_ERROR_MESSAGE_KEY =
  'errors.failedToLoadSelectedScanFolder';

export const IMPORT_ERROR_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  E_FORMAT: 'errors.unsupportedFolderLayout',
  NotAllowedError: 'errors.sourceAccessDenied',
  SecurityError: 'errors.sourceAccessDenied',
  E_DIRECTORY_UPLOAD: 'errors.folderReadFailed',
  E_DICOM_UNSUPPORTED: 'errors.unsupportedDicomEncoding',
  E_DICOM_MISMATCH: 'errors.inconsistentDicomSeries',
  E_DICOM_COUNT: 'errors.invalidDicomSource',
  E_DICOM_HEADER: 'errors.invalidDicomSource',
  E_GWG: 'errors.incompleteScanSource',
  E_HEADER: 'errors.incompleteScanSource',
  E_SLICES: 'errors.incompleteScanSource',
  E_SLICE_GAP: 'errors.incompleteScanSource',
  E_DUPLICATE: 'errors.incompleteScanSource',
  E_ONEVOLUME_HEADER: 'errors.invalidOneVolumeSource',
  E_ONEVOLUME_ARRAY: 'errors.invalidOneVolumeSource',
  RangeError: 'errors.processingFailed',
  E_WORKER: 'errors.processingFailed',
};

export const IDLE_PROGRESS: ImportProgress = {
  stage: ImportStage.Idle,
  detailKey: 'importStatus.progress.selectFolder',
  completed: 0,
  total: 1,
};

export const EMPTY_SLICES: ViewerSlices = {
  axial: null,
  coronal: null,
  sagittal: null,
};

export const DEFAULT_WINDOW_LEVEL: SliceWindowLevel = {
  window: 3200,
  level: 1600,
};

export const WINDOW_MIN = 256;
export const WINDOW_MAX = 4095;
export const LEVEL_MIN = 0;
export const LEVEL_MAX = 4095;
export const DEFAULT_MPR_ZOOM = 1;
