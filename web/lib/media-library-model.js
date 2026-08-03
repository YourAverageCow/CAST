// Pure media-library record model — no IndexedDB, no Blob, no DOM. Loaded as
// a classic <script> in the browser (declares these as globals, consumed
// unqualified by app.js) and as a plain require()-able module in tests, same
// isomorphic pattern as job-model.js. The actual IndexedDB storage/CRUD glue
// lives in app.js — there's no way to unit-test real IndexedDB in this
// repo's zero-dependency Node test setup, so only the record-shape/kind
// logic below is pure enough to live here.

function makeMediaItemId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "media-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

// Video vs audio, inferred from a File/Blob's reported MIME type. Defaults
// to "video" when the type is missing/unrecognized — matches the existing
// bc-upload-input's accept="video/*" bias (background video is the more
// common upload today).
function inferKindFromMimeType(mimeType) {
  if (mimeType && mimeType.startsWith("audio/")) return "audio";
  return "video";
}

// Builds the metadata record stored alongside a file's blob. Takes a
// File-like object ({name, type, size}) rather than a real File so this
// stays callable from Node tests with a plain object literal.
function buildMediaItemRecord(file, kind) {
  return {
    id: makeMediaItemId(),
    kind: kind || inferKindFromMimeType(file && file.type),
    name: (file && file.name) || "untitled",
    mimeType: (file && file.type) || "",
    size: (file && file.size) || 0,
    addedAt: Date.now(),
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { makeMediaItemId, inferKindFromMimeType, buildMediaItemRecord };
}
