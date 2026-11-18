---
title: Single-file DICOM import
date: 2026-08-10
status: done
related_paths:
  - src/lib/import/source-picker/
  - src/lib/import/scan-folder.ts
  - src/lib/import/adapters/dicom/
  - src/app/
  - src/components/FolderPicker.tsx
  - src/pages/ImportPage.tsx
  - src/i18n/locales/
  - tests/single-dicom.test.mjs
  - README.md
  - AGENTS.md
---

# Single-file DICOM import

## Background

The existing DICOM pipeline supports native slice stacks and uncompressed enhanced multi-frame volumes, but source selection and adapter matching require a folder with at least two `.dcm` files.

## Problem

`chernenko.dcm` is a single enhanced CT object containing a complete `551 x 551 x 551` volume. The app cannot select it directly and rejects a one-file source before reaching the existing compatible decoder.

## Decision

- Add a generic native file picker beside the existing directory picker; its current accept filter lists DICOM while leaving the picker contract reusable for future file formats.
- Wrap the chosen file in the existing `ScanFolderSource` contract instead of creating a second import pipeline.
- Let the DICOM adapter inspect sources with one or more `.dcm` files; the parser remains responsible for accepting supported multi-frame volumes and rejecting single 2D slices.
- Keep directory-handle and `webkitdirectory` behavior unchanged.

## Tradeoffs & Alternatives

- Do not add a DICOM dependency: the current reader already parses this sample's explicit little-endian, uncompressed enhanced CT payload.
- Do not rename the folder-oriented internal types in this feature; they already carry the required file list and renaming them would not change behavior.

## Verification

- [x] A one-file `.dcm` source reaches the DICOM adapter.
- [x] `chernenko.dcm` metadata and full pixel payload match the decoder's expectations.
- [x] Existing folder imports still build and lint.
- [x] Manual browser selection and rendering are confirmed.

## Implementation Notes

- 2026-08-10: Sample inspection found explicit VR little-endian Enhanced CT, 551 frames of 551 x 551 unsigned 16-bit MONOCHROME2 pixels at 0.2 mm isotropic spacing. The declared 334,568,302-byte pixel payload exactly matches the volume geometry.
- 2026-08-10: The full sample decoded into 167,284,151 voxels, produced a complete histogram, and generated a downsampled 512 x 512 x 512 3D preview in 12.06 seconds.
- 2026-08-10: Browser verification confirmed the file picker, `/viewer` routing, three visible MPR slices, the 3D volume, and no console errors.
- 2026-08-10: User follow-up generalized the selection API to `directoryPicker`/`filePicker` and `openDirectory`/`openFile`; DICOM remains a current format choice, not part of the picker contract.
- 2026-08-10: User explicitly finalized the feature and this decision entry.
