/* End-to-end checks for the "one clean visualization session per song" rules.
 *
 * Everything runs offline: the Firebase CDN is replaced with a controllable
 * stub, and audio is generated locally as WAV tones whose spectra identify
 * which track is really driving the analyser.
 */
'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    startServer,
    launchBrowser,
    openApp,
    uploadTrack,
    clickLibraryTrack,
    snapshot,
    waitForSpectrum,
    rendererActivity
} = require('./support/harness');
const { TRACK_BINS, trackKey } = require('./support/audio');

let server;
let browser;

before(async () => {
    server = await startServer();
    browser = await launchBrowser();
});

after(async () => {
    if (browser) await browser.close();
    if (server) await server.close();
});

/** Emits library entries for the given tracks and waits for their buttons. */
async function seedLibrary(page, fileNames) {
    const entries = fileNames.map((name) => [trackKey(name), server.trackUrl(name)]);
    await page.evaluate((items) => {
        items.forEach(([key, url]) => window.__firebaseStub.emitSong(key, url));
    }, entries);
    await page.waitForFunction(
        (count) => document.querySelectorAll('#prevSongs button').length >= count,
        fileNames.length
    );
}

async function openWithSeededLibrary(fileNames, options) {
    const app = await openApp(browser, server.origin, options);
    await seedLibrary(app.page, fileNames);
    return app;
}

/** Asserts the "one session at a time" invariants after a switch settles. */
async function assertSingleSession(page, label) {
    const state = await snapshot(page);
    assert.equal(state.bodyCanvases, 1, `${label}: exactly one visualizer canvas`);
    assert.equal(state.canvases, 1, `${label}: no other canvas is present`);
    assert.equal(state.audioElements, 1, `${label}: exactly one audio element in the player`);
    assert.equal(state.connectedMediaSources, 1, `${label}: exactly one connected media source`);
    assert.equal(state.analysersToDestination, 1, `${label}: exactly one analyser feeds the output`);
    assert.deepEqual(state.errors, [], `${label}: no uncaught page errors`);

    // Superseded media elements must be detached from the document and have
    // no source left, so they cannot keep playing into the output.
    state.mediaElements.forEach((element, index) => {
        if (element.sameAsCurrent) return;
        assert.equal(element.connected, false, `${label}: old audio element #${index} left the DOM`);
        assert.equal(element.hasSrc, false, `${label}: old audio element #${index} released its source`);
        assert.equal(element.paused, true, `${label}: old audio element #${index} is paused`);
    });

    // Let a superseded frame that was already queued run; it must not render.
    await page.waitForTimeout(300);
    const active = await rendererActivity(page, 500);
    assert.equal(active.length, 1, `${label}: exactly one renderer is drawing (got ${active})`);
    return { state, rendererId: active[0] };
}

