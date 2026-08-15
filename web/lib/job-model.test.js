const test = require("node:test");
const assert = require("node:assert/strict");
const { createJob, resolveJobSettings, makeJobId } = require("./job-model.js");

const GLOBAL_SETTINGS = {
  voice: "en_US-ryan-medium", resW: 1080, resH: 1920, fps: 30, font: "dejavu",
  fontSize: 68, positionY: 0.55, textColor: "white", strokeColor: "black",
  strokeWidth: 3, captionPreset: "word", captionUppercase: false, highlightColor: "yellow",
  captionBox: false, boxColor: "black", boxAlpha: 0.5, boxBorderW: 16, boxBevel: 0,
  captionShadow: false, shadowColor: "black", shadowX: 2, shadowY: 2,
  captionEntrance: "none",
  ttsEngine: "piper",
};

test("makeJobId returns unique, non-empty ids", () => {
  const ids = new Set(Array.from({ length: 50 }, () => makeJobId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.ok(id && typeof id === "string");
});

test("createJob has sane defaults", () => {
  const job = createJob();
  assert.equal(job.status, "draft");
  assert.equal(job.premise, "");
  assert.equal(job.bgFile, null);
  assert.equal(job.voice, null);
  assert.equal(job.captionPreset, null);
  assert.equal(job.ttsEngine, null);
  assert.equal(job.musicFile, null);
  assert.equal(job.musicVolume, 0.25);
  assert.equal(job.titleCardEnabled, true);
  assert.equal(job.titleCardText, null);
  assert.deepEqual(job.publish, {
    targets: [], accountId: null, status: "none", error: null,
    scheduledAt: null, privacyStatus: "private", categoryId: "24",
    title: null, description: null, tags: [],
    thumbnailBlob: null, thumbnailUrl: null,
    videoId: null, uploadProgressPct: 0,
  });
  assert.deepEqual(job.tiktokPublish, {
    accountId: null, status: "none", error: null,
    title: null, videoCoverTimestampMs: 0,
    publishId: null, uploadProgressPct: 0,
  });
  assert.ok(job.id);
  assert.ok(job.createdAt > 0);
});

test("createJob applies overrides on top of defaults", () => {
  const job = createJob({ premise: "a haunted vending machine", status: "queued" });
  assert.equal(job.premise, "a haunted vending machine");
  assert.equal(job.status, "queued");
  assert.equal(job.story, ""); // untouched fields keep their default
});

test("resolveJobSettings falls back to global defaults when job fields are unset", () => {
  const job = createJob();
  const resolved = resolveJobSettings(job, GLOBAL_SETTINGS);
  assert.deepEqual(resolved, GLOBAL_SETTINGS);
});

test("resolveJobSettings prefers a job's own override over the global default", () => {
  const job = createJob({ voice: "en_GB-alan-medium", fontSize: 90, captionPreset: "karaoke" });
  const resolved = resolveJobSettings(job, GLOBAL_SETTINGS);
  assert.equal(resolved.voice, "en_GB-alan-medium");
  assert.equal(resolved.fontSize, 90);
  assert.equal(resolved.captionPreset, "karaoke");
  assert.equal(resolved.resW, 1080); // still falls back for untouched fields
});

test("resolveJobSettings treats an empty string override as unset", () => {
  const job = createJob({ textColor: "" });
  const globalSettings = { voice: "v", resW: 1, resH: 1, fps: 1, font: "f", fontSize: 1, positionY: 1, textColor: "green", strokeColor: "c", strokeWidth: 1, captionPreset: "capcut" };
  const resolved = resolveJobSettings(job, globalSettings);
  assert.equal(resolved.textColor, "green");
});

test("music and title-card fields are plain job state, not resolved against globals", () => {
  const job = createJob({ musicVolume: 0.5, titleCardEnabled: true, titleCardText: "Custom Title" });
  assert.equal(job.musicVolume, 0.5);
  assert.equal(job.titleCardEnabled, true);
  assert.equal(job.titleCardText, "Custom Title");
  // resolveJobSettings only concerns itself with JOB_OVERRIDE_FIELDS.
  const resolved = resolveJobSettings(job, GLOBAL_SETTINGS);
  assert.equal(resolved.musicVolume, undefined);
  assert.equal(resolved.titleCardEnabled, undefined);
});
