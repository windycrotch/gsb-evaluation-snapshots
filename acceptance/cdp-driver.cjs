// Minimal Chrome DevTools Protocol driver (Node 24 has native WebSocket).
// Launches headless Chrome with SwiftShader WebGL, opens the harness page and
// evaluates async test expressions inside it.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME =
    process.env.CHROME_PATH ||
    'C:/Program Files/Google/Chrome/Application/chrome.exe';

class CdpSession {
    constructor() {
        this.nextId = 1;
        this.pending = new Map();
        this.ws = null;
    }

    async launch(url) {
        const port = 9222 + Math.floor(Math.random() * 500);
        const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'reproject-accept-'));
        this.chrome = spawn(
            CHROME,
            [
                '--headless=new',
                '--disable-gpu',
                '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader',
                '--no-first-run',
                '--no-default-browser-check',
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${userData}`,
                '--window-size=1280,900',
                url
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] }
        );
        this.chrome.stderr.on('data', (d) => {
            const text = d.toString();
            if (!text.includes('external_registry_loader')) {
                this.chromeLog = (this.chromeLog || '') + text;
            }
        });
        this.userData = userData;

        // wait for devtools endpoint
        const versionUrl = `http://127.0.0.1:${port}/json/version`;
        let wsUrl;
        for (let i = 0; i < 60; i++) {
            await new Promise((r) => setTimeout(r, 250));
            try {
                const res = await fetch(versionUrl);
                if (res.ok) {
                    wsUrl = (await res.json()).webSocketDebuggerUrl;
                    break;
                }
            } catch {}
        }
        if (!wsUrl) {
            throw new Error(
                `Chrome devtools endpoint did not come up on port ${port}\n` +
                    `chrome log: ${this.chromeLog || '(empty)'}`
            );
        }

        // create a fresh page target so console/runtime events are ours
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = list.find((t) => t.type === 'page');
        this.ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, { once: true });
            this.ws.addEventListener('error', reject, { once: true });
        });
        this.consoleMessages = [];
        this.pageErrors = [];
        this.ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) {
                    reject(new Error(JSON.stringify(msg.error)));
                } else {
                    resolve(msg.result);
                }
            } else if (msg.method === 'Runtime.consoleAPICalled') {
                const text = (msg.params.args || [])
                    .map((a) => (a.value !== undefined ? String(a.value) : a.description || ''))
                    .join(' ');
                this.consoleMessages.push({ type: msg.params.type, text });
            } else if (msg.method === 'Runtime.exceptionThrown') {
                this.pageErrors.push(
                    msg.params.exceptionDetails.exception?.description ||
                        msg.params.exceptionDetails.text
                );
            }
        });
        await this.send('Runtime.enable');
        await this.send('Log.enable');
    }

    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    // evaluate an async IIFE expression; returns the JSON-serializable result
    async eval(expression) {
        const wrapped = `(async () => { ${expression} })()`;
        const result = await this.send('Runtime.evaluate', {
            expression: wrapped,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true
        });
        if (result.exceptionDetails) {
            const desc =
                result.exceptionDetails.exception?.description || result.exceptionDetails.text;
            throw new Error(desc);
        }
        return result.result.value;
    }

    async waitForTitle(title, timeoutMs = 15000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const res = await this.send('Runtime.evaluate', {
                expression: 'document.title',
                returnByValue: true
            });
            if (res.result.value === title) {
                return;
            }
            await new Promise((r) => setTimeout(r, 200));
        }
        throw new Error(`timed out waiting for title ${title}; errors: ${this.pageErrors.join(' | ')}`);
    }

    close() {
        try {
            this.ws?.close();
        } catch {}
        this.chrome?.kill();
        try {
            fs.rmSync(this.userData, { recursive: true, force: true });
        } catch {}
    }
}

module.exports = { CdpSession };