describe('library switching', () => {
    test('selecting a second track replaces the first session completely', async () => {
        const app = await openWithSeededLibrary(['alpha-tone.wav', 'beta-tone.wav']);
        const page = app.page;

        await clickLibraryTrack(page, 'alpha-tone');
        await waitForSpectrum(page, TRACK_BINS['alpha-tone.wav']);
        const first = await assertSingleSession(page, 'alpha');
        assert.equal((await page.textContent('#track-title')).trim(), 'alpha-tone');

        await clickLibraryTrack(page, 'beta-tone');
        const live = await waitForSpectrum(page, TRACK_BINS['beta-tone.wav']);
        assert.ok(live.liveAnalysers === 1, 'only the new analyser remains wired to the output');
        const second = await assertSingleSession(page, 'beta');

        assert.notEqual(second.rendererId, first.rendererId, 'the new session renders with a new renderer');
        assert.ok(second.state.contextLosses >= 2, 'the previous WebGL contexts were released');
        assert.equal((await page.textContent('#track-title')).trim(), 'beta-tone');

        // The first renderer must be frozen: no renders at all for a while.
        await page.evaluate(() => window.__probe.resetRenders());
        await page.waitForTimeout(700);
        const renders = await page.evaluate(() => window.__probe.renders.map((entry) => entry.id));
        assert.ok(renders.length > 0, 'the current session keeps rendering');
        assert.ok(renders.every((id) => id === second.rendererId),
            `only the current renderer draws, saw ${JSON.stringify([...new Set(renders)])}`);
        assert.equal((await snapshot(page)).staleRenders, 0, 'no detached canvas is still rendering');

        await app.close();
    });

    test('rapid double selection settles on the last track', async () => {
        const app = await openWithSeededLibrary(['alpha-tone.wav', 'beta-tone.wav', 'gamma-tone.wav']);
        const page = app.page;

        await clickLibraryTrack(page, 'alpha-tone');
        await waitForSpectrum(page, TRACK_BINS['alpha-tone.wav']);
        const before = await rendererActivity(page, 500);
        assert.equal(before.length, 1);

        // Two selections back to back, faster than a session can settle.
        await Promise.all([
            page.evaluate(() => document.querySelectorAll('#prevSongs button')[2].click()),
            page.waitForTimeout(10).then(() => page.evaluate(() =>
                document.querySelectorAll('#prevSongs button')[1].click()))
        ]);

        const live = await waitForSpectrum(page, TRACK_BINS['beta-tone.wav']);
        assert.equal(live.liveAnalysers, 1);
        const { rendererId } = await assertSingleSession(page, 'rapid double switch');
        assert.ok(!before.includes(rendererId), 'the winning selection built a fresh session');
        assert.equal((await page.textContent('#track-title')).trim(), 'beta-tone');

        const playingTitles = await page.evaluate(() =>
            Array.from(document.querySelectorAll('#prevSongs button[data-playing]'))
                .map((button) => button.textContent));
        assert.deepEqual(playingTitles, ['beta-tone'], 'playing indicator marks only the last track');
        const current = await page.evaluate(() =>
            Array.from(document.querySelectorAll('#prevSongs button[aria-current="true"]'))
                .map((button) => button.textContent));
        assert.deepEqual(current, ['beta-tone'], 'aria-current marks only the last track');

        // Still exactly one renderer, and it is the newest one.
        await page.waitForTimeout(400);
        const active = await rendererActivity(page, 500);
        assert.deepEqual(active, [rendererId]);
        assert.equal(await page.evaluate(() => window.__probe.lastRendererId()), rendererId);

        await app.close();
    });

    test('upload immediately followed by a library pick ends on the library pick', async () => {
        const app = await openWithSeededLibrary(['alpha-tone.wav', 'gamma-tone.wav']);
        const page = app.page;

        // Requirement 4's exact race: the upload session exists and its
        // Firebase promise is still in flight when the library is clicked.
        await page.evaluate(() => window.__firebaseStub.setUploadDelay(1500));
        await uploadTrack(page, 'beta-tone.wav');
        await page.waitForFunction(() =>
            document.querySelector('#track-title').textContent.trim() === 'beta-tone.wav');

        const uploadsInFlight = await page.evaluate(() =>
            window.__firebaseStub.uploads.length);
        assert.equal(uploadsInFlight, 1);

        await page.evaluate(() => document.querySelectorAll('#prevSongs button')[0].click());

        const live = await waitForSpectrum(page, TRACK_BINS['alpha-tone.wav']);
        assert.equal(live.liveAnalysers, 1);
        await assertSingleSession(page, 'upload then library pick');

        assert.equal((await page.textContent('#track-title')).trim(), 'alpha-tone');
        const playing = await page.evaluate(() =>
            Array.from(document.querySelectorAll('#prevSongs button[data-playing]'))
                .map((button) => button.textContent));
        assert.deepEqual(playing, ['alpha-tone'], 'the playing indicator follows the last pick');

        // The upload finishing later must not steal the UI back.
        await page.waitForTimeout(2000);
        assert.equal((await page.textContent('#track-title')).trim(), 'alpha-tone');
        const activeAfterUpload = await rendererActivity(page, 500);
        assert.equal(activeAfterUpload.length, 1, 'still a single rendering session');
        await assertSingleSession(page, 'upload finished after pick');

        // The rejected blob must not leak: the upload session is gone, its
        // canvas was released and its object URL was revoked.
        const state = await snapshot(page);
        assert.equal(state.staleRenders, 0, 'no detached canvas keeps drawing');
        assert.equal(state.objectUrlsCreated, 1);
        assert.equal(state.objectUrlsRevoked, 1, 'the superseded blob URL was released');

        await app.close();
    });
});

