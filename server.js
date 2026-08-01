#!/usr/bin/env node
// Zero-install static server for the web version.
//
// Run:  node server.js
// Then open http://localhost:8123
// Everything (TTS engine, video engine, UI) is served from the web/ folder.
//
// A real HTTP server (not a file:// open) is required because the app needs
// COOP/COEP headers for cross-origin isolation (SharedArrayBuffer, threaded
// wasm) — browsers won't grant that to files opened directly from disk.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8123;
const ROOT = path.join(__dirname, "web");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function log(req) {
  console.log(`[${new Date().toISOString()}] ${req.socket.remoteAddress} ${req.method} ${req.url}`);
}

const server = http.createServer((req, res) => {
  log(req);

  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  // Prevent escaping ROOT via "..".
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": stat.size,
      // Allow the wasm/worker assets to be used cross-origin-isolation-free.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`Serving AITAH Video Creator (web) at http://localhost:${PORT}`);
  console.log("Press Ctrl+C to stop.");
});
