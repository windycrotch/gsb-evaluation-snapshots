/*
 * Dependency-free headless runner for tests/acceptance.html.
 *
 * Launches Chrome/Edge directly at the acceptance page and drives it over the
 * DevTools Protocol through --remote-debugging-pipe (stdio fds 3/4). The pipe
 * transport works even when a machine policy or an already-running browser
 * blocks the TCP debugging port, and it needs no packages from npm.
 *
 * Usage:
 *   node tests/run-acceptance.js            # auto-detect Chrome/Edge
 *   node tests/run-acceptance.js <browser>  # explicit executable path
 *
 * The acceptance page itself is fully self-contained and can also be opened
 * directly in a browser. This script only automates it and converts the
 * on-page PASS/FAIL output into a process exit code.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PAGE_URL = new URL('tests/acceptance.html', 'file:///' +
    REPO_ROOT.replace(/\\/g, '/').replace(/^\//, '') + '/').href;
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'music-visualizer-cdp-'));

function findBrowser(explicit) {
    if (explicit) return explicit;
    const candidates = [
        process.env.CHROME_BIN,
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch { /* keep looking */ }
    }
    throw new Error('No Chrome/Edge executable found. Pass the path explicitly: node tests/run-acceptance.js <path>');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Minimal CDP client over the null-byte-delimited JSON pipe. Browser-level
// replies resolve directly; page (session) traffic is exchanged through
// Target.sendMessageToTarget / receivedMessageFromTarget envelopes.
class CdpPipe {
    constructor(child) {
        this.writeEnd = child.stdio[3];
        this.readEnd = child.stdio[4];
        this.nextId = 1;
        this.pending = new Map();
        this.eventListeners = [];
        let buffer = '';
        this.readEnd.on('data', chunk => {
            buffer += chunk.toString();
            let separator;
            while ((separator = buffer.indexOf('\0')) >= 0) {
                const frame = buffer.slice(0, separator);
                buffer = buffer.slice(separator + 1);
                if (frame.trim()) this.dispatch(JSON.parse(frame));
            }
        });
        this.readEnd.on('error', error => this.failAll(error));
    }

    failAll(error) {
        for (const { reject } of this.pending.values()) reject(error);
        this.pending.clear();
    }

    dispatch(rawMessage) {
        if (rawMessage.method === 'Target.receivedMessageFromTarget') {
            const inner = JSON.parse(rawMessage.params.message);
            if (inner.id && this.pending.has(inner.id)) {
                const entry = this.pending.get(inner.id);
                this.pending.delete(inner.id);
                if (inner.error) entry.reject(new Error(inner.error.message));
                else entry.resolve(inner.result);
            } else if (inner.method) {
                this.eventListeners.forEach(listener =>
                    listener({ method: inner.method, params: inner.params }));
            }
            return;
        }
        if (rawMessage.id && this.pending.has(rawMessage.id)) {
            const entry = this.pending.get(rawMessage.id);
            // Session commands get an immediate empty browser-level ack; their
            // real result arrives later inside a receivedMessageFromTarget
            // envelope, so keep the promise pending until that envelope lands.
            if (entry.isSession) {
                if (rawMessage.error) {
                    this.pending.delete(rawMessage.id);
                    entry.reject(new Error(rawMessage.error.message));
                }
                return;
            }
            this.pending.delete(rawMessage.id);
            if (rawMessage.error) entry.reject(new Error(rawMessage.error.message));
            else entry.resolve(rawMessage.result);
            return;
        }
        if (rawMessage.method) {
            this.eventListeners.forEach(listener => listener(rawMessage));
        }
    }

    onEvent(listener) {
        this.eventListeners.push(listener);
    }

    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.writeEnd.write(JSON.stringify({ id, method, params }) + '\0');
        });
    }

    sendToSession(sessionId, method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, isSession: true });
            this.writeEnd.write(JSON.stringify({
                id,
                method: 'Target.sendMessageToTarget',
                params: {
                    sessionId,
                    message: JSON.stringify({ id, method, params })
                }
            }) + '\0');
        });
    }
}

