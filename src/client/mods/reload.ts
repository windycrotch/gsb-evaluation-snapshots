// Serialises mod reload requests. A reload triggered while another is still running is queued, and a queued
// request that a newer one supersedes never runs — so the final state always matches the last request, and the
// edit tables, file layer and asset layer of two reloads never interleave.

export interface ReloadCoordinator {
    /** Ask for a reload. Resolves when this request (or a newer one that covers it) has finished. */
    request(): Promise<void>;
}

export function createReloadCoordinator(run: () => Promise<void>): ReloadCoordinator {
    let requested = 0;
    let tail: Promise<void> = Promise.resolve();
    return {
        request() {
            const my = ++requested;
            const p = tail.then(async () => {
                if (my < requested) return; // a newer request arrived while this one queued: it reloads instead
                await run();
            });
            tail = p.then(() => {}, () => {}); // a failed run must not jam the queue
            return p;
        },
    };
}
