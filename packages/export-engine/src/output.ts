/**
 * How a finished export is presented: its MIME type and download filename.
 *
 * Pure and DOM-free so the mapping — including the filename sanitising, which
 * must never let an awkward project name escape into a path or produce a hidden
 * / undownloadable file — is unit-testable on its own.
 */

import type { ExportFormat } from "@cutaway/types";

const MIME_BY_FORMAT: Partial<Record<ExportFormat, string>> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  gif: "image/gif",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

/** The MIME type for an export container, falling back to a safe binary type. */
export function exportMimeType(format: ExportFormat): string {
  return MIME_BY_FORMAT[format] ?? "application/octet-stream";
}

/**
 * Makes a project name safe to use as a download filename.
 *
 * Everything outside `[A-Za-z0-9_.-]` collapses to a single underscore, and
 * leading/trailing dots and underscores are stripped — otherwise a name like
 * `"../secrets"` or `".hidden"` would produce a surprising or hidden file. An
 * empty result falls back to `"export"`, so there is always a usable name.
 */
export function sanitizeExportName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  return cleaned || "export";
}

/** The full download filename, e.g. `Holiday_Trip.mp4`. */
export function exportFilename(name: string, format: ExportFormat): string {
  return `${sanitizeExportName(name)}.${format}`;
}