describe('local uploads', () => {
    test('uploading a file plays it locally and swaps out the library session', async () => {
        const app = await openWithSeededLibrary(['alpha-tone.wav']);
        const page = app.page;

        await clickLibraryTrack(page, 'alpha-tone');
        await waitForSpectrum(page, TRACK_BINS['alpha-tone.wav']);

        await uploadTrack(page, 'beta-tone.wav');
        const live = await waitForSpectrum(page, TRACK_BINS['beta-tone.wav']);
        assert.equal(live.liveAnalysers, 1);
        await assertSingleSession(page, 'upload');

        assert.equal((await page.textContent('#track-title')).trim(), 'beta-tone.wav');
        const state = await snapshot(page);
        assert.equal(state.objectUrlsCreated, 1);
        assert.equal(state.objectUrlsRevoked, 0, 'the playing blob URL is still in use');

        const uploads = await page.evaluate(() => window.__firebaseStub.uploads);
        assert.deepEqual(uploads.map((entry) => entry.name), ['beta-tone.wav']);

        await app.close();
    });

    test('a failed upload shows a visible error and playback still works', async () => {
        const app = await openWithSeededLibrary(['alpha-tone.wav']);
        const page = app.page;
        await page.evaluate(() => window.__firebaseStub.setUploadFailure(true));

        await uploadTrack(page, 'beta-tone.wav');

        // The local file plays even though the library rejected it.
        await waitForSpectrum(page, TRACK_BINS['beta-tone.wav']);
        await assertSingleSession(page, 'failed upload');

        // On the wide layout the library stays open, so the message appears
        // inline there and the floating toast stays out of the way.
        const inline = page.locator('#upload-status');
        await inline.waitFor({ state: 'visible', timeout: 5000 });
        const text = (await inline.textContent()).trim();
        assert.match(text, /upload failed/i);
        assert.match(text, /beta-tone\.wav/);
        assert.equal(await page.locator('#status-toast').isVisible(), false);
        assert.equal((await page.textContent('#track-title')).trim(), 'beta-tone.wav');

        // With the library closed the same message is surfaced as a toast so
        // the failure is never silent.
        await page.click('#library-close');
        await page.locator('#status-toast').waitFor({ state: 'visible', timeout: 5000 });
        assert.match((await page.textContent('#status-toast')).trim(), /upload failed/i);

        // The state stays usable: pick a library song, then upload again.
        await page.click('#library-toggle');
        await clickLibraryTrack(page, 'alpha-tone');
        await waitForSpectrum(page, TRACK_BINS['alpha-tone.wav']);
        await assertSingleSession(page, 'library after failed upload');

        await page.evaluate(() => window.__firebaseStub.setUploadFailure(false));
        await uploadTrack(page, 'gamma-tone.wav');
        await waitForSpectrum(page, TRACK_BINS['gamma-tone.wav']);
        await assertSingleSession(page, 'upload retried');

        const status = page.locator('#upload-status');
        await status.waitFor({ state: 'visible', timeout: 5000 });
        assert.match((await status.textContent()).trim(), /added to the shared library/i);

        assert.deepEqual(app.pageErrors, [], 'no uncaught page errors');
        await app.close();
    });

    test('the same file can be uploaded again after a failure', async () => {
        const app = await openWithSeededLibrary(['alpha-tone.wav']);
        const page = app.page;
        await page.evaluate(() => window.__firebaseStub.setUploadFailure(true));

        await uploadTrack(page, 'beta-tone.wav');
        await page.locator('#upload-status').waitFor({ state: 'visible' });
        const firstUploads = await page.evaluate(() => window.__firebaseStub.uploads.length);
        assert.equal(firstUploads, 1);

        await page.evaluate(() => window.__firebaseStub.setUploadFailure(false));
        // Identical file name: without clearing the input this would be a no-op.
        await uploadTrack(page, 'beta-tone.wav');

        await page.waitForFunction(() => window.__firebaseStub.uploads.length === 2 || true);
        await page.waitForTimeout(600);
        const uploads = await page.evaluate(() => window.__firebaseStub.uploads);
        assert.equal(uploads.length, 2, 'the retry reached Firebase');
        await assertSingleSession(page, 'same file retried');

        await app.close();
    });
});

