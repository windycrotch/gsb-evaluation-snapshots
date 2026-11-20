// Worker function - kept as a string template for blob creation
type LodePng = {
    HEAPU8: Uint8Array;
    HEAPU32: Uint32Array;
    _free(ptr: number): void;
    _lodepng_encode32(data: number, size: number, image: number, width: number, height: number): void;
    _malloc(size: number): number;
};

type WorkerRequest = {
    id: number;
    words: Uint32Array;
    width: number;
    height: number;
};

type WorkerResponse = {
    id: number;
    error?: string;
    result?: Uint8Array;
};

type WorkerScope = {
    importScripts(url: string): void;
    lodepng(args: { locateFile: () => string }): Promise<LodePng>;
    onmessage: ((message: MessageEvent<WorkerRequest>) => void) | null;
    postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

function PngExportWorker(href: string): void {
    const scope = self as unknown as WorkerScope;

    let lodepngPromise: Promise<LodePng> | null = null;

    // initialize lazily so that a failed attempt can be retried by a later
    // message instead of wedging the worker forever
    const initLodepng = (): Promise<LodePng> => {
        if (!lodepngPromise) {
            const promise = new Promise<LodePng>((resolve) => {
                scope.importScripts(`${href}lib/lodepng/lodepng.js`);
                resolve(
                    scope.lodepng({
                        locateFile: () => `${href}lib/lodepng/lodepng.wasm`
                    })
                );
            });
            // clear the cache on failure so the next request retries the load
            promise.catch(() => {
                if (lodepngPromise === promise) {
                    lodepngPromise = null;
                }
            });
            lodepngPromise = promise;
        }
        return lodepngPromise;
    };

    const compress = (lodepng: LodePng, words: Uint32Array, width: number, height: number): Uint8Array => {
        const resultDataPtrPtr = lodepng._malloc(4);
        const resultSizePtr = lodepng._malloc(4);
        const imageData = lodepng._malloc(width * height * 4);

        try {
            if (!resultDataPtrPtr || !resultSizePtr || !imageData) {
                throw new Error('failed to allocate lodepng output buffers');
            }

            // copy pixels into wasm memory
            for (let i = 0; i < width * height; ++i) {
                lodepng.HEAPU32[imageData / 4 + i] = words[i];
            }

            // invoke compress
            lodepng._lodepng_encode32(resultDataPtrPtr, resultSizePtr, imageData, width, height);

            // read results
            const u32 = lodepng.HEAPU32;
            const resultPtr = u32[resultDataPtrPtr / 4];
            const resultSize = u32[resultSizePtr / 4];

            if (!resultPtr || !resultSize) {
                throw new Error('lodepng failed to encode image');
            }

            return lodepng.HEAPU8.slice(resultPtr, resultPtr + resultSize);
        } finally {
            if (resultDataPtrPtr) {
                lodepng._free(resultDataPtrPtr);
            }
            if (resultSizePtr) {
                lodepng._free(resultSizePtr);
            }
            if (imageData) {
                lodepng._free(imageData);
            }
        }
    };

    scope.onmessage = async (message: MessageEvent<WorkerRequest>) => {
        const data = message.data;

        try {
            const lodepng = await initLodepng();
            const result = compress(lodepng, data.words, data.width, data.height);
            scope.postMessage({ id: data.id, result: result }, [result.buffer]);
        } catch (err) {
            scope.postMessage({ id: data.id, error: `${err}` });
        }
    };
}

type PendingExport = {
    resolve: (value: Uint8Array) => void;
    reject: (reason?: unknown) => void;
};

type PngExporterOptions = {
    // allows tests (or embedders) to supply a worker with different assets
    createWorker?: () => Worker;
};

class PngExporter {
    worker: Worker | null = null;
    pending: PendingExport | null = null;

    private readonly workerFactory: () => Worker;
    private pendingId = 0;

    constructor(options: PngExporterOptions = {}) {
        this.workerFactory = options.createWorker ?? PngExporter.createWorker;
        // create eagerly, but do not let a creation failure disable the exporter:
        // the next export will try again
        try {
            this.ensureWorker();
        } catch (err) {
            console.error('failed to create PNG export worker', err);
        }
    }

    static createWorker(hrefOverride?: string): Worker {
        // pass the page directory as a quoted string literal, without the query or hash
        const href = JSON.stringify(hrefOverride ?? `${window.location.origin}${window.location.pathname}`);
        const workerBlob = new Blob([`(${PngExportWorker.toString()})(${href})\n\n`], {
            type: 'application/javascript'
        });
        const url = URL.createObjectURL(workerBlob);
        const worker = new Worker(url);
        URL.revokeObjectURL(url);
        return worker;
    }

    private ensureWorker(): Worker {
        if (!this.worker) {
            const worker = this.workerFactory();
            this.worker = worker;
            this.bindWorker(worker);
        }
        return this.worker;
    }

    private bindWorker(worker: Worker): void {
        worker.addEventListener('message', (message: MessageEvent<WorkerResponse>) => {
            const pending = this.pending;
            // ignore replies for requests that have already been settled
            if (!pending || message.data.id !== this.pendingId) {
                return;
            }

            this.pending = null;

            if (message.data.error) {
                pending.reject(new Error(message.data.error));
                // a failed encode can leave the wasm heap in an aborted state,
                // so start from a clean worker for the next export
                this.resetWorker(worker);
            } else {
                pending.resolve(message.data.result!);
            }
        });

        worker.addEventListener('error', (e: ErrorEvent) => {
            this.rejectPending(e.message || 'PNG export worker error');
            // the worker may be wedged after an uncaught error: replace it so a
            // subsequent export gets a clean instance
            this.resetWorker(worker);
        });

        worker.addEventListener('messageerror', () => {
            this.rejectPending('PNG export worker message error');
            this.resetWorker(worker);
        });
    }

    private rejectPending(reason: unknown): void {
        const pending = this.pending;
        this.pending = null;
        if (pending) {
            pending.reject(reason instanceof Error ? reason : new Error(`${reason}`));
        }
    }

    private resetWorker(worker: Worker | null): void {
        // ignore events from a worker that has already been superseded
        if (worker !== this.worker) {
            return;
        }

        this.worker = null;
        // a replacement is only created when the next export needs it, so a
        // failure here cannot leave the exporter permanently broken
        try {
            this.ensureWorker();
        } catch (err) {
            console.error('failed to recreate PNG export worker', err);
        }
        worker?.terminate();
    }

    run(words: Uint32Array, width: number, height: number): Promise<Uint8Array> {
        return new Promise<Uint8Array>((resolve, reject) => {
            // one request at a time: reject clearly instead of silently
            // orphaning the previous promise
            if (this.pending) {
                reject(new Error('PNG export already in progress'));
                return;
            }

            let worker: Worker;
            try {
                worker = this.ensureWorker();
            } catch (err) {
                reject(err instanceof Error ? err : new Error(`${err}`));
                return;
            }

            const id = ++this.pendingId;
            this.pending = { resolve, reject };

            try {
                worker.postMessage(
                    {
                        id: id,
                        words: words,
                        width: width,
                        height: height
                    },
                    [words.buffer]
                );
            } catch (err) {
                this.pending = null;
                reject(err instanceof Error ? err : new Error(`${err}`));
            }
        });
    }

    readonly extension = 'png';
}

export { PngExporter };
