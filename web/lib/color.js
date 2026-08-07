// Pure color math for the caption-style color picker (Settings -> Video &
// Captions). No DOM — resolving an arbitrary CSS color string (e.g. the
// "white"/"black" defaults) to RGB needs a canvas, so that one step lives in
// app.js instead; everything here only ever deals in already-known
// hex/rgb/hsv values.

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// h: 0-360, s/v: 0-1 -> {r,g,b} each 0-255.
function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, 0, 1);
  v = clamp(v, 0, 1);
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r1, g1, b1;
  if (h < 60) { r1 = c; g1 = x; b1 = 0; }
  else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
  else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
  else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
  else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
  else { r1 = c; g1 = 0; b1 = x; }
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

// {r,g,b} each 0-255 -> {h: 0-360, s: 0-1, v: 0-1}.
function rgbToHsv(r, g, b) {
  r = clamp(r, 0, 255) / 255; g = clamp(g, 0, 255) / 255; b = clamp(b, 0, 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

function toHex2(n) {
  return clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
}

// a: 0-1 (or omitted/1 for fully opaque) -> "#RRGGBB" or "#RRGGBBAA" when
// a < 1 — matches web/lib/ffmpeg-filters.js's safeColor()/ffmpeg's own
// #RRGGBB[AA] color syntax, so a picked color drops straight into a render.
function rgbToHex(r, g, b, a) {
  const base = "#" + toHex2(r) + toHex2(g) + toHex2(b);
  if (a === undefined || a === null || a >= 1) return base;
  return base + toHex2(clamp(a, 0, 1) * 255);
}

// Accepts #RGB, #RRGGBB, #RRGGBBAA (with or without leading #). Returns
// {r,g,b,a} (a: 0-1) or null if the string isn't a valid hex color.
function hexToRgba(hex) {
  if (typeof hex !== "string") return null;
  let s = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    s = s.split("").map((c) => c + c).join("");
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) {
    return {
      r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16),
      a: 1,
    };
  }
  if (/^[0-9a-fA-F]{8}$/.test(s)) {
    return {
      r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16),
      a: parseInt(s.slice(6, 8), 16) / 255,
    };
  }
  return null;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { clamp, hsvToRgb, rgbToHsv, rgbToHex, hexToRgba };
}
