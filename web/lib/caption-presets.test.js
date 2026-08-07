const test = require("node:test");
const assert = require("node:assert/strict");
const { CAPTION_FONTS, getCaptionFont, CAPTION_PRESETS, DEFAULT_CAPTION_STYLE, getCaptionPreset } = require("./caption-presets.js");

test("CAPTION_FONTS: every entry has a real file/id/label/cssFamily", () => {
  for (const f of CAPTION_FONTS) {
    assert.ok(f.id && typeof f.id === "string");
    assert.ok(f.file && f.file.endsWith(".ttf"));
    assert.ok(f.cssFamily);
    assert.ok(f.label);
  }
});

test("getCaptionFont: resolves a known id, falls back to default for unknown", () => {
  assert.equal(getCaptionFont("anton").file, "Anton-Regular.ttf");
  assert.equal(getCaptionFont("nonexistent").id, "dejavu");
  assert.equal(getCaptionFont(undefined).id, "dejavu");
});

test("CAPTION_PRESETS: every preset has a valid grouping and font id", () => {
  const fontIds = new Set(CAPTION_FONTS.map(f => f.id));
  for (const p of CAPTION_PRESETS) {
    assert.ok(["word", "phrase", "karaoke"].includes(p.grouping), `${p.id} has invalid grouping ${p.grouping}`);
    assert.ok(fontIds.has(p.fontId), `${p.id} references unknown font ${p.fontId}`);
    if (p.grouping === "karaoke") assert.ok(p.highlightColor, `${p.id} is karaoke but has no highlightColor`);
  }
});

test("DEFAULT_CAPTION_STYLE is the classic preset", () => {
  assert.equal(DEFAULT_CAPTION_STYLE.id, "classic");
});

test("getCaptionPreset: resolves a known id, falls back to default for unknown", () => {
  assert.equal(getCaptionPreset("hormozi").id, "hormozi");
  assert.equal(getCaptionPreset("nonexistent").id, "classic");
});
