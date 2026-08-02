// Pure batch-job data model — no DOM, no ffmpeg, no Worker globals. Loaded
// as a classic <script> in the browser (declares these as globals, consumed
// unqualified by app.js) and as a plain require()-able module in tests.
//
// A "job" is one video's worth of state: content (premise/story/background),
// per-job overrides for the style/output fields that also exist as global
// settings, and render progress/results. resolveJobSettings is the one seam
// between "global defaults" (the existing settings panel, untouched) and
// "per-job overrides" — nothing else needs to know both exist.

const JOB_OVERRIDE_FIELDS = [
  "voice", "resW", "resH", "fps",
  "font", "fontSize", "positionY", "textColor", "strokeColor", "strokeWidth",
  "captionPreset", "ttsEngine",
];

// Inert today — reserved so a future scheduled-upload feature doesn't need
// to migrate the job shape. `targets` will hold e.g. ["youtube","tiktok"].
function createPublishState() {
  return { targets: [], scheduledAt: null, status: "none" };
}

function makeJobId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "job-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

// `overrides` may set any field below directly (mainly useful for tests);
// real callers build a job then mutate its fields as the user edits it.
function createJob(overrides) {
  const job = {
    id: makeJobId(),
    status: "draft", // draft -> queued -> story -> voice -> transcode -> render -> done | error
    progressPct: 0,
    progressLabel: "",
    error: null,

    premise: "",
    story: "",
    bgFile: null,
    bgUrl: null,
    bgUnsupportedCodec: null,
    bgTranscoded: null,

    // Per-job overrides for fields that also exist in the global settings
    // panel. null/undefined means "inherit the global default" — see
    // resolveJobSettings. Keys intentionally mirror SETTINGS_FIELDS in
    // web/app.js (minus apiKey/provider/model/storyLength, which are
    // account/story-generation config, not per-video render config).
    voice: null,
    resW: null,
    resH: null,
    fps: null,
    font: null,
    fontSize: null,
    positionY: null,
    textColor: null,
    strokeColor: null,
    strokeWidth: null,
    captionPreset: null, // "capcut" (one word at a time) | "classic" (grouped phrases)
    ttsEngine: null, // "piper" | "kokoro" | "openaiTts" | "elevenlabs" | "browserSpeech"

    // Music and title card aren't simple scalar overrides (files, booleans)
    // so they don't go through resolveJobSettings' null-means-inherit
    // mechanism — each job either has its own music/title-card state or
    // doesn't; there's no "global music track" to fall back to.
    musicFile: null,
    musicVolume: 0.25, // 0..1, mixed under the narration track
    titleCardEnabled: false,
    titleCardText: null, // null = auto-extract from the story's first line

    resultBlob: null,
    resultUrl: null,

    publish: createPublishState(),

    createdAt: Date.now(),
  };
  return Object.assign(job, overrides || {});
}

// Merges a job's per-field overrides on top of the global settings object
// (the same shape saveSettings()/loadSettings() in app.js read/write),
// producing the concrete values to actually render with. A job field is
// used only when it's set to something other than null/undefined/"" —
// an untouched override field falls back to the global value.
function resolveJobSettings(job, globalSettings) {
  const resolved = {};
  for (const key of JOB_OVERRIDE_FIELDS) {
    const jobValue = job[key];
    resolved[key] = (jobValue === null || jobValue === undefined || jobValue === "")
      ? globalSettings[key]
      : jobValue;
  }
  return resolved;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { JOB_OVERRIDE_FIELDS, createJob, resolveJobSettings, makeJobId };
}
