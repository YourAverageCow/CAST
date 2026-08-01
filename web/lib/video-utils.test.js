const test = require("node:test");
const assert = require("node:assert/strict");
const { detectUnsupportedCodec } = require("./video-utils.js");

function bytesOf(str) {
  return new TextEncoder().encode(str);
}

test("detectUnsupportedCodec flags AV1 (av01 fourcc)", () => {
  assert.equal(detectUnsupportedCodec(bytesOf("....stsdav01....")), "AV1");
});

test("detectUnsupportedCodec flags VP9 (vp09 fourcc)", () => {
  assert.equal(detectUnsupportedCodec(bytesOf("....stsdvp09....")), "VP9");
});

test("detectUnsupportedCodec flags VP8 (vp08 fourcc)", () => {
  assert.equal(detectUnsupportedCodec(bytesOf("....stsdvp08....")), "VP8");
});

test("detectUnsupportedCodec returns null for a supported codec (avc1/H.264)", () => {
  assert.equal(detectUnsupportedCodec(bytesOf("....stsdavc1....")), null);
});

test("detectUnsupportedCodec returns null for empty/garbage bytes", () => {
  assert.equal(detectUnsupportedCodec(new Uint8Array(0)), null);
  assert.equal(detectUnsupportedCodec(bytesOf("not a video file at all")), null);
});
