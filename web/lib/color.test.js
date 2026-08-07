const test = require("node:test");
const assert = require("node:assert/strict");
const { hsvToRgb, rgbToHsv, rgbToHex, hexToRgba } = require("./color.js");

test("hsvToRgb: red/green/blue/white/black primaries", () => {
  assert.deepEqual(hsvToRgb(0, 1, 1), { r: 255, g: 0, b: 0 });
  assert.deepEqual(hsvToRgb(120, 1, 1), { r: 0, g: 255, b: 0 });
  assert.deepEqual(hsvToRgb(240, 1, 1), { r: 0, g: 0, b: 255 });
  assert.deepEqual(hsvToRgb(0, 0, 1), { r: 255, g: 255, b: 255 });
  assert.deepEqual(hsvToRgb(0, 0, 0), { r: 0, g: 0, b: 0 });
});

test("rgbToHsv: round-trips primaries", () => {
  const hsv = rgbToHsv(255, 0, 0);
  assert.equal(hsv.h, 0);
  assert.equal(hsv.s, 1);
  assert.equal(hsv.v, 1);
  const white = rgbToHsv(255, 255, 255);
  assert.equal(white.s, 0);
  assert.equal(white.v, 1);
});

test("hsvToRgb/rgbToHsv round-trip for an arbitrary color", () => {
  const rgb = hsvToRgb(280, 0.6, 0.95);
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  assert.ok(Math.abs(hsv.h - 280) < 2);
  assert.ok(Math.abs(hsv.s - 0.6) < 0.02);
  assert.ok(Math.abs(hsv.v - 0.95) < 0.02);
});

test("rgbToHex: omits alpha when fully opaque", () => {
  assert.equal(rgbToHex(255, 255, 255), "#ffffff");
  assert.equal(rgbToHex(0, 0, 0, 1), "#000000");
});

test("rgbToHex: appends alpha byte when translucent", () => {
  assert.equal(rgbToHex(180, 9, 242, 199 / 255), "#b409f2c7");
});

test("hexToRgba: parses 3/6/8-digit hex with or without #", () => {
  assert.deepEqual(hexToRgba("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(hexToRgba("58a6ff"), { r: 88, g: 166, b: 255, a: 1 });
  const withAlpha = hexToRgba("#b409f2c7");
  assert.equal(withAlpha.r, 180);
  assert.equal(withAlpha.g, 9);
  assert.equal(withAlpha.b, 242);
  assert.ok(Math.abs(withAlpha.a - 199 / 255) < 0.01);
});

test("hexToRgba: returns null for invalid input", () => {
  assert.equal(hexToRgba("not-a-color"), null);
  assert.equal(hexToRgba(""), null);
  assert.equal(hexToRgba(null), null);
});
