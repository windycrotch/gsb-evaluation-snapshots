/* Test harness: a static file server for the app plus a Chromium fixture.
 *
 * The Firebase CDN SDK and every remote audio URL are intercepted so tests run
 * fully offline with a controllable stub instead of real credentials.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { STUB_SOURCE } = require('./firebase-stub');
const { TRACKS } = require('./audio');

const ROOT = path.resolve(__dirname, '..', '..');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg'
};

function startServer() {
    const server = http.createServer((request, response) => {
        const urlPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);

        // Local tracks so library selection can be told apart by spectrum.
        const audioMatch = /^\/test-audio\/([A-Za-z0-9._-]+\.wav)$/.exec(urlPath);
        if (audioMatch && TRACKS[audioMatch[1]]) {
            response.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' });
            response.end(TRACKS[audioMatch[1]]);
            return;
        }

        const relative = urlPath === '/' ? 'index.html' : urlPath.slice(1);
        const target = path.resolve(ROOT, relative);

        if (!target.startsWith(ROOT)) {
            response.writeHead(403);
            response.end('Forbidden');
            return;
        }

        fs.readFile(target, (error, data) => {
            if (error) {
                response.writeHead(404, { 'content-type': 'text/plain' });
                response.end('Not found');
                return;
            }
            response.writeHead(200, {
                'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
                'cache-control': 'no-store'
            });
            response.end(data);
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const origin = `http://127.0.0.1:${server.address().port}`;
            resolve({
                server,
                origin,
                trackUrl: (name) => `${origin}/test-audio/${name}`,
                close: () => new Promise((done) => server.close(done))
            });
        });
    });
}

async function launchBrowser() {
    return chromium.launch({
        headless: true,
        args: [
            '--autoplay-policy=no-user-gesture-required',
            '--enable-unsafe-swiftshader',
            '--no-sandbox',
            '--mute-audio'
        ]
    });
}

/**
 * Opens the app with the Firebase stub installed and remote audio redirected
 * to a local tone, so nothing leaves the machine.
 */
async function openApp(browser, origin, options) {
    const settings = Object.assign({
        width: 1280,
        height: 800,
        probe: true,
        tracks: TRACKS
    }, options);

    const context = await browser.newContext({ viewport: { width: settings.width, height: settings.height } });
    const page = await context.newPage();
    const consoleMessages = [];
    const pageErrors = [];

    page.on('console', (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
    page.on('pageerror', (error) => pageErrors.push(String(error)));

    // Firebase SDK from the CDN becomes the controllable local stub.
    await context.route('https://www.gstatic.com/firebasejs/**', (route) => {
        route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB_SOURCE });
    });

    // Any remote audio (the default track) is served as a local test tone.
    await context.route('https://firebasestorage.googleapis.com/**', (route) => {
        route.fulfill({ status: 200, contentType: 'audio/wav', body: settings.tracks['alpha-tone.wav'] });
    });

    if (settings.probe) {
        await page.addInitScript({ path: path.join(__dirname, '..', 'fixtures', 'probe.js') });
    }

    await page.goto(`${origin}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => {
        return typeof window.__probe !== 'undefined' && window.__probe.renderers.length > 0;
    });

    return {
        context,
        page,
        consoleMessages,
        pageErrors,
        async close() {
            await context.close();
        }
    };
}

/** Uploads a local tone through the real file input. */
async function uploadTrack(page, trackName, tracks) {
    const files = tracks || TRACKS;
    await page.setInputFiles('#audioFile', {
        name: trackName,
        mimeType: 'audio/wav',
        buffer: files[trackName]
    });
}

/** Clicks a library entry by its visible title. */
async function clickLibraryTrack(page, title) {
    const button = page.locator('#prevSongs button', { hasText: title }).first();
    await button.waitFor({ state: 'visible' });
    await button.click();
}

/**
 * Presses play on the current audio element when it is paused. Selecting a
 * track already starts playback, but this keeps the tests independent of the
 * browser's autoplay policy so they can focus on session lifecycle.
 */
async function ensurePlaying(page) {
    await page.evaluate(async () => {
        const audio = document.querySelector('.audio-container audio');
        if (!audio || !audio.paused) return;
        try {
            await audio.play();
        } catch (error) {
            // Autoplay refusals surface as a paused element; callers wait on
            // the spectrum and fail with a clear message in that case.
        }
    });
}

async function snapshot(page) {
    return page.evaluate(() => window.__probe.snapshot());
}

async function spectrum(page) {
    return page.evaluate(() => window.__probe.spectrum());
}

async function waitForSpectrum(page, bin, timeout) {
    const deadline = Date.now() + (timeout || 8000);
    let last = null;
    while (Date.now() < deadline) {
        await ensurePlaying(page);
        last = await spectrum(page);
        if (last && (bin === undefined || (last.peakBin === bin && last.peakValue > 20))) {
            return last;
        }
        await page.waitForTimeout(120);
    }
    throw new Error(`Timed out waiting for spectrum peak at bin ${bin}; last=${JSON.stringify(last)}`);
}

async function rendererActivity(page, windowMs) {
    return page.evaluate((ms) => window.__probe.activeRendererIds(ms), windowMs || 400);
}

module.exports = {
    startServer,
    launchBrowser,
    openApp,
    uploadTrack,
    clickLibraryTrack,
    ensurePlaying,
    snapshot,
    spectrum,
    waitForSpectrum,
    rendererActivity
};
