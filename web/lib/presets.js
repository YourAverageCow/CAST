// Preset background videos / music — plain data, no logic. Loaded as a
// classic <script> in the browser (declares these as globals, consumed
// unqualified by app.js) and as a plain require()-able module in tests.
//
// `path` can be either:
//  - a same-origin relative path under web/, e.g. "vendor/presets/videos/foo.mp4"
//    (drop the file into web/vendor/presets/videos/ or .../audio/ first), or
//  - a full "https://" URL to an externally-hosted file — fetched on demand
//    when the preset is picked, nothing committed to this repo.
// External hosts must send BOTH an Access-Control-Allow-Origin (CORS) header
// AND a Cross-Origin-Resource-Policy: cross-origin (CORP) header, since this
// app runs cross-origin-isolated (COEP) for ffmpeg.wasm/Piper threading —
// missing either header gets the fetch blocked by the browser. Known-good,
// zero-setup option: front any public GitHub repo through jsdelivr (already
// used for Kokoro TTS elsewhere in this app, confirmed to send both headers):
//   https://cdn.jsdelivr.net/gh/<github-user>/<repo>@<branch-or-tag>/<path-to-file>
//
// Starts empty. To add a preset, add an entry below with a unique id, a
// display label, and either kind of path.

const PRESET_VIDEOS = [
  // { id: "unique-id", label: "Display Name", path: "vendor/presets/videos/filename.mp4" },
];

const PRESET_MUSIC = [
  // { id: "unique-id", label: "Display Name", path: "vendor/presets/audio/filename.mp3" },
];

if (typeof module !== "undefined" && module.exports) {
  module.exports = { PRESET_VIDEOS, PRESET_MUSIC };
}
