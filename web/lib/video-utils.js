// Pure video-container inspection — no DOM, no File/fetch. Loaded as a
// classic <script> in the browser (declares these as globals, consumed
// unqualified by app.js) and as a plain require()-able module in tests.

// The bundled ffmpeg.wasm core has no usable AV1/VP8/VP9 decode path — feeding
// it those hangs forever with zero output (no error, no timeout). Sniff the
// MP4 sample-entry fourcc so we know to auto-convert before export instead of
// letting the user wait on a render that will never finish.
const UNSUPPORTED_VIDEO_CODECS = {
  av01: "AV1", vp09: "VP9", vp08: "VP8",
};

// Takes the raw file bytes (Uint8Array) and returns the unsupported codec's
// friendly name, or null if none of the known-bad fourccs are present.
function detectUnsupportedCodec(bytes) {
  const text = new TextDecoder("latin1").decode(bytes);
  for (const fourcc in UNSUPPORTED_VIDEO_CODECS) {
    if (text.includes(fourcc)) return UNSUPPORTED_VIDEO_CODECS[fourcc];
  }
  return null;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { UNSUPPORTED_VIDEO_CODECS, detectUnsupportedCodec };
}
