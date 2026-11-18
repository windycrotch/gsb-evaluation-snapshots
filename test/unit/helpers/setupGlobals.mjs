/**
 * Installs the minimal browser globals the Media component and its dependencies expect,
 * using controllable fake DOM objects. Imported before the component under test.
 * @module test/unit/helpers/setupGlobals
 */
import { FakeVideoElement, FakeElement } from './fakeMediaEnvironment.mjs';

let installed = false;

/**
 * Defines a global property if the runtime does not provide one.
 * @param {string} name   Global name.
 * @param {*}      value  Value to assign.
 */
function defineGlobal(name, value) {
    if (typeof globalThis[name] === 'undefined') {
        Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
}

/**
 * Installs document / window / navigator stubs and a pluggable fetch stub.
 * @returns {{ lastVideo: FakeVideoElement, setFetch: Function, getFetch: Function}}  Handles to control the created video element and fetch behavior.
 */
export function setupGlobals() {

    if (installed) return globalThis.__mediaTestHandles;

    const handles = { lastVideo: null, fetchImpl: null };

    const documentStub = {
        pictureInPictureEnabled: false,
        createElement(tagName) {
            if (String(tagName).toLowerCase() === 'video') {
                handles.lastVideo = new FakeVideoElement();
                return handles.lastVideo;
            }
            return new FakeElement();
        },
        querySelector() { return null; }
    };

    defineGlobal('document', documentStub);
    defineGlobal('window', globalThis);
    defineGlobal('navigator', { userAgent: 'node-test', vendor: '', platform: 'node' });
    defineGlobal('HTMLElement', class HTMLElement {});

    // fetch is fully controlled per test; defaulting to a failing stub so tests must declare their expectations
    globalThis.fetch = (...args) => {
        if (typeof handles.fetchImpl === 'function') return handles.fetchImpl(...args);
        return Promise.reject(new Error('fetch stub not configured'));
    };
    handles.setFetch = impl => { handles.fetchImpl = impl; };
    handles.getFetch = () => handles.fetchImpl;

    globalThis.__mediaTestHandles = handles;
    installed = true;

    return handles;
}
