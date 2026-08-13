// Scripted round-trip check against a running `node server.js` (or the
// Electron app's own backend) — replaces the throwaway one-off test scripts
// that otherwise get hand-rewritten every session. No new dependencies:
// only Node built-ins, plus the global `fetch`.
//
// Usage:
//   node scripts/smoke-test.js [--port 8123]
//   SLOPDADDY_PORT=8199 node scripts/smoke-test.js
//
// Exits 0 if every check passes (or gracefully skips when a backend isn't
// available), non-zero if anything actually fails — usable as a quick
// regression gate, not just a human-readable log.

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const portArgIdx = process.argv.indexOf("--port");
const PORT = portArgIdx !== -1
  ? parseInt(process.argv[portArgIdx + 1], 10)
  : (parseInt(process.env.SLOPDADDY_PORT, 10) || 8123);
const BASE = `http://localhost:${PORT}`;

let passCount = 0;
let failCount = 0;
function ok(label, detail) {
  passCount++;
  console.log(`✔ ${label}${detail ? " — " + detail : ""}`);
}
function fail(label, detail) {
  failCount++;
  console.log(`✘ ${label}${detail ? " — " + detail : ""}`);
}
function skip(label, reason) {
  console.log(`– ${label} (skipped: ${reason})`);
}

// Same minimal RIFF/WAVE header construction as web/lib/ffmpeg-filters.test.js's
// makeWav() — a real, valid, silent WAV, no external asset needed.
function makeSilentWav(durationSec, sampleRate) {
  sampleRate = sampleRate || 16000;
  const numSamples = Math.round(durationSec * sampleRate);
  const buf = Buffer.alloc(44 + numSamples * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + numSamples * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(numSamples * 2, 40);
  return buf;
}

// Synthesizes a tiny real MP4 via the same `ffmpeg` binary the server itself
// depends on, rather than maintaining a fragile base64-embedded blob.
function makeTinyMp4(dir) {
  const outPath = path.join(dir, "fixture.mp4");
  execFileSync("ffmpeg", [
    "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1",
    "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono",
    "-t", "1", "-pix_fmt", "yuv420p", "-y", outPath,
  ], { stdio: "pipe" });
  return fs.readFileSync(outPath);
}

// Length-prefixed binary frame mirroring renderVideoNatively() in
// web/app.js exactly: [4-byte LE meta length][JSON meta][bg][audio].
function buildRenderBody(meta, bg, audio) {
  const metaBytes = Buffer.from(JSON.stringify(meta), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(metaBytes.length, 0);
  return Buffer.concat([header, metaBytes, bg, audio]);
}

// Plain http.get + manual `data:` line parsing rather than depending on
// Node's still-young global EventSource — same technique used ad hoc
// against this same endpoint earlier in development.
function watchProgress(id, onEvent) {
  const events = [];
  const req = http.get(`${BASE}/render-progress/${id}`, (res) => {
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk.toString();
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const p of parts) {
        const m = /^data: (.*)$/m.exec(p);
        if (m) { try { events.push(JSON.parse(m[1])); } catch (e) { /* ignore malformed tick */ } }
      }
    });
  });
  req.on("error", () => {});
  return { events, close: () => req.destroy() };
}

