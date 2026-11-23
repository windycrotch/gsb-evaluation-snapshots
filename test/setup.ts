// Test setup: the loader code references browser globals at module load time.
// Node 24 provides fetch/Response/ReadableStream/TextEncoder/WebAssembly already,
// we only stub the ones the import chain touches.
Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node-test' },
    configurable: true,
    writable: true,
});
if (!globalThis.location) {
    Object.defineProperty(globalThis, 'location', {
        value: { hostname: 'localhost' },
        configurable: true,
        writable: true,
    });
}
