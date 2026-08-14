#!/usr/bin/env node
// Static server for the web version, PLUS (new) a native rendering backend.
//
// Run:  node server.js
// Then open http://localhost:8123
// Everything (TTS engine, video engine, UI) is served from the web/ folder.
//
// A real HTTP server (not a file:// open) is required because the app needs
// COOP/COEP headers for cross-origin isolation (SharedArrayBuffer, threaded
// wasm) — browsers won't grant that to files opened directly from disk.
//
// This file used to be pure static serving. It now also exposes a render
// backend that shells out to the user's own installed `ffmpeg` instead of
// ffmpeg.wasm — real native rendering is faster and doesn't hang the way the
// WASM multi-thread core occasionally does. This is purely additive: the
// deployed GitHub Pages build has no server, so it always falls back to the
// original WASM path automatically (see web/app.js's native-probe-then-
// fallback logic) — nothing here changes what that build does.
//
// Deliberately zero npm dependencies itself, matching the rest of this repo
// — the render path reuses web/lib/ffmpeg-filters.js's pure filter-graph
// builders directly via require() (already Node-compatible; that's how its
// own tests run) and only Node builtins (http/fs/path/child_process/crypto)
// otherwise. Also required (not just run as a CLI entrypoint) by
// electron/main.js, which starts this exact same backend in-process for the
// standalone app — everything below runs identically either way.
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

// A GUI-launched macOS app (double-clicked, or `open`ed — as opposed to run
// from an interactive terminal) does NOT inherit the PATH additions from
// the user's shell profile (.zshrc/.zprofile) — it gets whatever launchd's
// own cached session PATH is, which on a freshly-updated or freshly-
// installed-Homebrew machine can be missing /opt/homebrew/bin (or
// /usr/local/bin on Intel) entirely until the next full login/reboot.
// Confirmed live: this exact process's real inherited PATH was just
// "/usr/bin:/bin:/usr/sbin:/sbin" — no Homebrew — causing every
// execFile("ffmpeg"/"whisper", ...) call below to fail with ENOENT even
// though `ffmpeg` and `whisper` were genuinely installed and on PATH for
// every interactive shell on the same machine. child_process.execFile/spawn
// inherit process.env by default, so augmenting it once here (rather than
// passing a custom env to every individual call) fixes every native-backend
// check/spawn in this file at once.
function fixChildProcessPath() {
  const commonBinDirs = [
    "/opt/homebrew/bin", "/opt/homebrew/sbin", // Homebrew, Apple Silicon
    "/usr/local/bin", "/usr/local/sbin",        // Homebrew, Intel; also where many manual installs land
    "/opt/local/bin",                            // MacPorts
  ];
  const existing = (process.env.PATH || "").split(path.delimiter);
  const additions = commonBinDirs.filter(d => !existing.includes(d) && fs.existsSync(d));
  if (additions.length) process.env.PATH = existing.concat(additions).join(path.delimiter);
}
fixChildProcessPath();

// SLOPDADDY_PORT lets a second instance run alongside a live Electron app
// (which binds the default 8123 the same way `node server.js` does) — handy
// for testing a server.js change without quitting the real app first.
const PORT = parseInt(process.env.SLOPDADDY_PORT, 10) || 8123;
// SLOPDADDY_DEBUG logs the real ffmpeg/whisper spawn args and per-request
// status/timing — off by default so normal runs stay quiet.
const DEBUG = !!process.env.SLOPDADDY_DEBUG;
const ROOT = path.join(__dirname, "web");
const FONTS_DIR = path.join(ROOT, "vendor", "fonts");

// ---------- Background/music asset cache ----------
// A bulk batch frequently reuses the exact same background video (or music
// track) across many jobs — "same video for all", or the numbered picker
// cycling through fewer picks than the story count. Without this, every job
// independently re-uploads identical bytes to /render. The client hashes
// each asset (SHA-256, Web Crypto) once per distinct File and only sends
// the full bytes for the first job that needs a given hash; every other job
// just references the hash (meta.bgCached/meta.musicCached) and this server
// copies the already-cached file instead of expecting a fresh upload.
// Wiped on every server start so it can never grow unbounded across app
// launches — within one running session (including across multiple batches)
// it persists and keeps paying off.
const BG_CACHE_DIR = path.join(os.tmpdir(), "slopdaddy-bg-cache");
fs.rmSync(BG_CACHE_DIR, { recursive: true, force: true });
fs.mkdirSync(BG_CACHE_DIR, { recursive: true });

// A real SHA-256 hex digest is always exactly 64 hex chars — the 16..128
// range just gives a little slack. Shared between /cache-asset (which
// already validated this) and writeAssetFile below, which previously
// trusted meta.bgHash/meta.musicHash straight from the client's /render
// request body with no validation at all — an attacker-controlled hash
// there could read arbitrary files back into a render (cached:true, hash
// pointing outside BG_CACHE_DIR via "..") or write the uploaded bytes to an
// arbitrary path (cached:false). Both are only reachable by something that
// can already reach this localhost-bound server, but validating a value
// this cheap to check is worth it regardless.
const ASSET_HASH_RE = /^[0-9a-f]{16,128}$/;

// Writes `filename` into the job's temp `dir`, either by copying a
// previously-cached asset (when `cached` is true — the client is telling us
// it already uploaded these exact bytes for an earlier job in this batch)
// or by writing the freshly-uploaded `bytes` and best-effort persisting a
// copy into the cache keyed by `hash` for any later job that references it.
function writeAssetFile(dir, filename, bytes, hash, cached) {
  const validHash = typeof hash === "string" && ASSET_HASH_RE.test(hash) ? hash : null;
  const cachePath = validHash ? path.join(BG_CACHE_DIR, validHash) : null;
  if (cached) {
    if (!cachePath || !fs.existsSync(cachePath)) {
      throw new Error(`Missing cached asset for hash ${hash} — retry this job to re-upload it.`);
    }
    fs.copyFileSync(cachePath, path.join(dir, filename));
    return;
  }
  fs.writeFileSync(path.join(dir, filename), bytes);
  if (cachePath) {
    try { fs.copyFileSync(path.join(dir, filename), cachePath); } catch (e) { /* best-effort — a failed cache write just means the next job re-uploads */ }
  }
}

const {
  safeColor, buildCaptionCues, buildKaraokeCues, buildDrawtextFilterChain,
  buildAudioFilterChain, buildTitleCardOverlay, applyPlaybackSpeed, parseWavDurationSec,
} = require(path.join(ROOT, "lib", "ffmpeg-filters.js"));
const { CAPTION_FONTS } = require(path.join(ROOT, "lib", "caption-presets.js"));

// ---------- YouTube upload integration ----------
// Persisted to the user's home directory rather than BG_CACHE_DIR (which is
// deliberately wiped on every server start) or Electron's app.getPath
// ("userData") — this file has no Electron dependency (it's also required
// by a plain `node server.js` with no Electron involved at all) and needs to
// survive across restarts, unlike everything else this server persists.
// First piece of secret material this app stores outside the browser's own
// localStorage (where every API key already lives, unencrypted, today) —
//0600 perms are a best-effort improvement on that, not OS-keychain-grade.
const YT_STORE_PATH = path.join(os.homedir(), ".slopdaddy", "youtube-accounts.json");
function loadYoutubeStore() {
  try {
    const raw = fs.readFileSync(YT_STORE_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!data.accounts) data.accounts = [];
    // Migrate the old single-oauthClient/top-level-uploadLog shape (every
    // store on disk before multi-project support) into the new
    // oauthClients list — additive only, never drops an existing account.
    // The migrated client keeps the old top-level uploadLog so today's
    // upload count doesn't reset to zero mid-migration, and every existing
    // account gets tagged with the migrated client's id (they were all
    // necessarily connected under that one client, since there was no
    // other option before).
    if (!data.oauthClients) {
      data.oauthClients = [];
      if (data.oauthClient && data.oauthClient.clientId) {
        const migratedId = crypto.randomUUID();
        data.oauthClients.push({
          id: migratedId,
          label: "Default",
          clientId: data.oauthClient.clientId,
          clientSecret: data.oauthClient.clientSecret,
          uploadLog: Array.isArray(data.uploadLog) ? data.uploadLog : [],
        });
        for (const account of data.accounts) {
          if (!account.oauthClientId) account.oauthClientId = migratedId;
        }
      }
    }
    delete data.oauthClient;
    delete data.uploadLog;
    return data;
  } catch (e) {
    // ENOENT (first run, nothing saved yet) is expected and silent — any
    // other failure means the file EXISTS but is corrupt (e.g. a truncated
    // write from an app kill/crash mid-save, before saveYoutubeStore()
    // wrote atomically) and every connected account is about to silently
    // vanish from the user's perspective with zero indication why. Loud on
    // purpose: there's no way to recover the data at this point, but a
    // silent, invisible wipe is strictly worse than a visible warning.
    if (e.code !== "ENOENT") {
      console.error(`YouTube account store at ${YT_STORE_PATH} exists but failed to load (${e.message}) — treating as empty. Any connected channels will need to be reconnected.`);
    }
    return { oauthClients: [], accounts: [] };
  }
}
// YouTube exposes no real quota-usage API — this is a local, best-effort
// proxy: a timestamp per successful upload, trimmed to the last 2 days
// (only "today" is ever displayed) so the store doesn't grow unbounded
// across months of use. Per-client (per Google Cloud project), not global —
// quota is a property of the PROJECT, not the app as a whole, which is the
// entire point of supporting multiple projects.
function recordYoutubeUpload(store, oauthClientId) {
  const client = store.oauthClients.find(c => c.id === oauthClientId);
  // Reachable if the project was deleted mid-upload (a race: DELETE
  // /youtube-oauth-clients/:id vs. an in-flight upload whose access token
  // was still valid, so ensureFreshAccessToken never re-checked the
  // client exists) — the upload still succeeds on YouTube's side, but
  // there's no client left to record quota against. Log it rather than
  // silently dropping the record with zero diagnostic anywhere.
  if (!client) {
    console.warn(`recordYoutubeUpload: no oauthClient ${oauthClientId} — upload succeeded but wasn't counted against any project's quota.`);
    return;
  }
  const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
  client.uploadLog = (client.uploadLog || []).filter(t => t > cutoff);
  client.uploadLog.push(Date.now());
  saveYoutubeStore(store);
}
function countYoutubeUploadsToday(store, oauthClientId) {
  const client = store.oauthClients.find(c => c.id === oauthClientId);
  if (!client) return 0;
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  return (client.uploadLog || []).filter(t => t >= startOfDay.getTime()).length;
}
// YouTube's default per-project quota (10,000 units/day ÷ 1600 per upload)
// allows roughly 6 uploads/day — used here as a soft, LOCAL heuristic (not
// an authoritative check; Google's real quota could differ) for deciding
// when to prefer a different connection to the same channel under a less-
// used project, before a real 403 quotaExceeded forces the issue.
const YOUTUBE_QUOTA_SOFT_LIMIT = 6;
// The requested account is used as-is unless its project looks to be at
// today's soft limit AND the same real channel (channelId) is ALSO
// connected under a different, less-used project — in which case that
// connection is used instead, silently keeping "upload to channel X"
// working across a quota boundary. Falls back to the originally requested
// account if no better option exists, even if it's over the soft limit —
// a real 403 from Google is a clearer signal than this app refusing
// pre-emptively on its own guess.
function pickAccountForUpload(store, accountId) {
  const requested = store.accounts.find(a => a.id === accountId);
  if (!requested) return null;
  // Resolve each account's client once, shared by both the requested-
  // account check and the alt search below (was two separate lookups
  // per candidate — a bare existence .some() plus countYoutubeUploadsToday's
  // own internal find). Also used to detect an orphaned connection (its
  // project was deleted — DELETE /youtube-oauth-clients/:id deliberately
  // leaves these accounts in place, see that route's comment):
  // countYoutubeUploadsToday returns 0 for a missing client, which would
  // otherwise make a dead connection look like the BEST candidate (or, if
  // it's the REQUESTED account itself, get returned outright before the
  // alt search even runs) and redirect a normally-working upload into a
  // guaranteed "project no longer configured" failure.
  const clientById = new Map(store.oauthClients.map(c => [c.id, c]));
  const hasQuota = (a) => clientById.has(a.oauthClientId) && countYoutubeUploadsToday(store, a.oauthClientId) < YOUTUBE_QUOTA_SOFT_LIMIT;
  if (hasQuota(requested)) return requested;
  const alt = store.accounts.find(a => a.id !== requested.id && a.channelId === requested.channelId && hasQuota(a));
  return alt || requested;
}
function saveYoutubeStore(data) {
  fs.mkdirSync(path.dirname(YT_STORE_PATH), { recursive: true });
  // Write to a temp file then rename over the real path, rather than
  // writing YT_STORE_PATH directly — fs.rename is atomic on both POSIX and
  // NTFS, so a process kill/crash mid-save can only ever leave the OLD file
  // intact or the NEW one fully written, never a half-written/truncated
  // file in between. Without this, an interrupted write (confirmed real:
  // this session killed the app with `pkill -9` many times while debugging
  // OAuth) could corrupt the store, and loadYoutubeStore() would then
  // silently treat every connected account as if it never existed.
  const tmpPath = YT_STORE_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, YT_STORE_PATH);
  try { fs.chmodSync(YT_STORE_PATH, 0o600); } catch (e) { /* best-effort — no-op on platforms without POSIX perms (Windows) */ }
}

