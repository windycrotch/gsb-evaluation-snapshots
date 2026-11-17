/**
 * Hands the video to the system share sheet, or downloads it as a fallback.
 * Call ONLY from a user gesture handler (click), otherwise iOS rejects it.
 */
export async function shareOrDownload(blob: Blob, filename: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([blob], filename, { type: blob.type });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      // otherwise fall back to downloading
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}

/** Whether the file can go to the system share sheet (often not on desktop — then we show Download). */
export function canShareFile(blob: Blob, filename = 'reply.mp4'): boolean {
  try {
    return !!navigator.canShare?.({ files: [new File([blob], filename, { type: blob.type })] });
  } catch {
    return false;
  }
}