async function main() {
    const browser = findBrowser(process.argv[2]);
    const args = [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--allow-file-access-from-files',
        '--autoplay-policy=no-user-gesture-required',
        '--remote-debugging-pipe',
        '--user-data-dir=' + USER_DATA,
        '--window-size=1280,900',
        PAGE_URL
    ];
    const child = spawn(browser, args, {
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']
    });
    let browserStderr = '';
    child.stderr.on('data', chunk => { browserStderr += chunk; });

    let exitCode = 1;
    try {
        const cdp = new CdpPipe(child);

        const consoleErrors = [];
        const pageExceptions = [];
        cdp.onEvent(message => {
            if (message.method === 'Runtime.consoleAPICalled' &&
                message.params.type === 'error') {
                consoleErrors.push(
                    message.params.args.map(a => a.value || a.description || '').join(' ')
                );
            }
            if (message.method === 'Runtime.exceptionThrown') {
                const details = message.params.exceptionDetails;
                pageExceptions.push(
                    details.exception ? details.exception.description : details.text
                );
            }
        });

        await cdp.send('Target.setDiscoverTargets', { discover: true });

        // The browser was launched at the acceptance page, so attach to that
        // already-existing page target (poll briefly while it registers).
        let pageTarget = null;
        for (let i = 0; i < 40 && !pageTarget; i++) {
            const result = await cdp.send('Target.getTargets');
            pageTarget = result.targetInfos.find(t => t.type === 'page' &&
                t.url && t.url.indexOf('acceptance.html') >= 0);
            if (!pageTarget) await sleep(250);
        }
        if (!pageTarget) throw new Error('Acceptance page target not found');

        const attach = await cdp.send('Target.attachToTarget', {
            targetId: pageTarget.targetId
        });
        const sessionId = attach.sessionId;
        const sendToPage = (method, params = {}) =>
            cdp.sendToSession(sessionId, method, params);
        await sendToPage('Runtime.enable');
        await sendToPage('Page.enable');

        const evaluate = async expression => {
            const result = await sendToPage('Runtime.evaluate', {
                expression,
                returnByValue: true,
                awaitPromise: true
            });
            if (result.exceptionDetails) {
                throw new Error(result.exceptionDetails.exception
                    ? result.exceptionDetails.exception.description
                    : result.exceptionDetails.text);
            }
            return result.result ? result.result.value : undefined;
        };

        // Wait until the runner stamps its completion marker on the body.
        let stats = null;
        let verdict = null;
        for (let i = 0; i < 120; i++) {
            await sleep(500);
            stats = await evaluate(
                'document.body ? document.body.getAttribute("data-acceptance-stats") : null'
            );
            verdict = await evaluate(
                'document.body ? document.body.getAttribute("data-acceptance") : null'
            );
            if (stats && verdict) break;
        }
        if (!stats) throw new Error('Acceptance page did not finish within 60s');

        const output = await evaluate(`[
            document.querySelector('#summary').textContent,
            ...Array.from(document.querySelectorAll('#results div'))
                .map(div => (div.className ? '[' + div.className + '] ' : '') + div.textContent)
        ].join('\\n')`);
        console.log(output);

        if (consoleErrors.length) {
            console.log('\nConsole errors from the app frame:');
            consoleErrors.forEach(e => console.log('  - ' + e));
        }
        if (pageExceptions.length) {
            console.log('\nUncaught exceptions from the app frame:');
            pageExceptions.forEach(e => console.log('  - ' + e));
        }

        exitCode = verdict === 'pass' ? 0 : 1;
        console.log('\nVerdict: ' + verdict.toUpperCase() + ' (' + stats + ')');
    } catch (error) {
        console.error('Runner error: ' + (error.stack || error));
        const relevant = browserStderr
            .split('\n')
            .filter(line => line && !/external_registry_loader|importer|PathService/.test(line))
            .join('\n');
        if (relevant) console.error('Browser stderr:\n' + relevant.slice(-2000));
        exitCode = 1;
    } finally {
        try { child.kill(); } catch { /* already gone */ }
        try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch { /* temp dir */ }
    }
    process.exit(exitCode);
}

main();
