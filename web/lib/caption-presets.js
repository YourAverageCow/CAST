// Caption font + style-preset registries — pure data, no DOM. Loaded as a
// classic script global in the browser and via require() in both Node
// tests and server.js (mirrors how server.js already reuses
// ffmpeg-filters.js's pure builders directly).

// Every font actually vendored under web/vendor/fonts/ — the ONLY fonts
// that can ever appear in a render, native or WASM. `id` is what's stored
// in settings/job fields; `file` is the real filename on disk; `cssFamily`
// matches the @font-face family name declared in index.html so the browser
// preview renders the exact same face instead of approximating with a
// system font of a similar name.
const CAPTION_FONTS = [
  { id: "dejavu", file: "DejaVuSans.ttf", cssFamily: "SlopdaddyDejaVu", label: "DejaVu Sans (clean)" },
  { id: "anton", file: "Anton-Regular.ttf", cssFamily: "SlopdaddyAnton", label: "Anton (bold condensed)" },
  { id: "bebas", file: "BebasNeue-Regular.ttf", cssFamily: "SlopdaddyBebas", label: "Bebas Neue (condensed)" },
  { id: "archivoBlack", file: "ArchivoBlack-Regular.ttf", cssFamily: "SlopdaddyArchivoBlack", label: "Archivo Black (heavy)" },
];
const DEFAULT_FONT_ID = "dejavu";

function getCaptionFont(id) {
  return CAPTION_FONTS.find(f => f.id === id) || CAPTION_FONTS.find(f => f.id === DEFAULT_FONT_ID);
}

// Each preset is just a bundle of primitive style values — picking one
// fills in the individual Settings fields (same "preset button sets
// several fields" pattern applyResolutionPreset() already uses), not a
// separate persisted mode. Values here are a starting point tuned against
// real rendered output, not exhaustively final.
const CAPTION_PRESETS = [
  {
    id: "classic", label: "Classic", grouping: "phrase", fontId: "dejavu",
    uppercase: false, fontSize: 68, textColor: "#ffffff", strokeColor: "#000000", strokeWidth: 3,
    box: false, boxColor: "#000000", boxAlpha: 0.5, boxBorderW: 16,
    shadow: false, shadowColor: "#000000", shadowX: 2, shadowY: 2,
    entrance: "none",
  },
  {
    id: "capcutPop", label: "CapCut Pop", grouping: "word", fontId: "dejavu",
    uppercase: false, fontSize: 72, textColor: "#ffffff", strokeColor: "#000000", strokeWidth: 4,
    box: false, boxColor: "#000000", boxAlpha: 0.5, boxBorderW: 16,
    shadow: true, shadowColor: "#000000", shadowX: 2, shadowY: 2,
    entrance: "pop",
  },
  {
    id: "hormozi", label: "Hormozi", grouping: "word", fontId: "anton",
    uppercase: true, fontSize: 76, textColor: "#ffe600", strokeColor: "#000000", strokeWidth: 6,
    box: false, boxColor: "#000000", boxAlpha: 0.5, boxBorderW: 16,
    shadow: true, shadowColor: "#000000", shadowX: 3, shadowY: 3,
    entrance: "pop",
  },
  {
    id: "beastPop", label: "MrBeast Pop", grouping: "word", fontId: "archivoBlack",
    uppercase: true, fontSize: 70, textColor: "#ffffff", strokeColor: "#000000", strokeWidth: 5,
    box: false, boxColor: "#000000", boxAlpha: 0.5, boxBorderW: 16,
    shadow: true, shadowColor: "#000000", shadowX: 2, shadowY: 2,
    entrance: "pop",
  },
  {
    id: "karaokeBar", label: "Karaoke Bar", grouping: "karaoke", fontId: "bebas",
    uppercase: false, fontSize: 60, textColor: "#ffffff", highlightColor: "#00e5ff",
    strokeColor: "#000000", strokeWidth: 3,
    box: true, boxColor: "#000000", boxAlpha: 0.55, boxBorderW: 16,
    shadow: false, shadowColor: "#000000", shadowX: 2, shadowY: 2,
    entrance: "fade",
  },
  {
    id: "neonBox", label: "Neon Box", grouping: "word", fontId: "archivoBlack",
    uppercase: true, fontSize: 60, textColor: "#ffffff", strokeColor: "#000000", strokeWidth: 2,
    box: true, boxColor: "#ff2d95", boxAlpha: 0.85, boxBorderW: 18,
    shadow: false, shadowColor: "#000000", shadowX: 2, shadowY: 2,
    entrance: "fade",
  },
];
const DEFAULT_CAPTION_STYLE = CAPTION_PRESETS[0];

function getCaptionPreset(id) {
  return CAPTION_PRESETS.find(p => p.id === id) || DEFAULT_CAPTION_STYLE;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { CAPTION_FONTS, DEFAULT_FONT_ID, getCaptionFont, CAPTION_PRESETS, DEFAULT_CAPTION_STYLE, getCaptionPreset };
}
