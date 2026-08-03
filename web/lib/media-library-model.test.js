const test = require("node:test");
const assert = require("node:assert/strict");
const { makeMediaItemId, inferKindFromMimeType, buildMediaItemRecord } = require("./media-library-model.js");

test("makeMediaItemId returns unique, non-empty ids", () => {
  const ids = new Set(Array.from({ length: 50 }, () => makeMediaItemId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.ok(id && typeof id === "string");
});

test("inferKindFromMimeType recognizes audio mimetypes", () => {
  assert.equal(inferKindFromMimeType("audio/mpeg"), "audio");
  assert.equal(inferKindFromMimeType("audio/wav"), "audio");
  assert.equal(inferKindFromMimeType("audio/ogg"), "audio");
});

test("inferKindFromMimeType defaults to video for non-audio/unknown mimetypes", () => {
  assert.equal(inferKindFromMimeType("video/mp4"), "video");
  assert.equal(inferKindFromMimeType(""), "video");
  assert.equal(inferKindFromMimeType(undefined), "video");
  assert.equal(inferKindFromMimeType("application/octet-stream"), "video");
});

test("buildMediaItemRecord builds a full record from a File-like object", () => {
  const record = buildMediaItemRecord({ name: "clip.mp4", type: "video/mp4", size: 12345 });
  assert.equal(record.kind, "video");
  assert.equal(record.name, "clip.mp4");
  assert.equal(record.mimeType, "video/mp4");
  assert.equal(record.size, 12345);
  assert.ok(record.id);
  assert.ok(record.addedAt > 0);
});

test("buildMediaItemRecord infers kind when not explicitly given", () => {
  const record = buildMediaItemRecord({ name: "song.mp3", type: "audio/mpeg", size: 999 });
  assert.equal(record.kind, "audio");
});

test("buildMediaItemRecord accepts an explicit kind override", () => {
  const record = buildMediaItemRecord({ name: "mystery.bin", type: "", size: 1 }, "audio");
  assert.equal(record.kind, "audio");
});

test("buildMediaItemRecord handles a missing/empty file gracefully", () => {
  const record = buildMediaItemRecord(null);
  assert.equal(record.kind, "video");
  assert.equal(record.name, "untitled");
  assert.equal(record.mimeType, "");
  assert.equal(record.size, 0);
});
