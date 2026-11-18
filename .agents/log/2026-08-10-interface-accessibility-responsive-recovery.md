---
title: Interface accessibility and responsive recovery
date: 2026-08-10
status: wip
related_paths:
  - src/app/
  - src/components/
  - src/i18n/
  - src/pages/
  - src/styles.css
  - tests/
---

# Interface accessibility and responsive recovery

## Background

Two interface audits identified keyboard, modal, semantic, contrast, responsive-layout, and recovery gaps in the import and viewer flows. This pass builds on the finalized [MPR zoom and scrub navigation](2026-04-01-mpr-zoom-scrub-navigation.md), [3D quality and plane controls](2026-04-01-3d-quality-plane-controls.md), [React-i18next i18n](2026-04-07-react-i18next-i18n.md), and [Single-file DICOM import](2026-08-10-single-file-dicom-import.md) decisions.

## Decision

- Preserve the current pointer and touch interactions while adding keyboard-equivalent MPR navigation, explicit recovery actions, and accessible instructions.
- Treat the compact study panel as a modal drawer with dialog semantics, inert background, focus containment, Escape dismissal, and trigger-focus restoration.
- Keep desktop sidebar preference separate from compact drawer-open state.
- Collapse based on the viewer's usable width near the audited 800 px failure point while preserving the wide desktop composition.
- Map import failures to localized, actionable public messages while retaining the original error for private diagnostics.
- Improve semantics, contrast, hit areas, focus treatment, and reduced-motion behavior through the existing CSS and i18n systems.

## Tradeoffs & Alternatives

- Do not replace the Three.js renderer or Trackball controls; expose reset through the existing preview instance.
- Do not replace the established MPR gesture model; keyboard controls augment the focusable canvas surface.
- Prefer the native platform and small local focus-management code over adding a dialog or accessibility dependency.

## Implementation Plan

1. Map all audit findings to the current state owner, viewer components, import page, translations, and CSS.
2. Implement the interaction and responsive changes with focused tests.
3. Run repository checks and browser verification at every required viewport with the authorized DICOM sample.

## Verification

- [x] `npm run format:check`
- [x] `npm run lint`
- [x] `npm run build`
- [x] Repository tests
- [x] Folder and single-DICOM import contracts remain intact by focused regression test and unchanged source-picker/adapter paths
- [x] MPR and Three pointer/touch handlers remain intact by final diff inspection
- [x] Keyboard MPR controls and reset actions work
- [x] Compact dialog traps/restores focus, dismisses on Escape, and inerts the viewer background
- [x] No horizontal overflow on the import route at 320 px
- [x] Browser verification at 1440x900, 800x720, 767x720, and 320x568
- [x] 3D and MPR render from `chernenko.dcm`, linked cursor changes, and console stays error-free

## Implementation Notes

- 2026-08-10: Scope comes from the two completed audits and their live-view follow-up. No clarification was needed because the requested behaviors and preserved contracts are explicit.
- 2026-08-10: Added focusable keyboard-operated MPR and 3D surfaces, explicit reset actions, toggle state semantics, range labels and hints, progress semantics, document-language synchronization, safe localized import errors, and consistent focus/reduced-motion treatment without replacing the existing gesture or rendering paths.
- 2026-08-10: Split desktop sidebar preference from compact drawer state, moved the compact breakpoint to 1023 px, implemented modal focus containment/Escape/inert/restore behavior, compacted the ready state and navigation help, and raised compact targets to 44 px.
- 2026-08-10: Kept the visible `Star on GitHub` copy at the developer's request and supplied the descriptive source-repository name through `aria-label` only.
- 2026-08-10: Final repository gates pass: format and lint checked 79 files, production build completed with the existing Three.js chunk-size warning, and both Node regression tests pass.
- 2026-08-10: Production-browser import-route checks pass at 1440x900, 800x720, 767x720, and 320x568: no horizontal overflow, 40 px desktop and 44 px compact targets, the primary folder action remains above the 320 px fold, Ukrainian sets `html[lang=uk]`, focus shows a 3 px cyan outline, and the console has no errors.
- 2026-08-10: Automated `chernenko.dcm` file injection was initially blocked because the ChatGPT Chrome extension rejected `fileChooser.setFiles` without its "Allow access to file URLs" permission. Direct and temporary-copy attempts were both rejected; the temporary DICOM copy was removed.
- 2026-08-10: The developer loaded `chernenko.dcm` manually in the handed-off Chrome tab. Live verification then passed: four non-zero canvases at 1440x900; exact one- and ten-voxel MPR keyboard steps; pointer scrub and wheel zoom; 3D keyboard rotation, pointer rotation, wheel zoom, and reset; axis/sidebar/plane toggle state; Window adjustment and restoration; compact axis selection; and an empty browser error console.
- 2026-08-10: At 1440x720, the ready state is 40 px high, only the middle sidebar region scrolls, and the 172 px action/safety footer remains visible. At 800x720, 767x720, and 320x568, compact mode shows one MPR pane, keeps 44 px controls, opens with the study drawer closed, and has no horizontal overflow or overlapping toolbar controls.
- 2026-08-10: Follow-up visual feedback kept the overlay controls physically accessible but shortened their visible labels and spacing, removed the unexplained Axial-only reset icon, moved the shared labeled MPR reset into the Navigation section, restored always-visible help, and changed the import error mapping to a grouped `switch`.
- 2026-08-10: A second visual follow-up explicitly restored the four 3D overlay controls to their original compact height. The opt-out is scoped to that toolbar; other controls retain the larger target treatment.
- 2026-08-10: Follow-up review centralized public import-error message keys by diagnostic code in `src/constants.ts`; `makeImportIssue` now performs one map lookup with a shared generic fallback.
