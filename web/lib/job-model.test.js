const test = require("node:test");
const assert = require("node:assert/strict");
const { createJob, resolveJobSettings, makeJobId } = require("./job-model.js");

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
  assert.deepEqual(job.publish, { targets: [], scheduledAt: null, status: "none" });
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
  const globalSettings = { voice: "en_US-ryan-medium", resW: 1080, resH: 1920, fps: 30, font: "Arial", fontSize: 68, positionY: 0.55, textColor: "white", strokeColor: "black", strokeWidth: 3 };
  const resolved = resolveJobSettings(job, globalSettings);
  assert.deepEqual(resolved, globalSettings);
});

test("resolveJobSettings prefers a job's own override over the global default", () => {
  const job = createJob({ voice: "en_GB-alan-medium", fontSize: 90 });
  const globalSettings = { voice: "en_US-ryan-medium", resW: 1080, resH: 1920, fps: 30, font: "Arial", fontSize: 68, positionY: 0.55, textColor: "white", strokeColor: "black", strokeWidth: 3 };
  const resolved = resolveJobSettings(job, globalSettings);
  assert.equal(resolved.voice, "en_GB-alan-medium");
  assert.equal(resolved.fontSize, 90);
  assert.equal(resolved.resW, 1080); // still falls back for untouched fields
});

test("resolveJobSettings treats an empty string override as unset", () => {
  const job = createJob({ textColor: "" });
  const globalSettings = { voice: "v", resW: 1, resH: 1, fps: 1, font: "f", fontSize: 1, positionY: 1, textColor: "green", strokeColor: "c", strokeWidth: 1 };
  const resolved = resolveJobSettings(job, globalSettings);
  assert.equal(resolved.textColor, "green");
});
