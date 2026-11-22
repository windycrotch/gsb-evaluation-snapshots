/**
 * Minimal static file server for the built bundle used by the acceptance
 * checks. Serves `dist/` and can be told to fail specific paths.
 */
const http = require("http")
const fs = require("fs")
const path = require("path")

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".map": "application/json",
}

function createServer(rootDir) {
  const state = {
    failing: new Set(),
    hits: new Map(),
    failOnce: new Set(),
    delayMs: 0,
  }

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0])
    const key = urlPath.replace(/^\//, "")
    state.hits.set(key, (state.hits.get(key) || 0) + 1)

    const respond = () => {
      if (key === "favicon.ico") {
        res.writeHead(204)
        res.end()
        return
      }

      if (state.failing.has(key)) {
        res.writeHead(500, { "Content-Type": "text/plain" })
        res.end("simulated failure")
        return
      }

      if (state.failOnce.has(key)) {
        state.failOnce.delete(key)
        res.writeHead(500, { "Content-Type": "text/plain" })
        res.end("simulated one-off failure")
        return
      }

      const relative = key === "" ? "index.html" : key
      const filePath = path.join(rootDir, relative)

      if (!filePath.startsWith(path.resolve(rootDir))) {
        res.writeHead(403)
        res.end("forbidden")
        return
      }

      fs.readFile(filePath, (error, data) => {
        if (error) {
          res.writeHead(404, { "Content-Type": "text/plain" })
          res.end("not found")
          return
        }

        res.writeHead(200, {
          "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
          "Cache-Control": "no-store",
        })
        res.end(data)
      })
    }

    if (state.delayMs > 0) {
      setTimeout(respond, state.delayMs)
    } else {
      respond()
    }
  })

  return {
    state,
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => {
          resolve(`http://127.0.0.1:${server.address().port}`)
        })
      })
    },
    close() {
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

module.exports = { createServer }
