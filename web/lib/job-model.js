// Pure batch-job data model — no DOM, no ffmpeg, no Worker globals. Loaded
// as a classic <script> in the browser (declares these as globals, consumed
// unqualified by app.js) and as a plain require()-able module in tests.
//
// A "job" is one video's worth of state: content (premise/story/background),
// per-job overrides for the style/output fields that also exist as global
// settings, and render progress/results. resolveJobSettings is the one seam
// between "global defaults" (the existing settings panel, untouched) and
// "per-job overrides" — nothing else needs to know both exist.

// captionPreset now holds the caption GROUPING mode ("word"/"phrase"/
// "karaoke") — repurposed from its old "capcut"/"classic" values rather
// than adding a parallel field, since it's always meant exactly one thing:
// how words get grouped on screen. `font` similarly now holds a
// web/lib/caption-presets.js CAPTION_FONTS id (e.g. "anton") instead of a
// CSS font-family name — see that file for why the old font list never
// actually affected the render.
const JOB_OVERRIDE_FIELDS = [
  "voice", "resW", "resH", "fps",
  "font", "fontSize", "positionY", "textColor", "strokeColor", "strokeWidth",
  "captionPreset", "captionUppercase", "highlightColor",
  "captionBox", "boxColor", "boxAlpha", "boxBorderW", "boxBevel",
  "captionShadow", "shadowColor", "shadowX", "shadowY",
  "captionEntrance",
  "ttsEngine",
];

// Publish/upload state — `targets` holds e.g. ["youtube"] today, room for
// ["tiktok","instagram"] later without another job-shape migration.
// status: "none" (never published) | "generating" (metadata/thumbnail being
// built) | "ready" (reviewed, not yet uploading) | "uploading" |
// "scheduled" (uploaded, YouTube will auto-publish at scheduledAt) |
// "uploaded" | "failed".
function createPublishState() {
  return {
    targets: [],
    accountId: null, // id of the youtube-accounts.json account to publish as
    status: "none",
    error: null,
    scheduledAt: null, // ISO string, or null = publish immediately at privacyStatus
    privacyStatus: "private", // private | unlisted | public
    categoryId: "24", // YouTube category id, default "Entertainment"
    title: null,
    description: null,
    tags: [],
    thumbnailBlob: null,
    thumbnailUrl: null,
    videoId: null, // YouTube's id once uploaded
    uploadProgressPct: 0,
  };
}

// Deliberately a separate, parallel state object rather than folding TikTok
// into createPublishState()'s "targets" field — TikTok's Content Posting
// API has a much narrower metadata surface than YouTube's (no separate
// description/tags/scheduling/custom-thumbnail-upload, just a title and a
// cover-frame timestamp into the video itself), so generalizing the two
// into one shape now would mean a bunch of YouTube-only fields sitting
// unused on every TikTok post, or vice versa. Revisit unifying them only
// once a third platform makes the shared shape actually pay for itself.
function createTiktokPublishState() {
  return {
    accountId: null, // id of the tiktok-accounts.json account to post as
    status: "none", // "none" | "uploading" | "posted" | "failed"
    error: null,
    title: null,
    videoCoverTimestampMs: 0,
    publishId: null, // TikTok's publish_id once posted
    uploadProgressPct: 0,
  };
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
    titleCardEnabled: true,
    titleCardText: null, // null = auto-extract from the story's first line

    resultBlob: null,
    resultUrl: null,

    publish: createPublishState(),
    tiktokPublish: createTiktokPublishState(),

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
  module.exports = { JOB_OVERRIDE_FIELDS, createJob, createPublishState, createTiktokPublishState, resolveJobSettings, makeJobId };
}