async function main() {
  console.log(`Smoke-testing ${BASE} ...\n`);

  let renderCap = null;
  try {
    const resp = await fetch(`${BASE}/render-capability`);
    renderCap = await resp.json();
    if (typeof renderCap.available === "boolean" && typeof renderCap.cpuCount === "number") {
      ok("GET /render-capability", `available=${renderCap.available}, cpuCount=${renderCap.cpuCount}`);
    } else {
      fail("GET /render-capability", "unexpected response shape: " + JSON.stringify(renderCap));
    }
  } catch (e) {
    fail("GET /render-capability", e.message);
  }

  try {
    const resp = await fetch(`${BASE}/system-info`);
    const data = await resp.json();
    if (typeof data.cpuCount === "number" && typeof data.ffmpegAvailable === "boolean") {
      ok("GET /system-info", `ffmpeg=${data.ffmpegAvailable}, whisper=${data.whisperAvailable}`);
    } else {
      fail("GET /system-info", "unexpected response shape: " + JSON.stringify(data));
    }
  } catch (e) {
    fail("GET /system-info", e.message);
  }

  let cacheInfoBefore = null;
  try {
    const resp = await fetch(`${BASE}/cache-info`);
    cacheInfoBefore = await resp.json();
    if (typeof cacheInfoBefore.fileCount === "number" && typeof cacheInfoBefore.totalBytes === "number") {
      ok("GET /cache-info", `${cacheInfoBefore.fileCount} files, ${cacheInfoBefore.totalBytes} bytes`);
    } else {
      fail("GET /cache-info", "unexpected response shape: " + JSON.stringify(cacheInfoBefore));
    }
  } catch (e) {
    fail("GET /cache-info", e.message);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slopdaddy-smoke-"));
  try {
    let mp4Bytes = null;
    try {
      mp4Bytes = makeTinyMp4(tmpDir);
    } catch (e) {
      skip("POST /render", "couldn't synthesize a test MP4 (ffmpeg not on PATH?): " + e.message);
    }

    if (mp4Bytes && renderCap && renderCap.available) {
      try {
        const audio = makeSilentWav(1.5);
        const id = crypto.randomUUID();
        const watcher = watchProgress(id);
        await new Promise((r) => setTimeout(r, 200)); // let the SSE connection land before POSTing
        const meta = {
          subs: [], style: { fontSize: 68, textColor: "white", strokeColor: "black", strokeWidth: 3, positionY: 0.55 },
          w: 320, h: 568, fps: 24, bgW: 64, bgH: 64,
          musicVolume: 0.25, hasMusic: false, hasTitleCard: false, titleCard: null,
          bgHash: null, bgCached: false, bgLen: mp4Bytes.length, audioLen: audio.length,
          musicHash: null, musicCached: false, musicLen: 0, titleCardImageLen: 0,
        };
        const body = buildRenderBody(meta, mp4Bytes, audio);
        const resp = await fetch(`${BASE}/render?id=${id}`, { method: "POST", body });
        watcher.close();
        if (!resp.ok) {
          fail("POST /render", `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        } else {
          const out = Buffer.from(await resp.arrayBuffer());
          const sawProgress = watcher.events.some(e => e.phase === "encoding" || e.phase === "done");
          if (out.length > 0 && sawProgress) {
            ok("POST /render", `${out.length} bytes, saw progress ticks: ${watcher.events.map(e => e.phase).join(",")}`);
          } else if (out.length > 0) {
            fail("POST /render", "rendered output but no progress ticks arrived over SSE");
          } else {
            fail("POST /render", "empty response body");
          }
        }
      } catch (e) {
        fail("POST /render", e.message);
      }
    } else if (mp4Bytes) {
      skip("POST /render", "native render backend unavailable on this machine");
    }

    // Cache lifecycle — exercises /cache-asset, /cache-info, /cache-clear
    // together against the same fixture the render check already built.
    if (mp4Bytes && cacheInfoBefore) {
      try {
        const hash = crypto.createHash("sha256").update(mp4Bytes).digest("hex");
        const putResp = await fetch(`${BASE}/cache-asset?hash=${hash}`, { method: "POST", body: mp4Bytes });
        const afterPut = await (await fetch(`${BASE}/cache-info`)).json();
        const grew = afterPut.fileCount === cacheInfoBefore.fileCount + 1;
        const clearResp = await fetch(`${BASE}/cache-clear`, { method: "POST" });
        const afterClear = await (await fetch(`${BASE}/cache-info`)).json();
        if (putResp.ok && grew && clearResp.ok && afterClear.fileCount === 0) {
          ok("Cache lifecycle (/cache-asset, /cache-info, /cache-clear)");
        } else {
          fail("Cache lifecycle", `put.ok=${putResp.ok} grew=${grew} afterClear.fileCount=${afterClear.fileCount}`);
        }
      } catch (e) {
        fail("Cache lifecycle", e.message);
      }
    }

    let transcribeCap = null;
    try {
      const resp = await fetch(`${BASE}/transcribe-capability`);
      transcribeCap = await resp.json();
      if (typeof transcribeCap.available === "boolean") {
        ok("GET /transcribe-capability", `available=${transcribeCap.available}`);
      } else {
        fail("GET /transcribe-capability", "unexpected response shape: " + JSON.stringify(transcribeCap));
      }
    } catch (e) {
      fail("GET /transcribe-capability", e.message);
    }

    if (transcribeCap && transcribeCap.available) {
      try {
        const audio = makeSilentWav(1.5);
        const id = crypto.randomUUID();
        const resp = await fetch(`${BASE}/transcribe?id=${id}&model=tiny.en`, { method: "POST", body: audio });
        if (!resp.ok) {
          fail("POST /transcribe", `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        } else {
          const data = await resp.json();
          if (Array.isArray(data.words)) {
            ok("POST /transcribe", `${data.words.length} words (silence, so 0 is expected)`);
          } else {
            fail("POST /transcribe", "unexpected response shape: " + JSON.stringify(data));
          }
        }
      } catch (e) {
        fail("POST /transcribe", e.message);
      }
    } else if (transcribeCap) {
      skip("POST /transcribe", "native whisper backend unavailable on this machine");
    }

    let pocketTtsCap = null;
    try {
      const resp = await fetch(`${BASE}/pockettts-capability`);
      pocketTtsCap = await resp.json();
      if (typeof pocketTtsCap.available === "boolean") {
        ok("GET /pockettts-capability", `available=${pocketTtsCap.available}`);
      } else {
        fail("GET /pockettts-capability", "unexpected response shape: " + JSON.stringify(pocketTtsCap));
      }
    } catch (e) {
      fail("GET /pockettts-capability", e.message);
    }

    if (pocketTtsCap && pocketTtsCap.available) {
      try {
        const resp = await fetch(`${BASE}/pockettts`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "This is a smoke test.", voice: "english" }),
        });
        if (!resp.ok) {
          fail("POST /pockettts", `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        } else {
          const buf = Buffer.from(await resp.arrayBuffer());
          ok("POST /pockettts", `${buf.length} bytes`);
        }
      } catch (e) {
        fail("POST /pockettts", e.message);
      }
    } else if (pocketTtsCap) {
      skip("POST /pockettts", "pocket-tts (uvx) unavailable on this machine");
    }

    let kokoroNativeCap = null;
    try {
      const resp = await fetch(`${BASE}/kokoro-native-capability`);
      kokoroNativeCap = await resp.json();
      if (typeof kokoroNativeCap.available === "boolean") {
        ok("GET /kokoro-native-capability", `available=${kokoroNativeCap.available}`);
      } else {
        fail("GET /kokoro-native-capability", "unexpected response shape: " + JSON.stringify(kokoroNativeCap));
      }
    } catch (e) {
      fail("GET /kokoro-native-capability", e.message);
    }

    if (kokoroNativeCap && kokoroNativeCap.available) {
      try {
        const resp = await fetch(`${BASE}/kokoro-native`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "This is a smoke test.", voice: "af_heart" }),
        });
        if (!resp.ok) {
          fail("POST /kokoro-native", `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        } else {
          const data = await resp.json();
          if (data.audioBase64 && Array.isArray(data.wordTimings)) {
            ok("POST /kokoro-native", `${data.audioBase64.length} b64 chars, ${data.wordTimings.length} word timings`);
          } else {
            fail("POST /kokoro-native", "unexpected response shape: " + JSON.stringify(Object.keys(data)));
          }
        }
      } catch (e) {
        fail("POST /kokoro-native", e.message);
      }
    } else if (kokoroNativeCap) {
      skip("POST /kokoro-native", "native Kokoro (uvx) unavailable on this machine");
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${passCount} passed, ${failCount} failed.`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Smoke test crashed:", e);
  process.exit(1);
});
