// Zero-dependency static file server for the acceptance harness, because
// Chrome blocks external ES module scripts over file:// (CORS).
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.hdr': 'application/octet-stream',
    '.wasm': 'application/wasm'
};

function startStaticServer(rootDir) {
    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        const filePath = path.normalize(path.join(rootDir, urlPath));
        if (!filePath.startsWith(rootDir)) {
            res.writeHead(403);
            res.end('forbidden');
            return;
        }
        fs.stat(filePath, (err, stat) => {
            if (err || !stat.isFile()) {
                res.writeHead(404);
                res.end('not found');
                return;
            }
            res.writeHead(200, {
                'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream'
            });
            fs.createReadStream(filePath).pipe(res);
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                port: server.address().port,
                close: () =>
                    new Promise((r) => {
                        server.close(r);
                    })
            });
        });
    });
}

module.exports = { startStaticServer };
