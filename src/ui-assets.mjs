import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const directory = fileURLToPath(new URL("./ui/dist/client/", import.meta.url));
const assets = new Map();

// Snapshot only generated JS/CSS at startup, like the HTML shell. Requests do
// not resolve arbitrary filesystem paths, and source/data files cannot leak.
function collect(folder, prefix = "") {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) collect(path.join(folder, entry.name), `${name}/`);
    else if (entry.isFile() && /\.(js|css)$/.test(entry.name)) {
      const raw = fs.readFileSync(path.join(folder, entry.name));
      assets.set(`/ui/${name}`, {
        raw,
        gzip: gzipSync(raw, { level: 9 }),
        etag: `"${createHash("sha256").update(raw).digest("hex").slice(0, 24)}"`,
        type: entry.name.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "text/javascript; charset=utf-8",
        cache:
          name === "console-client.js"
            ? "no-cache"
            : "public, max-age=31536000, immutable",
      });
    }
  }
}

if (!fs.existsSync(path.join(directory, "console-client.js"))) {
  throw new Error("缺少 React 客户端构建产物，请先执行 npm run build:ui");
}
collect(directory);

export function serveClientAsset(req, res, pathname) {
  if (!pathname.startsWith("/ui/")) return false;
  const asset = assets.get(pathname);
  if (!asset || !["GET", "HEAD"].includes(req.method)) {
    res.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end("Not found");
    return true;
  }
  const headers = {
    "content-type": asset.type,
    "cache-control": asset.cache,
    "x-content-type-options": "nosniff",
    etag: asset.etag,
    vary: "Accept-Encoding",
  };
  if (req.headers["if-none-match"] === asset.etag) {
    res.writeHead(304, headers);
    res.end();
  } else {
    const gzip = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
    const body = gzip ? asset.gzip : asset.raw;
    res.writeHead(200, {
      ...headers,
      "content-length": body.length,
      ...(gzip ? { "content-encoding": "gzip" } : {}),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }
  return true;
}