// Channel thumbnails are cached locally (not just linked by their remote
// Google CDN URL) so the client can safely draw one into a <canvas> for the
// title card — a cross-origin <img> without CORS headers taints the canvas,
// permanently blocking toDataURL()/toBlob() with a SecurityError. Serving
// the SAME bytes from this app's own origin (localhost) sidesteps that
// entirely. Best-effort: a failed download just means no synced picture,
// same UX as never having uploaded a custom one.
const YT_THUMB_DIR = path.join(path.dirname(YT_STORE_PATH), "thumbnails");
async function downloadYoutubeChannelThumbnail(accountId, url) {
  if (!url) return;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return;
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.mkdirSync(YT_THUMB_DIR, { recursive: true });
    fs.writeFileSync(path.join(YT_THUMB_DIR, accountId + ".jpg"), buf);
  } catch (e) { /* best-effort — cosmetic only */ }
}

// PKCE (RFC 7636) — generated server-side with Node's own crypto so the
// code verifier never has to round-trip through the browser. state ->
// verifier, cleared once the callback consumes it (or left to expire
// naturally if the user abandons the consent flow — a small, self-bounded
// in-memory map, not worth a TTL sweep for a single-user local tool).
const pkceChallenges = new Map();
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function generatePkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

const YOUTUBE_SCOPES = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";
// Google's "Desktop app" OAuth client type uses the loopback IP redirect
// flow (RFC 8252) — confirmed live that its automatic redirect-URI matching
// only recognizes the literal "127.0.0.1", not the "localhost" hostname
// (Google returned Error 400: redirect_uri_mismatch for an otherwise
// correctly-formed request using localhost). Same effective address, but
// Google's matcher is stricter than that.
const YOUTUBE_REDIRECT_URI = `http://127.0.0.1:${PORT}/youtube-oauth-callback`;
// Refresh a bit before the real expiry so a request never races a token
// that's valid when checked but expired by the time it reaches Google.
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;

async function exchangeYoutubeCode(oauthClient, code, verifier, redirectUri) {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: oauthClient.clientId,
      client_secret: oauthClient.clientSecret,
      code, redirect_uri: redirectUri,
      code_verifier: verifier,
      grant_type: "authorization_code",
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error_description || data.error || `Token exchange failed (${resp.status})`);
  return data; // {access_token, refresh_token, expires_in, ...}
}

async function refreshYoutubeToken(oauthClient, refreshToken) {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: oauthClient.clientId,
      client_secret: oauthClient.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error_description || data.error || `Token refresh failed (${resp.status})`);
  return data; // {access_token, expires_in, ...} — no new refresh_token on a plain refresh
}

// Ensures `account` (an entry from store.accounts) has a currently-valid
// access token, refreshing and persisting it first if needed. Mutates the
// passed-in store's matching account object and returns the access token —
// callers must saveYoutubeStore(store) themselves once they're done using
// it, same as every other mutate-then-save flow in this file.
async function ensureFreshAccessToken(store, account) {
  if (account.accessToken && account.accessTokenExpiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS) {
    return account.accessToken;
  }
  const client = store.oauthClients.find(c => c.id === account.oauthClientId);
  if (!client) throw new Error("This account's OAuth project is no longer configured — reconnect it from Settings.");
  const refreshed = await refreshYoutubeToken(client, account.refreshToken);
  account.accessToken = refreshed.access_token;
  account.accessTokenExpiresAt = Date.now() + (refreshed.expires_in || 3600) * 1000;
  saveYoutubeStore(store);
  return account.accessToken;
}

async function fetchYoutubeChannel(accessToken) {
  const resp = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error((data.error && data.error.message) || `Channel lookup failed (${resp.status})`);
  const channel = data.items && data.items[0];
  if (!channel) throw new Error("No YouTube channel found on this Google account.");
  return {
    channelId: channel.id,
    channelTitle: channel.snippet.title,
    channelThumbnail: (channel.snippet.thumbnails && (channel.snippet.thumbnails.default || {}).url) || null,
  };
}

function stripTokens(account, store) {
  const { accessToken, refreshToken, ...rest } = account;
  // Always report the locally-cached, same-origin copy (see
  // downloadYoutubeChannelThumbnail) instead of account.channelThumbnail's
  // raw Google CDN URL — that field is kept on the account only for
  // reference/debugging, never sent to the client.
  const cachedPath = path.join(YT_THUMB_DIR, account.id + ".jpg");
  rest.channelThumbnail = fs.existsSync(cachedPath) ? `/youtube-account-thumbnail/${account.id}` : null;
  // Lets the client tell apart two connections to the same channel under
  // different projects (see pickAccountForUpload) in the account picker —
  // "Slop Daddy Stories (Project 2)" instead of two identical-looking rows.
  if (store) {
    const client = store.oauthClients.find(c => c.id === account.oauthClientId);
    rest.oauthClientLabel = client ? client.label : null;
  }
  return rest;
}

function oauthCallbackPage(message, ok) {
  return `<!doctype html><html><head><title>Slopdaddy</title></head><body style="font-family:sans-serif;text-align:center;padding-top:80px;">
  <h2>${ok ? "✓ Signed in" : "✗ Sign-in failed"}</h2>
  <p>${message}</p>
  <p style="color:#888;">You can close this tab and go back to Slopdaddy.</p>
  </body></html>`;
}

// ---------- ffmpeg availability ----------
// Not just "does `ffmpeg` exist" — captions are burned in via the drawtext
// filter, which needs ffmpeg built with libfreetype. Plenty of real ffmpeg
// installs (confirmed on this exact machine's homebrew build) omit it, so
// checking `-version` alone would report "available" and then fail every
// single render with an opaque "No such filter" error. Treat "no drawtext"
// the same as "no ffmpeg" — /render-capability reports unavailable either
// way, and the client falls back to the WASM path automatically, which
// bundles its own drawtext-capable ffmpeg core.
let ffmpegAvailable = null; // null = not checked yet, else boolean
function checkFfmpeg(cb) {
  if (ffmpegAvailable !== null) { cb(ffmpegAvailable); return; }
  // A timeout, not just error handling — execFile's callback never fires at
  // all if the child process hangs (e.g. a broken install stuck prompting
  // for input), which would otherwise leave every route gated behind this
  // check hanging indefinitely for that request.
  execFile("ffmpeg", ["-filters"], { timeout: 5000 }, (err, stdout) => {
    // A timeout (err.killed) just means THIS check didn't finish in time —
    // e.g. the machine was under heavy load right as the process started —
    // it says nothing about whether ffmpeg itself is actually usable.
    // Caching that as a permanent `false` (as this used to) silently hid the
    // whole Performance section and native rendering for the rest of the
    // server's lifetime, with no self-healing short of a manual Debug-tab
    // Recheck or an app restart. Only a check that actually RAN — and either
    // errored for a real reason (e.g. ENOENT, ffmpeg not installed) or
    // completed without drawtext support — represents a stable fact worth
    // caching.
    if (err && err.killed) { cb(false); return; }
    ffmpegAvailable = !err && /drawtext/.test(stdout || "");
    cb(ffmpegAvailable);
  });
}

