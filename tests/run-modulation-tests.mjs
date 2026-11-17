/*
 * Headless runner for the modulation chain test suite.
 * Executes the exact same tests as tests/modulation-tests.html under Node
 * by stubbing the few browser globals the App constructor touches.
 *
 * Usage: node tests/run-modulation-tests.mjs
 */

/* ---------- Browser global stubs (constructor-time only) ---------- */

const ctx2d = new Proxy({}, {
    get(t, k) {
        if (k in t) return t[k];
        return () => ctx2d;
    },
    set(t, k, v) { t[k] = v; return true; }
});

const canvasStub = {
    style: {},
    width: 0,
    height: 0,
    getContext: () => ctx2d,
    addEventListener() { },
    getBoundingClientRect: () => ({ left: 0, top: 0 })
};

const elementStub = () => ({
    style: {},
    value: '',
    files: [],
    addEventListener() { },
    click() { },
    textContent: ''
});

globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    addEventListener() { },
    location: { protocol: 'http:' },
    isSecureContext: true
};
globalThis.document = {
    getElementById: (id) => (id === 'nodeCanvas' ? canvasStub : elementStub()),
    createElement: () => elementStub()
};
globalThis.AudioNode = class AudioNode { };
globalThis.requestAnimationFrame = () => 0;
globalThis.alert = () => { };
if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => 'blob:mock';
if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => { };

/* ---------- Run the shared suite ---------- */

const { App } = await import('../js/app.js');
const {
    createMockAudioContext,
    installMockAudio,
    runModulationTests
} = await import('./modulation-tests.js');

const app = new App();
installMockAudio(app, createMockAudioContext());

const results = await runModulationTests(app);

let failed = 0;
for (const r of results) {
    if (r.pass) {
        console.log(`PASS: ${r.name}`);
    } else {
        failed++;
        console.log(`FAIL: ${r.name}\n    ${r.error}`);
    }
}
console.log(failed ? `\n${failed} of ${results.length} tests FAILED` : `\nAll ${results.length} tests passed`);
process.exit(failed ? 1 : 0);
