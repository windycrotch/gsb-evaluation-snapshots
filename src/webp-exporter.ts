// WebP lossless encoder backed by libwebp compiled to WebAssembly. The
// webp.mjs / webp.wasm assets in static/lib/webp are shared with
// @playcanvas/splat-transform (built from Google's libwebp).

type WebpModule = {
    HEAPU8: Uint8Array;
    HEAPU32: Uint32Array;
    _free(ptr: number): void;
    _malloc(size: number): number;
    _webp_encode_lossless_rgba(
        data: number,
        width: number,
        height: number,
        stride: number,
        output: number,
        size: number
    ): number;
    _webp_free(ptr: number): void;
};

type ModuleLoader = (dir: string) => Promise<WebpModule>;

type WebpExporterOptions = {
    // base directory that contains webp.mjs / webp.wasm
    moduleDir?: string;
    // allows tests (or embedders) to supply a different module loader
    loader?: ModuleLoader;
    // cache shared with other exporters; production exporters share one cache
    // so the wasm module is only instantiated once per page
    cache?: ModuleCache;
};

// a module that is still initializing (or failed to initialize) must never be
// treated as usable: the wasm exports are only attached once instantiation
// completes
const isUsableModule = (module: unknown): module is WebpModule => {
    const m = module as Partial<WebpModule> | null;
    return (
        !!m &&
        typeof m._malloc === 'function' &&
        typeof m._free === 'function' &&
        typeof m._webp_encode_lossless_rgba === 'function' &&
        typeof m._webp_free === 'function'
    );
};

const checkModule = (module: unknown): WebpModule => {
    if (!isUsableModule(module)) {
        throw new Error('WebP module failed to initialize');
    }
    return module;
};

// resolve asset urls relative to the page's directory, so the tool also works
// when it is served from a nested path
const defaultModuleDir = (): string => new URL('lib/webp/', window.location.href).href;

const defaultLoader: ModuleLoader = (dir) => {
    return import(`${dir}webp.mjs`).then((mod) => mod.default({ locateFile: (path: string) => `${dir}${path}` }));
};

// Lazily instantiates and caches the libwebp module. Only successfully
// initialized modules are cached, so a failed load is retried by the next
// export instead of leaving a half-initialized module behind.
class ModuleCache {
    private readonly modules = new Map<string, Promise<WebpModule>>();

    get(dir: string, loader: ModuleLoader): Promise<WebpModule> {
        const cached = this.modules.get(dir);
        if (cached) {
            return cached;
        }

        const promise = loader(dir).then(checkModule);
        promise.catch(() => {
            if (this.modules.get(dir) === promise) {
                this.modules.delete(dir);
            }
        });
        this.modules.set(dir, promise);

        return promise;
    }
}

const sharedCache = new ModuleCache();

class WebpExporter {
    private readonly moduleDir: string;
    private readonly loader: ModuleLoader;
    private readonly cache: ModuleCache;

    private pending: Promise<Uint8Array> | null = null;

    constructor(options: WebpExporterOptions = {}) {
        this.moduleDir = options.moduleDir ?? defaultModuleDir();
        this.loader = options.loader ?? defaultLoader;
        this.cache = options.cache ?? sharedCache;
    }

    run(words: Uint32Array, width: number, height: number): Promise<Uint8Array> {
        // one request at a time: reject explicitly rather than interleaving
        // calls against the shared wasm heap
        if (this.pending) {
            return Promise.reject(new Error('WebP export already in progress'));
        }

        const promise = this.encode(words, width, height);
        this.pending = promise;

        const clear = () => {
            if (this.pending === promise) {
                this.pending = null;
            }
        };
        promise.then(clear, clear);

        return promise;
    }

    private async encode(words: Uint32Array, width: number, height: number): Promise<Uint8Array> {
        const module = await this.cache.get(this.moduleDir, this.loader);
        const rgba = new Uint8Array(words.buffer);

        const inPtr = module._malloc(rgba.length);
        const outPtrPtr = module._malloc(4);
        const outSizePtr = module._malloc(4);

        try {
            if (!inPtr || !outPtrPtr || !outSizePtr) {
                throw new Error('failed to allocate WebP encoder buffers');
            }

            module.HEAPU8.set(rgba, inPtr);

            const ok = module._webp_encode_lossless_rgba(inPtr, width, height, width * 4, outPtrPtr, outSizePtr);
            if (!ok) {
                throw new Error('WebP lossless encode failed');
            }

            const outPtr = module.HEAPU32[outPtrPtr >> 2];
            const outSize = module.HEAPU32[outSizePtr >> 2];

            if (!outPtr || !outSize) {
                throw new Error('WebP lossless encode produced no data');
            }

            const bytes = module.HEAPU8.slice(outPtr, outPtr + outSize);
            module._webp_free(outPtr);

            return bytes;
        } finally {
            if (inPtr) {
                module._free(inPtr);
            }
            if (outPtrPtr) {
                module._free(outPtrPtr);
            }
            if (outSizePtr) {
                module._free(outSizePtr);
            }
        }
    }

    readonly extension = 'webp';
}

export { WebpExporter, ModuleCache, defaultModuleDir };
export type { WebpModule, ModuleLoader, WebpExporterOptions };