// ---------- whisper availability ----------
// Same shape as checkFfmpeg — cached, and checks for a specific capability
// (word_timestamps support showing up in --help) rather than just "does a
// binary named `whisper` exist", so an ancient/incompatible install reports
// unavailable instead of failing every single transcription request.
let whisperAvailable = null; // null = not checked yet, else boolean
function checkWhisper(cb) {
  if (whisperAvailable !== null) { cb(whisperAvailable); return; }
  execFile("whisper", ["--help"], { timeout: 5000 }, (err, stdout) => {
    // See checkFfmpeg's matching comment — a timeout is transient (system
    // load, not a real "not installed"/"too old" answer), so it isn't
    // cached, letting the next call re-check for real.
    if (err && err.killed) { cb(false); return; }
    whisperAvailable = !err && /word_timestamps/.test(stdout || "");
    cb(whisperAvailable);
  });
}

// ---------- PocketTTS availability ----------
// Kyutai's Pocket TTS (https://github.com/kyutai-labs/pocket-tts) — a small
// (100M param) CPU-only TTS model, no browser build, so it's a native
// backend like whisper rather than an in-browser engine like Piper/Kokoro.
// Shelled out via `uvx pocket-tts` (not a bare `pocket-tts` binary) since
// that's the package's own documented zero-install invocation via uv —
// confirmed live: `uvx pocket-tts --help` downloads/caches the package on
// first run (a few seconds) and is near-instant on every run after.
let pocketTtsAvailable = null; // null = not checked yet, else boolean
function checkPocketTts(cb) {
  if (pocketTtsAvailable !== null) { cb(pocketTtsAvailable); return; }
  // Longer timeout than checkFfmpeg/checkWhisper — uvx downloads/caches the
  // package on first run, which genuinely takes a few real seconds.
  execFile("uvx", ["pocket-tts", "--help"], { timeout: 20000 }, (err, stdout) => {
    // See checkFfmpeg's matching comment — don't let a transient timeout
    // (system load, or a slow first-run package download taking a bit
    // longer than usual) get cached as a permanent "not installed".
    if (err && err.killed) { cb(false); return; }
    pocketTtsAvailable = !err && /generate/.test(stdout || "");
    cb(pocketTtsAvailable);
  });
}

// ---------- native Kokoro (Python) availability ----------
// The browser's Kokoro (kokoro-js/ONNX, see web/lib/tts-engines.js) never
// returns real per-word timestamps — every generation falls through to the
// VAD-estimate/native-Whisper caption-sync cascade instead. The official
// Python `kokoro` package (hexgrad/Kokoro-82M) DOES expose real per-token
// start_ts/end_ts derived straight from the model's own synthesis, via its
// KPipeline — confirmed live (see scripts/kokoro_native.py). No official CLI
// exists, so this shells out to a small bundled Python script via `uvx`
// instead, same "no native app dependency baked in" shape as PocketTTS.
// Checking availability just imports the package — doesn't trigger a model
// download, which only happens lazily on the first real KPipeline() call.
let kokoroNativeAvailable = null; // null = not checked yet, else boolean
// Shared with runNativeKokoro's own spawn args below — one place to update
// if scripts/kokoro_native.py's real dependencies ever change, instead of
// two independently-maintained copies drifting apart.
const KOKORO_NATIVE_WITH_ARGS = ["--with", "kokoro", "--with", "soundfile"];
function checkKokoroNative(cb) {
  if (kokoroNativeAvailable !== null) { cb(kokoroNativeAvailable); return; }
  // Long timeout — uvx resolves/installs kokoro + its dependencies (torch,
  // spacy, transformers, ...) on first run, which is genuinely slow.
  // Imports soundfile/numpy too, not just kokoro — scripts/kokoro_native.py
  // needs all three at real invocation time (soundfile especially needs a
  // real libsndfile binary dependency on some platforms), so a check that
  // only exercised "import kokoro" could report available:true while a
  // real generation still fails on a missing soundfile install.
  execFile("uvx", [...KOKORO_NATIVE_WITH_ARGS, "python3", "-c", "import kokoro, soundfile, numpy"], { timeout: 60000 }, (err) => {
    if (err && err.killed) { cb(false); return; }
    kokoroNativeAvailable = !err;
    cb(kokoroNativeAvailable);
  });
}

// ---------- concurrency limiter ----------
// Mirrors FFmpegWorkerPool's job (web/worker-pool.js) for native processes —
// batch "Generate All" can fire off several renders (and now transcriptions)
// at once; cap how many real subprocesses of a given kind run concurrently.
// Rendering (ffmpeg) and transcription (whisper, CPU/PyTorch-heavy) are
// different resource profiles, so each kind gets its own independent limiter
// rather than sharing one pool — a render and a transcribe can run at once
// without either starving the other's queue.
//
// max is mutable (setMax) rather than fixed at construction — the client can
// raise or lower it at runtime via POST /performance-settings (Settings ->
// Performance), so a batch already queued respects a change immediately
// rather than needing a server restart.
// Every runNative* function below spawns a subprocess and wires both
// proc.on("error") and proc.on("close") to send an HTTP response — but a
// genuine spawn failure (ENOENT, EACCES, EMFILE) fires BOTH events for the
// same process, and calling respond() twice throws ERR_HTTP_HEADERS_SENT on
// the second call. Wraps one or more response functions so only the first
// call across all of them actually fires — pass every response function a
// given route can call (e.g. runNativeRender's respond AND respondFile,
// which represent the same "have we replied yet" state and must share one
// guard) and use the returned wrappers in place of the originals.
function onceAcrossAll(...fns) {
  let called = false;
  return fns.map(fn => (...args) => {
    if (called) return;
    called = true;
    return fn(...args);
  });
}

function makeSlotLimiter(max) {
  let active = 0;
  const queue = [];
  const state = { max };
  return {
    acquire() {
      return new Promise((resolve) => {
        const tryAcquire = () => {
          if (active < state.max) { active++; resolve(); }
          else queue.push(tryAcquire);
        };
        tryAcquire();
      });
    },
    release() {
      active--;
      const next = queue.shift();
      if (next) next();
    },
    setMax(n) {
      state.max = n;
      // A raised cap may free up waiters immediately.
      while (active < state.max && queue.length) queue.shift()();
    },
    getMax() { return state.max; },
    getActive() { return active; },
  };
}
// Default to every core — the user explicitly wants max resource usage by
// default; Settings -> Performance lets them dial back to leave headroom for
// the OS/UI if a full-throttle batch render makes the machine unresponsive.
const CPU_COUNT = os.cpus().length;
const renderLimiter = makeSlotLimiter(CPU_COUNT);
const transcribeLimiter = makeSlotLimiter(CPU_COUNT);
const pocketTtsLimiter = makeSlotLimiter(CPU_COUNT);
const kokoroNativeLimiter = makeSlotLimiter(CPU_COUNT);
// Deliberately small and NOT tied to CPU_COUNT like the others — this limits
// concurrent HTTP upload requests, not CPU-bound local work, and YouTube's
// default quota (10,000 units/day, 1600 per upload) allows roughly 6
// uploads/day regardless — more concurrency here wouldn't help against a
// fixed daily budget, it'd just make hitting quotaExceeded happen faster.
const youtubeUploadLimiter = makeSlotLimiter(2);
function clampConcurrency(n) {
  n = parseInt(n, 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(CPU_COUNT, n));
}
// Per-job thread budget: divide the core count across however many jobs of
// that kind are currently allowed to run at once, so N concurrent renders
// together target ~100% of cores instead of each auto-detecting and
// fighting the others for every core (ffmpeg/whisper both default to
// "use all cores" when no thread count is given).
function threadBudget(limiter) {
  return Math.max(1, Math.floor(CPU_COUNT / limiter.getMax()));
}

