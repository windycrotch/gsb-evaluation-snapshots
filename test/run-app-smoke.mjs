// Smoke test: loads the real built application with ?load=<fixture> and drives
// the actual export button, verifying the downloaded file name follows the URL
// parameter selection. This guards the untouched URL-parameter load path.
//
// Usage: node test/run-app-smoke.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.wasm': 'application/wasm',
    '.map': 'application/json; charset=utf-8'
};

const findBrowser = () => {
    const candidates = [
        process.env.CHROME_PATH,
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
};

// the automation page loads the app in an iframe, overrides downloads, clicks
// the PNG export button and reports the resulting filename
const automationPage = `<!doctype html>
<html><body>
<iframe id="app" style="width:1000px;height:700px;border:0"></iframe>
<pre id="out">pending</pre>
<script>
const done = (payload) => {
    document.getElementById('out').textContent = 'RESULT:' + JSON.stringify(payload);
    fetch('/__result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {});
};
const fail = (message) => done({ ok: false, error: message });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (fn, label, timeout = 20000) => {
    const start = performance.now();
    for (;;) {
        let value;
        try { value = fn(); } catch (err) { value = undefined; }
        if (value) return value;
        if (performance.now() - start > timeout) throw new Error('timed out: ' + label);
        await sleep(50);
    }
};
(async () => {
    try {
        const frame = document.getElementById('app');
        frame.src = '/dist/?load=' + encodeURIComponent('/test/fixtures/avatar.png');
        await new Promise((resolve) => { frame.onload = resolve; });
        const win = frame.contentWindow;
        const doc = frame.contentDocument;

        // intercept downloads inside the app
        const downloads = [];
        const originalClick = win.HTMLAnchorElement.prototype.click;
        const blobUrls = new Map();
        const originalCreate = win.URL.createObjectURL.bind(win.URL);
        win.URL.createObjectURL = (obj) => {
            const url = originalCreate(obj);
            if (obj instanceof win.Blob) blobUrls.set(url, obj);
            return url;
        };
        win.HTMLAnchorElement.prototype.click = function () {
            if (this.download) downloads.push(this.download);
        };

        const findButton = () => Array.from(doc.querySelectorAll('.inspector-button')).find((b) => /EXPORT TO PNG/.test(b.textContent))
            || Array.from(doc.querySelectorAll('.inspector-button')).find((b) => /BUSY/.test(b.textContent));
        const button = await waitFor(findButton, 'PNG export button');
        await waitFor(() => !button.classList.contains('pcui-disabled'), 'PNG button enabled');
        await waitFor(() => doc.querySelector('.file-tab-label') && /avatar\\.png/.test(doc.querySelector('.file-tab-label').textContent), 'texture tab');

        const appErrors = [];
        const origError = win.console.error;
        win.console.error = (...a) => { appErrors.push(a.map(String).join(' ')); origError.apply(win.console, a); };
        button.click();
        await waitFor(() => downloads.length > 0, 'download; errors=' + appErrors.join(' | '), 30000);
        await waitFor(() => /EXPORT TO PNG/.test(button.textContent) && !button.classList.contains('busy-anim'), 'idle button', 30000);

        done({ ok: downloads[0] === 'avatar.png', filename: downloads[0] });
    } catch (err) {
        fail(String(err && err.stack ? err.stack : err));
    }
})();
</script>
</body></html>`;

let settle;
const finished = new Promise((resolve) => {
    settle = resolve;
});

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/__result') {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            res.writeHead(204).end();
            settle(JSON.parse(body));
        });
        return;
    }

    if (url.pathname === '/automation.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(automationPage);
        return;
    }

    let resolved = path.resolve(repoRoot, `.${decodeURIComponent(url.pathname)}`);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        resolved = path.join(resolved, 'index.html');
    }
    if (!resolved.startsWith(repoRoot) || !fs.existsSync(resolved)) {
        res.writeHead(404).end('not found');
        return;
    }

    res.writeHead(200, {
        'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
    });
    fs.createReadStream(resolved).pipe(res);
});

let chrome = null;
let timeout = null;
const cleanup = () => {
    if (timeout) {
        clearTimeout(timeout);
    }
    chrome?.kill();
    server.close();
};

server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const browser = findBrowser();
    if (!browser) {
        console.error('No Chrome/Edge binary found. Set CHROME_PATH.');
        cleanup();
        process.exitCode = 2;
        settle(null);
        return;
    }

    const url = `http://127.0.0.1:${port}/automation.html`;
    console.log(`serving ${repoRoot} at ${url}`);

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texture-tool-smoke-'));
    chrome = spawn(
        browser,
        [
            '--headless=new',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--disable-gpu-sandbox',
            `--user-data-dir=${userDataDir}`,
            url
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const chromeLog = [];
    chrome.stdout.on('data', (d) => chromeLog.push(d.toString()));
    chrome.stderr.on('data', (d) => chromeLog.push(d.toString()));

    timeout = setTimeout(() => {
        console.error('timed out waiting for the smoke result');
        if (process.env.DEBUG_TEST) {
            console.error(chromeLog.join(''));
        }
        cleanup();
        process.exitCode = 1;
        settle(null);
    }, 90000);
});

const result = await finished;
if (!result) {
    process.exit(process.exitCode || 1);
}
cleanup();
if (result.ok) {
    console.log(`  \u2713 app ?load= path exports ${result.filename}`);
    process.exit(0);
}
console.error(`  \u2717 ${result.error || 'unexpected filename ' + result.filename}`);
process.exit(1);
