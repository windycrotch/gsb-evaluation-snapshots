// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================

/**
 * A cancellable unit of work for one load, for example one drag-and-drop of a local model or scene file.
 *
 * Every asynchronous stage of a load is bound to a session. Starting a newer load cancels the previous
 * session, which aborts its in-flight requests, revokes the temporary object URLs it created and marks it
 * inactive, so late callbacks can no longer write into the model state, watermark or statistics.
 */
export class LoadSession {
    /** Monotonic identifier, only used for logging. */
    public readonly id: number;

    private readonly controller: AbortController = new AbortController();
    private readonly objectUrls: Set<string> = new Set<string>();
    private cancelled: boolean = false;

    constructor(id: number) {
        this.id = id;
    }

    /** Aborted as soon as this session is cancelled. Pass it to every fetch started on behalf of the load. */
    public get signal(): AbortSignal {
        return this.controller.signal;
    }

    /** Whether this session may still touch the viewer state. */
    public isActive(): boolean {
        return !this.cancelled && !this.controller.signal.aborted;
    }

    /** Whether this session has been cancelled or superseded. */
    public get isCancelled(): boolean {
        return this.cancelled;
    }

    /** Create an object URL whose lifetime is bound to this session. */
    public trackBlob(blob: Blob): string {
        const url = URL.createObjectURL(blob);
        if (this.cancelled) {
            URL.revokeObjectURL(url);
            return url;
        }
        this.objectUrls.add(url);
        return url;
    }

    /** Track a local file as an object URL bound to this session. */
    public trackFile(file: File): string {
        return this.trackBlob(file);
    }

    /** Release one tracked object URL; foreign or already released URLs are ignored. */
    public releaseObjectUrl(url: string): void {
        if (!url || !this.objectUrls.delete(url)) return;
        URL.revokeObjectURL(url);
    }

    /** Cancel the session: abort in-flight work and release every temporary object URL. */
    public cancel(): void {
        if (this.cancelled) return;
        this.cancelled = true;
        this.controller.abort();
        this.objectUrls.forEach(url => URL.revokeObjectURL(url));
        this.objectUrls.clear();
    }
}