// ---------- SSE progress channels ----------
// Keyed by a client-generated render id: the client opens an SSE connection
// on /render-progress/:id BEFORE posting the binary payload to /render, so
// the id correlates the two requests. Plain Node http, no ws/sse library.
const progressChannels = new Map();
function sendProgress(id, data) {
  const res = progressChannels.get(id);
  if (res) res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function closeProgressChannel(id) {
  const res = progressChannels.get(id);
  if (res) { res.end(); progressChannels.delete(id); }
}

// Caps how much of a request body this server will buffer into memory
// before giving up — this app legitimately deals in large video files, so
// the limits are generous, not restrictive for real use; they exist so a
// misbehaving/unbounded client stream can't grow the process's memory
// without limit. Destroys the connection and responds 413 once exceeded,
// rather than continuing to buffer.
function readBodyWithLimit(req, res, maxBytes, cb) {
  const chunks = [];
  let total = 0;
  let rejected = false;
  req.on("data", (c) => {
    if (rejected) return;
    total += c.length;
    if (total > maxBytes) {
      rejected = true;
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Request body exceeds the ${maxBytes}-byte limit for this route` }));
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => { if (!rejected) cb(Buffer.concat(chunks)); });
}

// ---------- binary request framing ----------
// No multipart parser (zero dependencies) — a simple length-prefixed frame
// instead: [4 bytes LE uint32: JSON metadata length][JSON metadata][bg
// bytes][audio bytes][music bytes if meta.hasMusic][title-card PNG bytes if
// meta.hasTitleCard]. Metadata carries each segment's byte length plus every
// non-binary field runJob already sends to the WASM worker (subs, style,
// w/h/fps, bgW/bgH, musicVolume, titleCard timing). Mirrors web/app.js's
// renderVideoNatively(), which builds this exact frame client-side.
function parseRenderBody(body) {
  if (body.length < 4) throw new Error("Body too short to contain a metadata length header");
  const metaLen = body.readUInt32LE(0);
  if (4 + metaLen > body.length) throw new Error("Metadata length exceeds body size");
  const meta = JSON.parse(body.subarray(4, 4 + metaLen).toString("utf8"));
  let offset = 4 + metaLen;
  // Buffer.subarray clamps out-of-range indices instead of throwing, so a
  // mismatched *Len field would otherwise silently hand buildRenderArgs a
  // truncated/empty segment instead of a clear error here — check the
  // expected total length up front instead.
  const expectedLen = offset + (meta.bgLen || 0) + (meta.audioLen || 0)
    + (meta.hasMusic ? (meta.musicLen || 0) : 0)
    + (meta.hasTitleCard ? (meta.titleCardImageLen || 0) : 0);
  if (!Number.isFinite(expectedLen) || expectedLen > body.length) {
    throw new Error("Segment lengths in metadata don't match the request body size");
  }
  const bg = body.subarray(offset, offset + meta.bgLen); offset += meta.bgLen;
  const audio = body.subarray(offset, offset + meta.audioLen); offset += meta.audioLen;
  let music = null, titleCardImage = null;
  if (meta.hasMusic) { music = body.subarray(offset, offset + meta.musicLen); offset += meta.musicLen; }
  if (meta.hasTitleCard) { titleCardImage = body.subarray(offset, offset + meta.titleCardImageLen); offset += meta.titleCardImageLen; }
  return { meta, bg, audio, music, titleCardImage };
}

// Same length-prefixed framing as parseRenderBody, simpler shape: [4 bytes
// LE uint32: JSON metadata length][JSON metadata][video bytes][thumbnail
// bytes if meta.hasThumbnail].
function parseYoutubeUploadBody(body) {
  if (body.length < 4) throw new Error("Body too short to contain a metadata length header");
  const metaLen = body.readUInt32LE(0);
  if (4 + metaLen > body.length) throw new Error("Metadata length exceeds body size");
  const meta = JSON.parse(body.subarray(4, 4 + metaLen).toString("utf8"));
  let offset = 4 + metaLen;
  const expectedLen = offset + (meta.videoLen || 0) + (meta.hasThumbnail ? (meta.thumbnailLen || 0) : 0);
  if (!Number.isFinite(expectedLen) || expectedLen > body.length) {
    throw new Error("Segment lengths in metadata don't match the request body size");
  }
  const video = body.subarray(offset, offset + meta.videoLen); offset += meta.videoLen;
  let thumbnail = null;
  if (meta.hasThumbnail) { thumbnail = body.subarray(offset, offset + meta.thumbnailLen); offset += meta.thumbnailLen; }
  return { meta, video, thumbnail };
}

// Asks YouTube where an interrupted resumable upload actually left off
// (a status-check PUT with no body and an open-ended Content-Range) rather
// than blindly resuming from wherever this process last thought it was —
// the two can disagree if a chunk's response was lost after Google already
// received it.
async function queryYoutubeResumeOffset(uploadUrl, total) {
  const resp = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Range": `bytes */${total}` } });
  if (resp.status === 308) {
    const range = resp.headers.get("range"); // "bytes=0-8388607"
    return range ? parseInt(range.split("-")[1], 10) + 1 : 0;
  }
  throw new Error(`Could not determine resume offset after a dropped connection (status ${resp.status})`);
}

// Resumable upload per YouTube's documented protocol: an init POST to get a
// per-upload URL, then chunked PUTs with Content-Range headers. A dropped
// connection mid-chunk queries Google for the real byte offset instead of
// restarting the whole upload. Scheduling note: `status.publishAt` requires
// `status.privacyStatus: "private"` per YouTube's own API rules — a
// scheduled video literally can't be unlisted/public until it publishes.
async function runYoutubeUpload(id, store, account, video, thumbnail, meta, respond) {
  try {
    const accessToken = await ensureFreshAccessToken(store, account);
    const isScheduled = !!meta.scheduledAt;
    const snippet = {
      title: meta.title || "Untitled", description: meta.description || "",
      tags: Array.isArray(meta.tags) ? meta.tags : [], categoryId: meta.categoryId || "24",
    };
    const status = isScheduled
      ? { privacyStatus: "private", publishAt: meta.scheduledAt, selfDeclaredMadeForKids: false }
      : { privacyStatus: meta.privacyStatus || "private", selfDeclaredMadeForKids: false };

    sendProgress(id, { phase: "initializing", pct: 0 });
    const initResp = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "video/mp4",
        "X-Upload-Content-Length": String(video.length),
      },
      body: JSON.stringify({ snippet, status }),
    });
    if (!initResp.ok) {
      const errData = await initResp.json().catch(() => ({}));
      throw new Error((errData.error && errData.error.message) || `Upload init failed (${initResp.status})`);
    }
    const uploadUrl = initResp.headers.get("location");
    if (!uploadUrl) throw new Error("YouTube didn't return a resumable upload URL.");

    const total = video.length;
    const CHUNK_SIZE = 8 * 1024 * 1024;
    let offset = 0;
    let videoId = null;
    while (offset < total) {
      const end = Math.min(offset + CHUNK_SIZE, total) - 1;
      let putResp;
      try {
        putResp = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Length": String(end - offset + 1), "Content-Range": `bytes ${offset}-${end}/${total}` },
          body: video.subarray(offset, end + 1),
        });
      } catch (netErr) {
        offset = await queryYoutubeResumeOffset(uploadUrl, total);
        sendProgress(id, { phase: "uploading", pct: Math.round((offset / total) * 100) });
        continue;
      }
      if (putResp.status === 308) {
        const range = putResp.headers.get("range");
        offset = range ? parseInt(range.split("-")[1], 10) + 1 : end + 1;
        sendProgress(id, { phase: "uploading", pct: Math.round((offset / total) * 100) });
        continue;
      }
      if (putResp.status === 200 || putResp.status === 201) {
        const data = await putResp.json();
        videoId = data.id;
        sendProgress(id, { phase: "uploading", pct: 100 });
        break;
      }
      const errBody = await putResp.text().catch(() => "");
      throw new Error(`Upload chunk failed (${putResp.status}): ${errBody.slice(0, 300)}`);
    }
    if (!videoId) throw new Error("Upload finished without a video id.");

    if (thumbnail && thumbnail.length) {
      sendProgress(id, { phase: "thumbnail", pct: 100 });
      try {
        const thumbResp = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
          method: "POST",
          // Must match the actual bytes — a Regenerate is always our own
          // canvas.toBlob() PNG, but "Upload Custom..." can be a JPEG.
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": meta.thumbnailMimeType || "image/png" },
          body: thumbnail,
        });
        // Non-fatal — the video itself uploaded fine either way.
        if (!thumbResp.ok) console.warn("YouTube thumbnail upload failed:", thumbResp.status);
      } catch (e) { console.warn("YouTube thumbnail upload error:", e.message); }
    }

    recordYoutubeUpload(store, account.oauthClientId);
    sendProgress(id, { phase: "done", pct: 100, videoId });
    // account may differ from the account meta.accountId originally
    // requested — pickAccountForUpload silently substitutes a different
    // project's connection to the same channel when the requested one is
    // near today's soft quota limit. Surface that here so the client can
    // tell the user what actually happened instead of it being invisible.
    const usedClient = store.oauthClients.find(c => c.id === account.oauthClientId);
    respond(200, {
      videoId, status: isScheduled ? "scheduled" : "uploaded",
      switchedProject: account.id !== meta.accountId,
      oauthClientLabel: usedClient ? usedClient.label : null,
    });
  } catch (e) {
    sendProgress(id, { phase: "error", error: e.message });
    respond(500, { error: e.message });
  } finally {
    closeProgressChannel(id);
  }
}

// `parseInt(x) || default` silently replaces a legitimate 0 (no stroke, no
// shadow offset) with the fallback, since 0 is falsy — mirrors web/app.js's
// numOr(), which the client already uses when building this same `style`
// object, so a 0 the client correctly preserved doesn't get clobbered again
// once it reaches this second, independent parse on the server side.
function numOr(raw, parseFn, fallback) {
  const n = parseFn(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Builds the exact same filter-graph/args ffmpeg-worker.js constructs for
// the WASM path (see that file's `self.onmessage` "render" case) — only the
// exec mechanism differs (child_process vs ffmpeg.wasm's FS+exec). Writes
// inputs into `dir` and returns the full ffmpeg CLI args array plus the
// expected total output duration (for progress-percentage math).
function buildRenderArgs(dir, meta, bg, audio, music, titleCardImage) {
  writeAssetFile(dir, "bg.mp4", bg, meta.bgHash, meta.bgCached);
  fs.writeFileSync(path.join(dir, "audio.wav"), audio);
  const hasMusic = !!music;
  const hasTitleCard = !!titleCardImage;
  const cardDurationSec = hasTitleCard ? (meta.titleCard.cardDurationSec || 0) : 0;
  const narrationDelaySec = hasTitleCard ? (meta.titleCard.narrationDelaySec || 0) : 0;
  if (hasMusic) writeAssetFile(dir, "music.mp3", music, meta.musicHash, meta.musicCached);
  if (hasTitleCard) fs.writeFileSync(path.join(dir, "titlecard.png"), titleCardImage);

  const style = meta.style || {};
  // fontId -> real filename is already resolved client-side (app.js, the
  // one place both the native and WASM render calls originate from) so both
  // backends receive an already-usable fontFile — validated against
  // CAPTION_FONTS (not just filename shape) since that's the actual list of
  // files present in FONTS_DIR to copy from.
  const fontFile = CAPTION_FONTS.some(f => f.file === style.fontFile) ? style.fontFile : "DejaVuSans.ttf";
  const grouping = style.captionGrouping || "phrase";

  // Only the selected font ever gets referenced by drawtext — copy just that
  // one file into the render dir instead of all vendored fonts.
  fs.mkdirSync(path.join(dir, "fonts"));
  fs.copyFileSync(path.join(FONTS_DIR, fontFile), path.join(dir, "fonts", fontFile));
  const cues = grouping === "karaoke"
    ? buildKaraokeCues(meta.karaokeGroups || [], !!style.uppercase)
    : buildCaptionCues(meta.subs || [], !!style.uppercase);
  for (const cue of cues) fs.writeFileSync(path.join(dir, cue.file), cue.text);
  let { filterComplex: videoFC, outLabel: videoOutLabel } = buildDrawtextFilterChain({
    w: meta.w, h: meta.h, bgW: meta.bgW, bgH: meta.bgH,
    fontFile,
    fontSize: numOr(style.fontSize, parseInt, 68),
    textColor: safeColor(style.textColor, "white"),
    strokeColor: safeColor(style.strokeColor, "black"),
    strokeWidth: numOr(style.strokeWidth, parseInt, 3),
    positionY: numOr(style.positionY, parseFloat, 0.55),
    highlightColor: safeColor(style.highlightColor, "yellow"),
    box: !!style.box,
    boxColor: safeColor(style.boxColor, "black"),
    boxAlpha: numOr(style.boxAlpha, parseFloat, 0.5),
    boxBorderW: numOr(style.boxBorderW, parseInt, 16),
    boxBevel: Math.max(0, Math.min(20, numOr(style.boxBevel, parseInt, 0))),
    shadow: !!style.shadow,
    shadowColor: safeColor(style.shadowColor, "black"),
    shadowX: numOr(style.shadowX, parseInt, 2),
    shadowY: numOr(style.shadowY, parseInt, 2),
    entrance: ["none", "fade", "pop"].includes(style.entrance) ? style.entrance : "none",
    grouping,
    cues,
  });

  let nextInput = 2;
  const musicInputIndex = hasMusic ? nextInput++ : null;
  const titleCardInputIndex = hasTitleCard ? nextInput++ : null;

  if (hasTitleCard) {
    const overlay = buildTitleCardOverlay({
      videoFilterComplex: videoFC, videoOutLabel,
      w: meta.w, h: meta.h, titleCardInputIndex, cardDurationSec,
    });
    videoFC = overlay.filterComplex;
    videoOutLabel = overlay.outLabel;
  }
  let audioChain = buildAudioFilterChain({
    narrationInputIndex: 1, musicInputIndex, musicVolume: meta.musicVolume, delaySec: narrationDelaySec,
  });
  const speed = Math.max(1, Math.min(2, numOr(meta.speed, parseFloat, 1)));
  if (speed !== 1) {
    const sped = applyPlaybackSpeed({
      videoFilterComplex: videoFC, videoOutLabel, audioFilterChain: audioChain.filterChain, audioOutLabel: audioChain.outLabel, speed,
    });
    videoFC = sped.videoFilterComplex; videoOutLabel = sped.videoOutLabel;
    audioChain = { filterChain: sped.audioFilterChain, outLabel: sped.audioOutLabel };
  }
  const filterComplex = `${videoFC};${audioChain.filterChain}`;

  const inputArgs = ["-stream_loop", "-1", "-i", "bg.mp4", "-i", "audio.wav"];
  if (hasMusic) inputArgs.push("-i", "music.mp3");
  if (hasTitleCard) {
    inputArgs.push("-loop", "1", "-framerate", String(meta.fps), "-t", String(cardDurationSec + 1), "-i", "titlecard.png");
  }

  const durationArgs = [];
  let expectedDurationSec = parseWavDurationSec(audio) || 0;
  if (hasTitleCard) {
    const narrDurationSec = parseWavDurationSec(audio);
    if (narrDurationSec) {
      const bound = cardDurationSec + narrDurationSec + 0.5;
      // Left in original (pre-speed) terms deliberately — this is only a
      // safety cap against the infinitely-looped background outrunning
      // -shortest, not the real stopping point (the sped-up audio stream's
      // own genuinely-shorter duration is), so being a bit generous here is
      // harmless; being too tight would risk cutting content short.
      durationArgs.push("-t", bound.toFixed(3));
      expectedDurationSec = bound;
    }
  }
  // Progress pct (below) is measured against the OUTPUT stream's own
  // out_time_ms, which after atempo/setpts only runs up to the now-shorter
  // real duration — divide the expectation to match, or progress would
  // under-report and look stuck for the last stretch of every sped-up render.
  if (speed !== 1) expectedDurationSec = expectedDurationSec / speed;

  // Explicit thread budget (see threadBudget() above) rather than leaving
  // -threads/-filter_complex_threads unset — unset means "auto-detect and
  // use every core", which is fine for a single render but means N
  // concurrent renders all fight over the same cores instead of sharing them.
  const threads = String(threadBudget(renderLimiter));
  const args = [
    ...inputArgs,
    "-filter_complex_threads", threads,
    "-filter_complex", filterComplex,
    "-map", `[${videoOutLabel}]`, "-map", `[${audioChain.outLabel}]`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", String(meta.crf || 23), "-threads", threads,
    "-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p",
    "-r", String(meta.fps),
    "-shortest", ...durationArgs,
    "-progress", "pipe:1", "-y", "out.mp4",
  ];
  return { args, expectedDurationSec, threads: parseInt(threads, 10) };
}

// ffmpeg's `-progress pipe:1` emits repeated key=value lines, one block per
// tick, each block terminated by a `progress=continue`/`progress=end` line —
// accumulate a block's keys and only report once it closes, rather than
// firing on every individual line (which used to only look at out_time_ms
// and ignore everything else ffmpeg was already telling us for free).
function parseProgressBlock(line, tick) {
  const eq = line.indexOf("=");
  if (eq === -1) return null;
  const key = line.slice(0, eq).trim();
  const value = line.slice(eq + 1).trim();
  if (key !== "progress") { tick[key] = value; return null; }
  return { ...tick };
}

function runNativeRender(renderId, meta, bg, audio, music, titleCardImage, respond, respondFile) {
  [respond, respondFile] = onceAcrossAll(respond, respondFile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopdaddy-render-"));
  const cleanup = () => { fs.rm(dir, { recursive: true, force: true }, () => {}); };
  let args, expectedDurationSec, threads;
  try {
    ({ args, expectedDurationSec, threads } = buildRenderArgs(dir, meta, bg, audio, music, titleCardImage));
  } catch (e) {
    cleanup();
    respond(500, { error: "Failed to build render: " + e.message });
    return;
  }
  if (DEBUG) console.log("[ffmpeg]", args.join(" "));
  sendProgress(renderId, { phase: "starting", threads, cores: CPU_COUNT });
  const proc = spawn("ffmpeg", args, { cwd: dir });
  // Native ffmpeg normally emits a -progress line at least once a second —
  // unlike the WASM path (which has its own client-side stall watchdog,
  // RENDER_STALL_TIMEOUT_MS in worker-pool.js), a genuinely wedged native
  // ffmpeg process had nothing here to catch it: no output at all means no
  // error, no timeout, just a render that never finishes and permanently
  // holds a renderLimiter slot. 3 minutes of complete silence on both
  // stdout and stderr is generous relative to that ~1/sec cadence.
  let stallTimer;
  const resetStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => proc.kill("SIGKILL"), 3 * 60 * 1000);
  };
  resetStallTimer();
  let stderrTail = "";
  proc.stderr.on("data", (chunk) => {
    resetStallTimer();
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  let stdoutBuf = "";
  let tick = {};
  proc.stdout.on("data", (chunk) => {
    resetStallTimer();
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop();
    for (const line of lines) {
      const block = parseProgressBlock(line, tick);
      if (!block) continue;
      tick = {};
      if (!(expectedDurationSec > 0 && block.out_time_ms)) continue;
      const pct = Math.min(99, Math.round((parseInt(block.out_time_ms, 10) / 1e6 / expectedDurationSec) * 100));
      sendProgress(renderId, {
        phase: "encoding",
        pct,
        threads,
        frame: block.frame ? parseInt(block.frame, 10) : null,
        fps: block.fps ? parseFloat(block.fps) : null,
        speed: block.speed && block.speed !== "N/A" ? parseFloat(block.speed) : null,
        bitrate: block.bitrate && block.bitrate !== "N/A" ? block.bitrate : null,
      });
    }
  });
  proc.on("error", (err) => {
    clearTimeout(stallTimer);
    cleanup();
    respond(500, { error: "Couldn't run ffmpeg: " + err.message });
  });
  proc.on("close", (code) => {
    clearTimeout(stallTimer);
    if (code !== 0) {
      cleanup();
      respond(500, { error: `ffmpeg exited with code ${code}\n${stderrTail.slice(-1000)}` });
      return;
    }
    sendProgress(renderId, { phase: "done", pct: 100 });
    const outPath = path.join(dir, "out.mp4");
    fs.stat(outPath, (statErr, stat) => {
      if (statErr) {
        cleanup();
        respond(500, { error: "Render finished but output was missing: " + statErr.message });
        return;
      }
      respondFile(200, outPath, stat.size, "video/mp4", cleanup);
    });
  });
}

// Shells out to the user's own `whisper` CLI (openai-whisper) instead of any
// in-browser ASR — real per-word timestamps from actually transcribing the
// generated audio. Mirrors runNativeRender's temp-dir/cleanup/respond
// conventions exactly; only the subprocess and output-parsing differ.
// --fp16 False avoids a CPU-only slowdown/warning (confirmed live on this
// machine: fp16 needs CUDA, and warns+degrades on CPU/Apple Silicon).
const WHISPER_MODELS = ["tiny.en", "base.en", "small.en"];

function runNativeTranscribe(transcribeId, audio, model, respond) {
  [respond] = onceAcrossAll(respond);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopdaddy-transcribe-"));
  const cleanup = () => { fs.rm(dir, { recursive: true, force: true }, () => {}); };
  fs.writeFileSync(path.join(dir, "audio.wav"), audio);

  sendProgress(transcribeId, 10);
  const whisperArgs = [
    path.join(dir, "audio.wav"),
    "--model", WHISPER_MODELS.includes(model) ? model : "tiny.en",
    "--word_timestamps", "True",
    "--output_format", "json",
    "--output_dir", dir,
    "--fp16", "False",
    "--threads", String(threadBudget(transcribeLimiter)),
  ];
  if (DEBUG) console.log("[whisper]", whisperArgs.join(" "));
  const proc = spawn("whisper", whisperArgs, { cwd: dir });
  // No progress channel exists for whisper the way ffmpeg's -progress pipe
  // gives renders one — a genuinely hung/stuck transcription (a known real
  // failure mode for this kind of CPU-bound Python subprocess) would
  // otherwise hold this transcribeLimiter slot, and the client's fetch,
  // open forever with no way to recover short of restarting the server.
  // 10 minutes is generous relative to real transcription times (even
  // small.en on CPU comfortably finishes a multi-minute narration well
  // under that) while still bounding the worst case.
  const killTimer = setTimeout(() => {
    proc.kill("SIGKILL");
  }, 10 * 60 * 1000);
  let stderrTail = "";
  proc.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  proc.on("error", (err) => {
    clearTimeout(killTimer);
    cleanup();
    respond(500, { error: "Couldn't run whisper: " + err.message });
  });
  proc.on("close", (code) => {
    clearTimeout(killTimer);
    if (code !== 0) {
      cleanup();
      respond(500, { error: `whisper exited with code ${code}\n${stderrTail.slice(-1000)}` });
      return;
    }
    sendProgress(transcribeId, 90);
    let json;
    try {
      // whisper names its output <input-basename>.json in --output_dir.
      json = JSON.parse(fs.readFileSync(path.join(dir, "audio.json"), "utf8"));
    } catch (e) {
      cleanup();
      respond(500, { error: "Transcription finished but output was missing/malformed: " + e.message });
      return;
    }
    cleanup();
    // Confirmed live against a real whisper run: segments[].words[] each
    // {word, start, end, probability}, `word` with a leading space — flatten
    // into the {text,start,end} shape alignWordsBySequence expects.
    const words = (json.segments || []).flatMap(seg =>
      (seg.words || []).map(w => ({ text: (w.word || "").trim(), start: w.start, end: w.end }))
    );
    sendProgress(transcribeId, 100);
    respond(200, { words });
  });
}

// Only these 6 (the base language names, not the dated/"24l" preview
// variants also listed in `--help`) are surfaced as voice choices — each
// maps to exactly one Kyutai-curated built-in voice when `--voice` (a path
// to a custom cloning-reference audio file) is omitted: english->alba,
// french->estelle, german->juergen, italian->giovanni, portuguese->rafael,
// spanish->lola (confirmed live via `uvx pocket-tts generate --help`).
const POCKET_TTS_LANGUAGES = ["english", "french", "german", "italian", "portuguese", "spanish"];

function runNativePocketTts(text, language, respond) {
  [respond] = onceAcrossAll(respond);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopdaddy-pockettts-"));
  const cleanup = () => { fs.rm(dir, { recursive: true, force: true }, () => {}); };
  const outPath = path.join(dir, "out.wav");
  const args = ["pocket-tts", "generate", "--text", text, "--output-path", outPath, "--quiet"];
  if (POCKET_TTS_LANGUAGES.includes(language)) args.push("--language", language);
  if (DEBUG) console.log("[pocket-tts]", args.join(" "));
  const proc = spawn("uvx", args);
  // Same reasoning as runNativeTranscribe's kill timer — a hung subprocess
  // would otherwise hold a pocketTtsLimiter slot forever. 5 minutes covers
  // even a slow first-ever `uvx` package download plus generation, well
  // above the ~2s/generation this normally takes once cached.
  const killTimer = setTimeout(() => { proc.kill("SIGKILL"); }, 5 * 60 * 1000);
  let stderrTail = "";
  proc.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  proc.on("error", (err) => {
    clearTimeout(killTimer);
    cleanup();
    respond(500, { error: "Couldn't run pocket-tts (via uvx): " + err.message });
  });
  proc.on("close", (code) => {
    clearTimeout(killTimer);
    if (code !== 0) {
      cleanup();
      respond(500, { error: `pocket-tts exited with code ${code}\n${stderrTail.slice(-1000)}` });
      return;
    }
    let data;
    try {
      data = fs.readFileSync(outPath);
    } catch (e) {
      cleanup();
      respond(500, { error: "pocket-tts finished but output was missing: " + e.message });
      return;
    }
    cleanup();
    respond(200, data, "audio/wav");
  });
}

// af_/am_ voices need American English ('a'), bf_/bm_ need British ('b') —
// KPipeline requires this up front (it picks the g2p/phonemizer), unlike the
// browser build where kokoro-js infers it internally. Falls back to 'a' for
// any unrecognized id rather than erroring, since new voices are a config
// change (KOKORO_VOICES in web/lib/tts-engines.js), not a code change here.
function kokoroLangForVoice(voice) {
  return typeof voice === "string" && voice.startsWith("b") ? "b" : "a";
}

function runNativeKokoro(text, voice, speed, respond) {
  [respond] = onceAcrossAll(respond);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopdaddy-kokoro-"));
  const cleanup = () => { fs.rm(dir, { recursive: true, force: true }, () => {}); };
  const textPath = path.join(dir, "text.txt");
  const outPath = path.join(dir, "out.wav");
  fs.writeFileSync(textPath, text, "utf8");
  // In a packaged Electron build, __dirname resolves inside app.asar — a
  // virtual archive Node's own fs can read transparently, but external
  // processes (uvx/python3, spawned below) can't; the OS just sees
  // app.asar as a regular file and "can't open" a path pretending to be a
  // directory inside it (confirmed live: "python: can't open file
  // '.../app.asar/scripts/kokoro_native.py': [Errno 20] Not a directory").
  // electron-builder's asarUnpack (see package.json) physically extracts
  // scripts/*.py next to the archive under app.asar.unpacked/ — this
  // redirect is a no-op in dev mode, where __dirname never contains
  // "app.asar" at all.
  const scriptPath = path.join(__dirname, "scripts", "kokoro_native.py").replace("app.asar", "app.asar.unpacked");
  const args = [
    ...KOKORO_NATIVE_WITH_ARGS, "python3", scriptPath,
    "--text-file", textPath, "--voice", voice, "--lang", kokoroLangForVoice(voice),
    "--speed", String(speed || 1), "--out", outPath,
  ];
  if (DEBUG) console.log("[kokoro-native]", args.join(" "));
  const proc = spawn("uvx", args);
  // Real generations take a few seconds once cached; a first-ever run also
  // pays for uvx's dependency resolution (torch etc.) and the model's own
  // one-time HuggingFace download — same reasoning as PocketTTS's kill
  // timer, sized generously so that doesn't get mistaken for a hang.
  const killTimer = setTimeout(() => { proc.kill("SIGKILL"); }, 8 * 60 * 1000);
  let stdout = "";
  let stderrTail = "";
  proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-4000); });
  proc.on("error", (err) => {
    clearTimeout(killTimer);
    cleanup();
    respond(500, { error: "Couldn't run the native Kokoro backend (via uvx): " + err.message });
  });
  proc.on("close", (code) => {
    clearTimeout(killTimer);
    if (code !== 0) {
      cleanup();
      respond(500, { error: `Native Kokoro exited with code ${code}\n${stderrTail.slice(-1000)}` });
      return;
    }
    let meta;
    try {
      // Metadata is the LAST line of stdout — everything before it is
      // kokoro/spacy/torch's own warnings/progress output, which this
      // script doesn't (and can't fully) suppress.
      const lastLine = stdout.trim().split("\n").pop();
      meta = JSON.parse(lastLine);
    } catch (e) {
      cleanup();
      respond(500, { error: "Native Kokoro finished but its output was unparseable: " + e.message });
      return;
    }
    let audioBuf;
    try {
      audioBuf = fs.readFileSync(outPath);
    } catch (e) {
      cleanup();
      respond(500, { error: "Native Kokoro finished but the audio file was missing: " + e.message });
      return;
    }
    cleanup();
    respond(200, {
      audioBase64: audioBuf.toString("base64"),
      durationSec: meta.durationSec,
      wordTimings: (meta.words || []).map(w => ({ text: w.text, start: w.start, end: w.end })),
    });
  });
}

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

function log(req, res) {
  console.log(`[${new Date().toISOString()}] ${req.socket.remoteAddress} ${req.method} ${req.url}`);
  if (DEBUG) {
    const start = Date.now();
    res.on("finish", () => {
      console.log(`  -> ${res.statusCode} (${Date.now() - start}ms)`);
    });
  }
}

const server = http.createServer((req, res) => {
  // A synchronous throw anywhere in this handler (e.g. decodeURIComponent()
  // below on a malformed "%" sequence) would otherwise propagate out of
  // http.createServer's callback uncaught and crash the entire process —
  // confirmed live: `curl http://localhost:PORT/%` did exactly that before
  // this wrap existed. Catches synchronous errors only; the async route
  // handlers below (checkFfmpeg callbacks, req.on("end") handlers, etc.)
  // already have their own error handling.
  try {
    handleRequest(req, res);
  } catch (e) {
    console.error("Unhandled request error:", e);
    if (!res.headersSent) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad request" }));
    } else {
      res.end();
    }
  }
});
function handleRequest(req, res) {
  log(req, res);

  const urlNoQuery = req.url.split("?")[0];

  // ---- Native render backend routes (see the block above) ----
  if (urlNoQuery === "/render-capability" && req.method === "GET") {
    checkFfmpeg((available) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ available, cpuCount: CPU_COUNT }));
    });
    return;
  }
  // Debug-tab "System Diagnostics" — deliberately spawns fresh ffmpeg/whisper
  // checks on every call instead of reusing checkFfmpeg/checkWhisper's cached
  // booleans, so the panel's "Recheck" button actually re-probes (e.g. after
  // installing ffmpeg-full without restarting the server) instead of
  // reporting a server-startup-time snapshot forever.
  if (urlNoQuery === "/system-info" && req.method === "GET") {
    execFile("ffmpeg", ["-version"], { timeout: 5000 }, (ferr, fstdout) => {
      const ffmpegVersion = !ferr && fstdout ? fstdout.split("\n")[0].trim() : null;
      execFile("ffmpeg", ["-filters"], { timeout: 5000 }, (ferr2, fstdout2) => {
        const ffmpegAvailable = !ferr2 && /drawtext/.test(fstdout2 || "");
        execFile("whisper", ["--help"], { timeout: 5000 }, (werr, wstdout) => {
          const whisperAvailable = !werr && /word_timestamps/.test(wstdout || "");
          execFile("uvx", ["pocket-tts", "--help"], { timeout: 20000 }, (perr, pstdout) => {
            const pocketTtsAvail = !perr && /generate/.test(pstdout || "");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              ffmpegAvailable, ffmpegVersion,
              whisperAvailable,
              pocketTtsAvailable: pocketTtsAvail,
              cpuCount: CPU_COUNT, cpuModel: (os.cpus()[0] || {}).model || "unknown",
              platform: os.platform(), arch: os.arch(), nodeVersion: process.version,
              renderActive: renderLimiter.getActive(), renderMax: renderLimiter.getMax(),
              transcribeActive: transcribeLimiter.getActive(), transcribeMax: transcribeLimiter.getMax(),
              pocketTtsActive: pocketTtsLimiter.getActive(), pocketTtsMax: pocketTtsLimiter.getMax(),
            }));
          });
        });
      });
    });
    return;
  }
  if (urlNoQuery === "/cache-info" && req.method === "GET") {
    let fileCount = 0, totalBytes = 0;
    try {
      for (const name of fs.readdirSync(BG_CACHE_DIR)) {
        totalBytes += fs.statSync(path.join(BG_CACHE_DIR, name)).size;
        fileCount++;
      }
    } catch (e) { /* cache dir missing/unreadable — report empty */ }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ fileCount, totalBytes }));
    return;
  }
  if (urlNoQuery === "/cache-clear" && req.method === "POST") {
    fs.rmSync(BG_CACHE_DIR, { recursive: true, force: true });
    fs.mkdirSync(BG_CACHE_DIR, { recursive: true });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (urlNoQuery === "/performance-settings" && req.method === "POST") {
    readBodyWithLimit(req, res, 64 * 1024, (buf) => {
      let body;
      try {
        body = JSON.parse(buf.toString("utf8") || "{}");
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Malformed JSON body" }));
        return;
      }
      const renderConcurrency = clampConcurrency(body.renderConcurrency);
      const transcribeConcurrency = clampConcurrency(body.transcribeConcurrency);
      if (renderConcurrency !== null) renderLimiter.setMax(renderConcurrency);
      if (transcribeConcurrency !== null) transcribeLimiter.setMax(transcribeConcurrency);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        renderConcurrency: renderLimiter.getMax(),
        transcribeConcurrency: transcribeLimiter.getMax(),
      }));
    });
    return;
  }
  if (urlNoQuery.startsWith("/render-progress/") && req.method === "GET") {
    // "render:" prefix keeps this channel map's keyspace separate from
    // /transcribe-progress's — both ids are client-generated, so without a
    // namespace a render id and a transcribe id colliding (unlikely, but
    // possible depending on how the client generates them) would cross-wire
    // one job's progress events into the other's SSE stream.
    const id = "render:" + urlNoQuery.slice("/render-progress/".length);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    progressChannels.set(id, res);
    req.on("close", () => { progressChannels.delete(id); });
    return;
  }
  // Decoupled from /render on purpose: caching an asset by hash is quick
  // (just a disk write), while a render can take a while — a batch job
  // sharing a background with an earlier job only needs to wait for that
  // earlier job's upload to land in the cache, not for its entire render to
  // finish. Idempotent — if the hash is already cached, the body is read
  // and discarded without rewriting the file.
  if (urlNoQuery === "/cache-asset" && req.method === "POST") {
    const hash = new URL(req.url, "http://localhost").searchParams.get("hash") || "";
    if (!ASSET_HASH_RE.test(hash)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or malformed hash query param" }));
      return;
    }
    readBodyWithLimit(req, res, 4 * 1024 * 1024 * 1024, (buf) => {
      const cachePath = path.join(BG_CACHE_DIR, hash);
      if (!fs.existsSync(cachePath)) {
        try {
          fs.writeFileSync(cachePath, buf);
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to cache asset: " + e.message }));
          return;
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (urlNoQuery === "/render" && req.method === "POST") {
    const id = "render:" + (new URL(req.url, "http://localhost").searchParams.get("id") || crypto.randomUUID());
    checkFfmpeg((available) => {
      if (!available) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "ffmpeg isn't installed (or not on PATH) — install it and restart the server." }));
        return;
      }
      readBodyWithLimit(req, res, 4 * 1024 * 1024 * 1024, async (body) => {
        let parsed;
        try {
          parsed = parseRenderBody(body);
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Malformed render request: " + e.message }));
          return;
        }
        sendProgress(id, { phase: "queued", activeRenders: renderLimiter.getActive(), renderSlots: renderLimiter.getMax() });
        await renderLimiter.acquire();
        const finish = () => { renderLimiter.release(); closeProgressChannel(id); };
        const respond = (status, data, contentType) => {
          finish();
          if (contentType) {
            res.writeHead(status, { "Content-Type": contentType, "Content-Length": data.length });
            res.end(data);
          } else {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        };
        // Streams the finished render straight off disk instead of
        // fs.readFileSync-ing the whole (potentially several-hundred-MB)
        // file into memory first — avoids doubling peak memory (one copy on
        // disk, one in a Buffer) and blocking the event loop synchronously
        // for the read.
        const respondFile = (status, filePath, size, contentType, onDone) => {
          // "error" and "close" can both fire for the same stream (close
          // follows error once the fd is released) — guard so finish()
          // (which releases the render slot) and onDone() (temp-dir
          // cleanup) each run exactly once, not twice.
          let settled = false;
          const settle = () => { if (settled) return; settled = true; finish(); onDone(); };
          res.writeHead(status, { "Content-Type": contentType, "Content-Length": size });
          const stream = fs.createReadStream(filePath);
          stream.on("error", () => { settle(); if (!res.writableEnded) res.end(); });
          stream.on("close", settle);
          stream.pipe(res);
        };
        runNativeRender(id, parsed.meta, parsed.bg, parsed.audio, parsed.music, parsed.titleCardImage, respond, respondFile);
      });
    });
    return;
  }

  // ---- Native transcribe backend routes (tier 1 of caption sync) ----
  if (urlNoQuery === "/transcribe-capability" && req.method === "GET") {
    checkWhisper((available) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ available }));
    });
    return;
  }
  if (urlNoQuery.startsWith("/transcribe-progress/") && req.method === "GET") {
    const id = "transcribe:" + urlNoQuery.slice("/transcribe-progress/".length);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    progressChannels.set(id, res);
    req.on("close", () => { progressChannels.delete(id); });
    return;
  }
  if (urlNoQuery === "/transcribe" && req.method === "POST") {
    const reqUrl = new URL(req.url, "http://localhost");
    const id = "transcribe:" + (reqUrl.searchParams.get("id") || crypto.randomUUID());
    const requestedModel = reqUrl.searchParams.get("model");
    const model = WHISPER_MODELS.includes(requestedModel) ? requestedModel : "tiny.en";
    checkWhisper((available) => {
      if (!available) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "whisper isn't installed (or not on PATH)." }));
        return;
      }
      // No framing needed — the POST body is just the raw narration audio
      // bytes. Unlike /render, whisper doesn't need the known script text
      // (it transcribes freely); alignment against the known text happens
      // client-side via alignWordsBySequence once this responds.
      readBodyWithLimit(req, res, 512 * 1024 * 1024, async (audio) => {
        await transcribeLimiter.acquire();
        const respond = (status, data) => {
          transcribeLimiter.release();
          closeProgressChannel(id);
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        };
        runNativeTranscribe(id, audio, model, respond);
      });
    });
    return;
  }

  // ---- Native PocketTTS backend (Kyutai, CPU-only, no browser build) ----
  if (urlNoQuery === "/pockettts-capability" && req.method === "GET") {
    checkPocketTts((available) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ available }));
    });
    return;
  }
  if (urlNoQuery === "/pockettts" && req.method === "POST") {
    checkPocketTts((available) => {
      if (!available) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "pocket-tts isn't available — install uv (https://docs.astral.sh/uv/) so `uvx pocket-tts` works, then restart the server." }));
        return;
      }
      // Plain small JSON body (unlike /render's binary frame) — the only
      // payload is a string of narration text plus a language id, nothing
      // binary to upload.
      readBodyWithLimit(req, res, 2 * 1024 * 1024, async (buf) => {
        let body;
        try {
          body = JSON.parse(buf.toString("utf8") || "{}");
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Malformed JSON body: " + e.message }));
          return;
        }
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing text" }));
          return;
        }
        await pocketTtsLimiter.acquire();
        const respond = (status, data, contentType) => {
          pocketTtsLimiter.release();
          if (contentType) {
            res.writeHead(status, { "Content-Type": contentType, "Content-Length": data.length });
            res.end(data);
          } else {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        };
        runNativePocketTts(text, body.voice, respond);
      });
    });
    return;
  }
  if (urlNoQuery === "/kokoro-native-capability" && req.method === "GET") {
    checkKokoroNative((available) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ available }));
    });
    return;
  }
  if (urlNoQuery === "/kokoro-native" && req.method === "POST") {
    checkKokoroNative((available) => {
      if (!available) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "The native Kokoro backend isn't available — install uv (https://docs.astral.sh/uv/) so `uvx` can run it, then restart the server." }));
        return;
      }
      readBodyWithLimit(req, res, 2 * 1024 * 1024, async (buf) => {
        let body;
        try {
          body = JSON.parse(buf.toString("utf8") || "{}");
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Malformed JSON body: " + e.message }));
          return;
        }
        const text = typeof body.text === "string" ? body.text.trim() : "";
        const voice = typeof body.voice === "string" && body.voice ? body.voice : "af_heart";
        if (!text) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing text" }));
          return;
        }
        await kokoroNativeLimiter.acquire();
        const respond = (status, data) => {
          kokoroNativeLimiter.release();
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        };
        runNativeKokoro(text, voice, body.speed, respond);
      });
    });
    return;
  }

  // ---- YouTube upload integration ----
  // {available: true} unconditionally — this is a "is a server present at
  // all" probe, not a real-tool check like checkFfmpeg/checkWhisper. It's
  // naturally absent on the deployed GitHub Pages build (no server there to
  // answer), which is what makes the whole Publish tab invisible there with
  // no special-casing needed client-side — same mechanism as every other
  // native-backend probe in this file.
  if (urlNoQuery === "/youtube-capability" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ available: true }));
    return;
  }
  // Multiple OAuth clients (= Google Cloud projects) can be registered so
  // the same real channel can be connected more than once, once per
  // project, and pickAccountForUpload() spreads uploads across whichever
  // project still has quota — see the module-level comment on that
  // function. Client secrets are returned as-is here: this is a purely
  // local desktop server, same trust boundary as the store file on disk.
  if (urlNoQuery === "/youtube-oauth-clients" && req.method === "GET") {
    const store = loadYoutubeStore();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ clients: store.oauthClients }));
    return;
  }
  if (urlNoQuery === "/youtube-oauth-clients" && req.method === "POST") {
    readBodyWithLimit(req, res, 4 * 1024, (buf) => {
      let body;
      try { body = JSON.parse(buf.toString("utf8") || "{}"); } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Malformed JSON body: " + e.message }));
        return;
      }
      const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
      const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
      const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : "Project";
      if (!clientId || !clientSecret) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Both Client ID and Client Secret are required." }));
        return;
      }
      const store = loadYoutubeStore();
      const client = { id: crypto.randomUUID(), label, clientId, clientSecret, uploadLog: [] };
      store.oauthClients.push(client);
      saveYoutubeStore(store);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, client }));
    });
    return;
  }
  if (urlNoQuery.startsWith("/youtube-oauth-clients/") && req.method === "DELETE") {
    const clientIdToRemove = urlNoQuery.slice("/youtube-oauth-clients/".length);
    const store = loadYoutubeStore();
    const idx = store.oauthClients.findIndex(c => c.id === clientIdToRemove);
    if (idx === -1) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No such project." }));
      return;
    }
    // Deliberately leaves any accounts that reference this client alone —
    // they just fail with a clear "reconnect it" error on next token
    // refresh (see ensureFreshAccessToken) rather than being silently
    // deleted along with the project.
    store.oauthClients.splice(idx, 1);
    saveYoutubeStore(store);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (urlNoQuery === "/youtube-oauth-start" && req.method === "POST") {
    readBodyWithLimit(req, res, 4 * 1024, (buf) => {
      let body = {};
      try { body = JSON.parse(buf.toString("utf8") || "{}"); } catch (e) { /* fall through to missing-client error below */ }
      const store = loadYoutubeStore();
      const oauthClientId = typeof body.oauthClientId === "string" ? body.oauthClientId : null;
      const client = oauthClientId ? store.oauthClients.find(c => c.id === oauthClientId) : null;
      if (!client) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Add a Google Cloud project (Client ID/Secret) and pick it first." }));
        return;
      }
      const state = crypto.randomBytes(16).toString("hex");
      const { verifier, challenge } = generatePkcePair();
      pkceChallenges.set(state, { verifier, oauthClientId });
      const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: YOUTUBE_REDIRECT_URI,
        response_type: "code",
        scope: YOUTUBE_SCOPES,
        access_type: "offline",
        prompt: "consent",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      }).toString();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ authUrl, state }));
    });
    return;
  }
  if (urlNoQuery.startsWith("/youtube-oauth-status/") && req.method === "GET") {
    const state = "youtube-oauth:" + urlNoQuery.slice("/youtube-oauth-status/".length);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    progressChannels.set(state, res);
    req.on("close", () => { progressChannels.delete(state); });
    return;
  }
  if (urlNoQuery === "/youtube-oauth-callback" && req.method === "GET") {
    const reqUrl = new URL(req.url, "http://localhost");
    const code = reqUrl.searchParams.get("code");
    const state = reqUrl.searchParams.get("state");
    const oauthError = reqUrl.searchParams.get("error");
    const channelKey = state ? "youtube-oauth:" + state : null;
    (async () => {
      try {
        if (oauthError) throw new Error(oauthError);
        if (!code || !state) throw new Error("Missing code or state in Google's redirect.");
        const pending = pkceChallenges.get(state);
        if (!pending) throw new Error("This sign-in link expired or was already used — try again from Settings.");
        pkceChallenges.delete(state);
        const { verifier, oauthClientId } = pending;
        const store = loadYoutubeStore();
        const client = store.oauthClients.find(c => c.id === oauthClientId);
        if (!client) throw new Error("That project was removed before sign-in finished — try again from Settings.");
        const tokens = await exchangeYoutubeCode(client, code, verifier, YOUTUBE_REDIRECT_URI);
        const channel = await fetchYoutubeChannel(tokens.access_token);
        // Dedup by (channel, project) pair, not channel alone — the same
        // real channel connected through a second project is a distinct
        // account entry on purpose, since each has its own quota.
        const existing = store.accounts.find(a => a.channelId === channel.channelId && a.oauthClientId === oauthClientId);
        const account = {
          id: existing ? existing.id : crypto.randomUUID(),
          oauthClientId,
          channelId: channel.channelId,
          channelTitle: channel.channelTitle,
          channelThumbnail: channel.channelThumbnail,
          accessToken: tokens.access_token,
          accessTokenExpiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
          // Google only returns a refresh_token on the FIRST consent for a
          // given client+account (or when prompt=consent forces re-consent,
          // which the auth URL above always sets) — fall back to the
          // existing one on re-auth so a repeat sign-in never blanks it out.
          refreshToken: tokens.refresh_token || (existing && existing.refreshToken) || null,
          addedAt: existing ? existing.addedAt : Date.now(),
        };
        if (!account.refreshToken) throw new Error("Google didn't return a refresh token — revoke Slopdaddy's access at https://myaccount.google.com/permissions and try signing in again.");
        await downloadYoutubeChannelThumbnail(account.id, channel.channelThumbnail);
        if (existing) Object.assign(existing, account); else store.accounts.push(account);
        saveYoutubeStore(store);
        if (channelKey) sendProgress(channelKey, { status: "success", account: stripTokens(account, store) });
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(oauthCallbackPage(`Connected <b>${channel.channelTitle}</b>.`, true));
      } catch (e) {
        if (channelKey) sendProgress(channelKey, { status: "error", error: e.message });
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(oauthCallbackPage(e.message, false));
      } finally {
        if (channelKey) closeProgressChannel(channelKey);
      }
    })();
    return;
  }
  if (urlNoQuery === "/youtube-accounts" && req.method === "GET") {
    const store = loadYoutubeStore();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ accounts: store.accounts.map(a => stripTokens(a, store)) }));
    return;
  }
  if (urlNoQuery === "/youtube-usage" && req.method === "GET") {
    const store = loadYoutubeStore();
    const clients = store.oauthClients.map(c => ({
      id: c.id, label: c.label,
      uploadsToday: countYoutubeUploadsToday(store, c.id),
    }));
    const uploadsToday = clients.reduce((sum, c) => sum + c.uploadsToday, 0);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ uploadsToday, clients }));
    return;
  }
  if (urlNoQuery.startsWith("/youtube-account-thumbnail/") && req.method === "GET") {
    // No accountId validation beyond what path.join naturally does — this
    // only ever reads a file this server itself wrote (see
    // downloadYoutubeChannelThumbnail), and the id came from crypto.randomUUID(),
    // never client-supplied at write time.
    const accountId = urlNoQuery.slice("/youtube-account-thumbnail/".length);
    const filePath = path.join(YT_THUMB_DIR, accountId + ".jpg");
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": stat.size });
      fs.createReadStream(filePath).pipe(res);
    });
    return;
  }
  if (urlNoQuery.startsWith("/youtube-accounts/") && req.method === "DELETE") {
    const accountId = urlNoQuery.slice("/youtube-accounts/".length);
    const store = loadYoutubeStore();
    const idx = store.accounts.findIndex(a => a.id === accountId);
    if (idx === -1) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No such account." }));
      return;
    }
    const [removed] = store.accounts.splice(idx, 1);
    saveYoutubeStore(store);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    // Best-effort, after responding — revoking is a courtesy cleanup, not
    // something the client needs to wait on.
    if (removed.refreshToken) {
      fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(removed.refreshToken)}`, { method: "POST" }).catch(() => {});
    }
    fs.rm(path.join(YT_THUMB_DIR, removed.id + ".jpg"), { force: true }, () => {});
    return;
  }
  if (urlNoQuery.startsWith("/youtube-upload-progress/") && req.method === "GET") {
    const id = "youtube-upload:" + urlNoQuery.slice("/youtube-upload-progress/".length);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    progressChannels.set(id, res);
    req.on("close", () => { progressChannels.delete(id); });
    return;
  }
  if (urlNoQuery === "/youtube-upload" && req.method === "POST") {
    const id = "youtube-upload:" + (new URL(req.url, "http://localhost").searchParams.get("id") || crypto.randomUUID());
    readBodyWithLimit(req, res, 4 * 1024 * 1024 * 1024, async (bodyBuf) => {
      let parsed;
      try {
        parsed = parseYoutubeUploadBody(bodyBuf);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Malformed upload request: " + e.message }));
        return;
      }
      const store = loadYoutubeStore();
      // Picks whichever project-connection for this channel still has quota
      // remaining today — see pickAccountForUpload's own comment. Falls
      // back to the requested account (which then just hits YouTube's own
      // real quota error) if every connection for this channel is full.
      const account = pickAccountForUpload(store, parsed.meta.accountId);
      if (!account) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No such connected YouTube account — sign in again from Settings." }));
        return;
      }
      sendProgress(id, { phase: "queued", activeUploads: youtubeUploadLimiter.getActive(), uploadSlots: youtubeUploadLimiter.getMax() });
      await youtubeUploadLimiter.acquire();
      const finish = () => youtubeUploadLimiter.release();
      const respond = (status, data) => {
        finish();
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      runYoutubeUpload(id, store, account, parsed.video, parsed.thumbnail, parsed.meta, respond);
    });
    return;
  }

  let urlPath = decodeURIComponent(urlNoQuery);
  if (urlPath === "/") urlPath = "/index.html";
  // Prevent escaping ROOT via "..". A bare startsWith(ROOT) has no separator
  // boundary — a sibling directory sharing ROOT's name as a prefix (e.g. a
  // hypothetical "web-something" next to "web") would incorrectly pass, so
  // compare against ROOT with a trailing separator instead.
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
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
}

// Required (not just run as a CLI script) by electron/main.js to start the
// same backend in-process for the standalone app — handle "something's
// already listening on this port" gracefully instead of crashing the whole
// process, since that's expected whenever the app is launched twice, or
// launched while a standalone `node server.js` is already running.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`Port ${PORT} is already in use — assuming another instance of this server is already running there.`);
    return;
  }
  throw err;
});
server.listen(PORT, () => {
  console.log(`Serving AITAH Video Creator (web) at http://localhost:${PORT}`);
  console.log("Press Ctrl+C to stop.");
});
