"use client";

import { useEffect, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  Download,
  X,
  Film,
} from "lucide-react";
import { toast } from "sonner";
import { useVideoStore } from "@/lib/use-video-store";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  EmptyTimelineError,
  RenderCancelledError,
  computeFramePlan,
  renderVideo,
} from "../lib/render-engine";
import { createBrowserPlatform } from "../lib/browser-platform";

interface FileUploaderProps {
  loadFunction: () => Promise<void>;
  loadFfmpeg: boolean;
  ffmpeg: FFmpeg;
}

type RenderStatus =
  | "idle"
  | "preparing"
  | "capturing"
  | "encoding"
  | "complete"
  | "error";

export default function FfmpegRender({
  loadFunction,
  loadFfmpeg,
  ffmpeg,
}: FileUploaderProps) {
  const [status, setStatus] = useState<RenderStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [totalFrames, setTotalFrames] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [outputFileName, setOutputFileName] = useState("video.mp4");
  const [errorMessage, setErrorMessage] = useState("");

  // AbortController for the in-flight render run.
  const abortRef = useRef<AbortController | null>(null);
  // Monotonic run id so a late callback from a superseded run can never
  // overwrite the current state.
  const runIdRef = useRef(0);
  const previewUrlRef = useRef<string | null>(null);

  const totalDuration = useVideoStore((state) => state.totalDuration);
  const exportSettings = useVideoStore((state) => state.exportSettings);
  const seekTo = useVideoStore((state) => state.seekTo);
  const pause = useVideoStore((state) => state.pause);

  const setPreview = (url: string | null) => {
    if (previewUrlRef.current && previewUrlRef.current !== url) {
      URL.revokeObjectURL(previewUrlRef.current);
    }
    previewUrlRef.current = url;
    setPreviewUrl(url);
  };

  // Revoke any object URL when the component unmounts.
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
    };
  }, []);

  const resetToIdle = () => {
    setStatus("idle");
    setProgress(0);
    setCurrentFrame(0);
    setTotalFrames(0);
    setPreview(null);
    setErrorMessage("");
  };

  const handleCancel = async () => {
    // Mark this run as dead first: every state update it still emits must be
    // ignored once its id is behind the latest one.
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    resetToIdle();

    // Terminate the worker so an in-flight ffmpeg.exec/frame capture really
    // stops, then reload a fresh instance so the next render can start.
    try {
      ffmpeg.terminate();
    } catch (e) {
      console.error("Failed to terminate FFmpeg:", e);
    }
    try {
      await loadFunction();
    } catch (e) {
      console.error("Failed to reload FFmpeg:", e);
    }
  };

  const render = async () => {
    if (!loadFfmpeg) {
      toast.error("FFmpeg is not loaded yet");
      return;
    }

    // Find the scene preview element
    const previewElement = document.querySelector(
      '[data-scene-preview="true"]'
    ) as HTMLElement | null;
    if (!previewElement) {
      toast.error(
        "Scene preview not found. Please ensure the preview is visible."
      );
      return;
    }

    // Boundary: empty timeline. Fail explicitly with a retryable error state
    // before writing any frame file or invoking ffmpeg.
    if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
      const message =
        "Timeline duration is 0 — add at least one scene before exporting.";
      setErrorMessage(message);
      setStatus("error");
      toast.error(message);
      return;
    }

    const plan = computeFramePlan(totalDuration, exportSettings);
    if (plan.totalFrames <= 0) {
      const message =
        "No frames could be calculated for this export — check the timeline duration and frame rate.";
      setErrorMessage(message);
      setStatus("error");
      toast.error(message);
      return;
    }

    const runId = ++runIdRef.current;
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus("preparing");
    setProgress(0);
    setCurrentFrame(0);
    setTotalFrames(plan.totalFrames);
    setErrorMessage("");
    setPreview(null);

    try {
      const result = await renderVideo({
        ffmpeg,
        previewElement,
        exportSettings,
        totalDuration,
        signal: controller.signal,
        seekTo,
        pause,
        platform: createBrowserPlatform(() => useVideoStore.getState().zoom),
        onPhase: (phase) => {
          if (runId !== runIdRef.current) return;
          setStatus(phase);
          if (phase === "encoding") setProgress(0);
        },
        onProgress: (current, total) => {
          if (runId !== runIdRef.current) return;
          setCurrentFrame(current);
          setProgress(Math.round((current / total) * 100));
        },
      });

      // A cancel/retry may have happened while the promise was settling.
      if (runId !== runIdRef.current) return;

      setPreview(URL.createObjectURL(result.blob));
      setOutputFileName(result.fileName);
      setStatus("complete");
      toast.success(`${result.format.toUpperCase()} exported successfully!`);
    } catch (err) {
      if (runId !== runIdRef.current) return;

      if (err instanceof RenderCancelledError || controller.signal.aborted) {
        // Cancellation is not an error: return to a clean idle state with no
        // leftover preview or error message.
        resetToIdle();
        return;
      }

      const message =
        err instanceof EmptyTimelineError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to render video";
      setErrorMessage(message);
      setStatus("error");
      toast.error(message);
      console.error("Failed to render video:", err);
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  };

  // Render button when idle
  if (status === "idle") {
    return (
      <Button
        onClick={render}
        disabled={!loadFfmpeg}
        className="w-full gap-2 bg-pink-500 hover:bg-pink-600 text-white"
      >
        {!loadFfmpeg ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading FFmpeg...
          </>
        ) : (
          <>
            <Film className="w-4 h-4" />
            Start Rendering
          </>
        )}
      </Button>
    );
  }

  // Capturing/Encoding progress
  if (
    status === "preparing" ||
    status === "capturing" ||
    status === "encoding"
  ) {
    return (
      <div className="py-6 space-y-6">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="w-16 h-16 rounded-full bg-pink-500/10 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-pink-500 animate-spin" />
            </div>
          </div>
          <div className="text-center">
            <p className="text-white font-medium">
              {status === "preparing" && "Preparing..."}
              {status === "capturing" && "Capturing frames..."}
              {status === "encoding" && "Encoding video..."}
            </p>
            <p className="text-sm text-zinc-400 mt-1">
              {status === "capturing" && `Frame ${currentFrame}/${totalFrames}`}
              {status === "encoding" && "Almost done..."}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Progress value={progress} className="h-2 bg-zinc-800" />
          <p className="text-xs text-zinc-500 text-center">{progress}%</p>
        </div>

        <Button
          onClick={handleCancel}
          variant="outline"
          className="w-full border-zinc-700 text-zinc-300 hover:bg-zinc-800 bg-transparent"
        >
          Cancel
        </Button>
      </div>
    );
  }

  // Complete state
  if (status === "complete" && previewUrl) {
    return (
      <div className="py-6 space-y-6">
        <div className="flex flex-col items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center">
            <CheckCircle2 className="w-8 h-8 text-green-400" />
          </div>
          <div className="text-center">
            <p className="text-white font-medium">Export Complete!</p>
            <p className="text-sm text-zinc-400 mt-1">
              Your video is ready to download
            </p>
          </div>
        </div>

        {/* Preview based on format */}
        <div className="rounded-lg overflow-hidden border border-zinc-700">
          {exportSettings.format === "gif" ? (
            <img
              src={previewUrl}
              alt="GIF Preview"
              className="w-full"
              style={{ maxHeight: "300px" }}
            />
          ) : (
            <video
              src={previewUrl}
              controls
              className="w-full"
              style={{ maxHeight: "300px" }}
            />
          )}
        </div>

        <div className="flex gap-3">
          <Button
            asChild
            className="flex-1 gap-2 bg-pink-500 hover:bg-pink-600 text-white"
          >
            <a href={previewUrl} download={outputFileName}>
              <Download className="w-4 h-4" />
              Download {exportSettings.format === "gif" ? "GIF" : "Video"}
            </a>
          </Button>
          <Button
            onClick={resetToIdle}
            variant="outline"
            className="border-zinc-700 text-zinc-300 hover:bg-zinc-800 bg-transparent"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>
    );
  }

  // Error state
  if (status === "error") {
    return (
      <div className="py-6 space-y-6">
        <div className="flex flex-col items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center">
            <AlertCircle className="w-8 h-8 text-red-400" />
          </div>
          <div className="text-center">
            <p className="text-white font-medium">Export Failed</p>
            <p className="text-sm text-red-400 mt-1">{errorMessage}</p>
          </div>
        </div>

        <Button
          onClick={resetToIdle}
          className="w-full bg-zinc-800 hover:bg-zinc-700 text-white"
        >
          Try Again
        </Button>
      </div>
    );
  }

  return null;
}
