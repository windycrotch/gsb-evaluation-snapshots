"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExportSession, type ExportProgress, type ExportRunContext } from "@cutaway/export-engine";
import type { ExportSettings } from "@cutaway/types";
import { useEditorStore } from "@/state/editorStore";
import { useMediaImportContext } from "@/features/media/MediaImportProvider";
import { exportProjectToBlob, type ExportResult } from "./exportProject";

export interface ExportController {
  isExporting: boolean;
  progress: ExportProgress | null;
  error: string | null;
  /** Whether the last export was stopped by the user. */
  cancelled: boolean;
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
 * The lifecycle itself is the engine's {@link ExportSession}, not local flags: it
 * guarantees that a run superseded by a newer one is aborted first, and that
 * progress or a settled result from a stale run is dropped — so a second export
 * started right after a cancel never shows the first run's late progress or
 * scores a stale download.
 */
export function useExport(): ExportController {
  const { store } = useMediaImportContext();
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [done, setDone] = useState(false);

  const session = useMemo(() => {
    // A runner is created once per mount; each call builds a fresh export
    // (container/encoder/cache) inside `exportProjectToBlob`.
    const runner = async (
      settings: ExportSettings | undefined,
      { signal, onProgress }: ExportRunContext,
    ): Promise<ExportResult> => {
      const project = useEditorStore.getState().project;
      return exportProjectToBlob(project, store(), { signal, onProgress, settings });
    };

    return new ExportSession<ExportSettings | undefined, ExportResult>(runner, {
      onStart: () => {
        setError(null);
        setCancelled(false);
        setProgress(null);
        setDone(false);
        setIsExporting(true);
      },
      onProgress: setProgress,
      onSettled: (outcome) => {
        setIsExporting(false);
        if (outcome.status === "success") {
          triggerDownload(outcome.result.blob, outcome.result.filename);
          setDone(true);
        } else if (outcome.status === "failed") {
          setError(outcome.error.message);
        } else {
          // Cancelled: no file, no error — but the user gets explicit feedback
          // that the run ended, rather than a dialog that silently reset.
          setCancelled(true);
        }
      },
    });
  }, [store]);

  // Abort an in-flight export if the component using this hook unmounts, so a
  // background run cannot keep an encoder (and its GPU resources) alive.
  useEffect(() => () => session.dispose(), [session]);

  const start = useCallback(
    (settings?: ExportSettings) => {
      // Deliberately no "already running" guard: starting again supersedes the
      // in-flight run (aborting it first), which is what lets a user cancel and
      // immediately retry without waiting for the old run to unwind.
      void session.start(settings);
    },
    [session],
  );

  const cancel = useCallback(() => session.cancel(), [session]);

  return { isExporting, progress, error, cancelled, done, start, cancel };
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
