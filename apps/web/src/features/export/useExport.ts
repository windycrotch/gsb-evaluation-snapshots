"use client";

import { useCallback, useRef, useState } from "react";
import type { ExportProgress } from "@cutaway/export-engine";
import { ExportCancelledError } from "@cutaway/export-engine";
import type { ExportSettings } from "@cutaway/types";
import { useEditorStore } from "@/state/editorStore";
import { useMediaImportContext } from "@/features/media/MediaImportProvider";
import { exportProjectToBlob } from "./exportProject";

export interface ExportController {
  isExporting: boolean;
  progress: ExportProgress | null;
  error: string | null;
  /** Whether the last export finished and downloaded successfully. */
  done: boolean;
  /** Starts an export, optionally overriding the project's stored settings. */
  start: (settings?: ExportSettings) => void;
  cancel: () => void;
}

/**
 * Drives a project export and the browser download of its result.
 *
 * State lives here rather than in a global store because an export is a
 * transient, view-local activity — start it, watch progress, get a file. The
 * abort controller lets the UI cancel a long render; the download is triggered
 * from the resulting Blob, which keeps the whole thing local (no upload).
 *
 * Concurrency rules:
 * - `start` while an export is running is ignored — one export at a time.
 * - `cancel` detaches the run immediately and resets to a clean baseline, so a
 *   new export can start at once; the cancelled run's late resolution is then
 *   recognised as stale and touches neither the state nor the download.
 * - Cancellation is not an error: it never surfaces in `error`.
 */
export function useExport(): ExportController {
  const { store } = useMediaImportContext();
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(
    (settings?: ExportSettings) => {
      if (abortRef.current) return; // already running — ignore the re-trigger
      const controller = new AbortController();
      abortRef.current = controller;
      setIsExporting(true);
      setError(null);
      setProgress(null);
      setDone(false);

      // True only while this run is the live one. cancel() detaches the
      // controller, which both unblocks an immediate restart and turns this
      // run's late settlement into a no-op.
      const isCurrent = () => abortRef.current === controller;

      void (async () => {
        try {
          const project = useEditorStore.getState().project;
          const { blob, filename } = await exportProjectToBlob(project, store(), {
            signal: controller.signal,
            onProgress: (p) => {
              if (isCurrent()) setProgress(p);
            },
            settings,
          });
          if (!isCurrent()) return; // cancelled meanwhile — no download
          triggerDownload(blob, filename);
          setDone(true);
        } catch (err) {
          if (!isCurrent()) return; // stale run — leave the new run's state alone
          if (!(err instanceof ExportCancelledError)) {
            setError(err instanceof Error ? err.message : String(err));
          }
        } finally {
          if (isCurrent()) {
            abortRef.current = null;
            setIsExporting(false);
          }
        }
      })();
    },
    [store],
  );

  const cancel = useCallback(() => {
    const controller = abortRef.current;
    if (!controller) return;
    // Detach first: the run's own finally will see it is stale and stand down,
    // so it can't clear a newer run's controller or state.
    abortRef.current = null;
    controller.abort();
    // Back to a clean baseline, ready for an immediate restart.
    setIsExporting(false);
    setProgress(null);
    setError(null);
    setDone(false);
  }, []);

  return { isExporting, progress, error, done, start, cancel };
}

/** Saves a Blob to disk via a transient object URL. */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
