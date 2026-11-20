// Serves the browser test page, launches headless Chrome against it and
// reports the results. Requires a browser binary; set CHROME_PATH to override
// discovery.
//
// Usage:
//   node test/run-browser-tests.mjs [--keep-open] [--browser <path>]
//
// The runner exits with 0 only when every assertion passes.
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

const args = process.argv.slice(2);
const keepOpen = args.includes('--keep-open');
const browserArgIndex = args.indexOf('--browser');
const explicitBrowser = browserArgIndex !== -1 ? args[browserArgIndex + 1] : null;

const findBrowser = () => {
    if (explicitBrowser) {
        return explicitBrowser;
    }
    if (process.env.CHROME_PATH) {
        return process.env.CHROME_PATH;
    }

    const candidates = [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    // fall back to PATH lookup
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    const names =
        process.platform === 'win32'
            ? ['chrome.exe', 'msedge.exe']
            : ['google-chrome', 'chromium', 'chromium-browser', 'chrome'];
    for (const dir of pathDirs) {
        for (const name of names) {
            const full = path.join(dir, name);
            if (fs.existsSync(full)) {
                return full;
            }
        }
    }

    return null;
};

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/__result') {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            res.writeHead(204).end();
            try {
                onResult(JSON.parse(body));
            } catch (err) {
                console.error('failed to parse test result:', err);
            }
        });
        return;
    }

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') {
        pathname = '/test/index.html';
    }

    const resolved = path.resolve(repoRoot, `.${pathname}`);
    if (!resolved.startsWith(repoRoot)) {
        res.writeHead(403).end('forbidden');
        return;
    }

    let filePath = resolved;
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
    }
    if (!fs.existsSync(filePath)) {
        res.writeHead(404).end(`not found: ${pathname}`);
        return;
    }

    res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
});

let settle;
const finished = new Promise((resolve) => {
    settle = resolve;
});

let chrome = null;
let timeout = null;
let lastResult = null;

const cleanup = () => {
    if (timeout) {
        clearTimeout(timeout);
    }
    if (chrome && !keepOpen) {
        chrome.kill();
    }
    server.close();
};

const onResult = (result) => {
    lastResult = result;
    printResult(result);
    cleanup();
    settle(result);
};

const printResult = (result) => {
    for (const entry of result.results || []) {
        if (entry.ok) {
            console.log(`  \u2713 ${entry.name}`);
        } else {
            console.log(`  \u2717 ${entry.name}`);
            console.log(
                String(entry.error || '')
                    .split('\n')
                    .map((line) => `      ${line}`)
                    .join('\n')
            );
        }
    }
    if (result.fatal) {
        console.log('FATAL:', result.fatal);
    }
    console.log('');
    console.log(`RESULT: ${result.passed} passed, ${result.failed} failed`);
};

server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/test/index.html`;
    console.log(`serving ${repoRoot} at ${url}`);

    const browser = findBrowser();
    if (!browser) {
        console.error(
            'No Chrome/Edge binary found. Install one or set CHROME_PATH (e.g. CHROME_PATH=/path/to/chrome).'
        );
        cleanup();
        process.exitCode = 2;
        settle(null);
        return;
    }

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texture-tool-test-'));
    const chromeArgs = [
        '--headless=new',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--enable-features=Vulkan',
        '--disable-gpu-sandbox',
        `--user-data-dir=${userDataDir}`,
        '--window-size=800,600',
        url
    ];

    console.log(`launching ${browser}`);
    chrome = spawn(browser, chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chromeLog = [];
    chrome.stdout.on('data', (data) => chromeLog.push(data.toString()));
    chrome.stderr.on('data', (data) => chromeLog.push(data.toString()));
    chrome.on('exit', (code) => {
        if (!lastResult) {
            console.error(`browser exited (code ${code}) before reporting results`);
            if (process.env.DEBUG_TEST) {
                console.error(chromeLog.join(''));
            }
            cleanup();
            process.exitCode = 1;
            settle(null);
        }
    });

    timeout = setTimeout(() => {
        if (!lastResult) {
            console.error('timed out waiting for test results');
            if (process.env.DEBUG_TEST) {
                console.error(chromeLog.join(''));
            }
            cleanup();
            process.exitCode = 1;
            settle(null);
        }
    }, 120000);
});

const result = await finished;
if (!result) {
    process.exit(process.exitCode || 1);
}
process.exit(result.failed > 0 ? 1 : 0);
