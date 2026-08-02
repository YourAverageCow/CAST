// Repo-hosted preset background videos / music — plain data, no logic.
// Loaded as a classic <script> in the browser (declares these as globals,
// consumed unqualified by app.js) and as a plain require()-able module in
// tests. Paths are relative to web/ (same root as vendor/onnx/piper).
//
// Starts empty. To add a preset: drop the file into
// web/vendor/presets/videos/ or web/vendor/presets/audio/, then add a
// matching entry below with a unique id and a display label.

const PRESET_VIDEOS = [
  // { id: "unique-id", label: "Display Name", path: "vendor/presets/videos/filename.mp4" },
];

const PRESET_MUSIC = [
  // { id: "unique-id", label: "Display Name", path: "vendor/presets/audio/filename.mp3" },
];

if (typeof module !== "undefined" && module.exports) {
  module.exports = { PRESET_VIDEOS, PRESET_MUSIC };
}