describe('non-session side effects', () => {
    test('repeated rebuilds leave one canvas, one GUI and no stale renderer', async () => {
        const app = await openWithSeededLibrary(['alpha-tone.wav', 'beta-tone.wav']);
        const page = app.page;
        const first = await snapshot(page);
        assert.equal(first.bodyCanvases, 1);

        // Uploads are what force a full rebuild, so mix them with selections.
        await uploadTrack(page, 'gamma-tone.wav');
        await waitForSpectrum(page, TRACK_BINS['gamma-tone.wav']);
        await clickLibraryTrack(page, 'beta-tone');
        await waitForSpectrum(page, TRACK_BINS['beta-tone.wav']);
        await uploadTrack(page, 'delta-tone.wav');
        await waitForSpectrum(page, TRACK_BINS['delta-tone.wav']);

        const state = await snapshot(page);
        assert.equal(state.bodyCanvases, 1, 'only the current canvas is in the document');
        assert.equal(state.canvases, 1, 'nothing else draws a canvas');
        assert.equal(state.connectedMediaSources, 1, 'old media sources were disconnected');
        assert.equal(state.analysersToDestination, 1);
        assert.equal(state.staleRenders, 0, 'no superseded animation loop renders');
        assert.equal(state.webglContexts - state.contextLosses, first.webglContexts,
            'every old WebGL context was explicitly released');
        assert.deepEqual(state.errors, []);

        const guiRoots = await page.evaluate(() => ({
            inPanel: document.querySelectorAll('#camera-settings .dg.main').length,
            anywhere: document.querySelectorAll('.dg.main').length
        }));
        assert.equal(guiRoots.inPanel, 1, 'exactly one GUI inside the settings panel');
        assert.equal(guiRoots.anywhere, 1, 'destroyed GUIs are gone from the document');

        const active = await rendererActivity(page, 500);
        assert.deepEqual(active, [await page.evaluate(() => window.__probe.lastRendererId())]);

        await app.close();
    });
});

describe('narrow layout', () => {
    test('library and settings stay mutually exclusive after switching tracks', async () => {
        const app = await openApp(browser, server.origin, { width: 420, height: 780 });
        const page = app.page;
        await seedLibrary(page, ['alpha-tone.wav', 'beta-tone.wav']);

        // Both panels are closed by default on narrow screens.
        await page.waitForFunction(() => !document.querySelector('#past-songs').open);
        assert.equal(await page.evaluate(() => document.querySelector('#camera-settings').hidden), true);

        await page.click('#library-toggle');
        await page.waitForFunction(() => document.querySelector('#past-songs').open);
        assert.equal(await page.evaluate(() => document.querySelector('#past-songs').matches(':modal')), true);

        // Selecting a library track plays it and closes the library.
        await clickLibraryTrack(page, 'alpha-tone');
        await waitForSpectrum(page, TRACK_BINS['alpha-tone.wav']);
        await page.waitForFunction(() => !document.querySelector('#past-songs').open);

        // Opening settings keeps the library closed.
        await page.click('#settings-toggle');
        await page.waitForFunction(() => !document.querySelector('#camera-settings').hidden);
        assert.equal(await page.evaluate(() => document.querySelector('#past-songs').open), false);

        // Opening the library closes settings.
        await page.click('#library-toggle');
        await page.waitForFunction(() => document.querySelector('#past-songs').open);
        assert.equal(await page.evaluate(() => document.querySelector('#camera-settings').hidden), true);

        // Uploading from that library closes it and keeps only one session.
        await uploadTrack(page, 'beta-tone.wav');
        await waitForSpectrum(page, TRACK_BINS['beta-tone.wav']);
        await page.waitForFunction(() => !document.querySelector('#past-songs').open);
        await assertSingleSession(page, 'narrow upload');
        assert.equal((await page.textContent('#track-title')).trim(), 'beta-tone.wav');

        await app.close();
    });
});
