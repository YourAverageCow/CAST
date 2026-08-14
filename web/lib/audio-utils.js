// Pure audio-sample utilities — no DOM, no fetch, no Worker/ffmpeg globals.
// Loaded via importScripts() in web/tts-worker.js (declares these as
// globals, consumed unqualified there) and as a plain require()-able module
// in tests — same isomorphic pattern as every other web/lib/*.js file.

// Trims each end's near-silence (RMS below threshold) up to maxTrimSec —
// used to give Kokoro's per-sentence-chunk concatenation a clean, controlled
// inter-chunk gap instead of stacking each chunk's own inconsistent leading/
// trailing silence (which ranges ~40ms-400ms+ with no correlation to
// punctuation) directly against the next chunk's. See web/tts-worker.js's
// generateKokoro() for how the trimmed chunks get a single fixed gap
// re-inserted between them.
function trimSilenceFloat32(samples, sampleRate, maxTrimSec) {
  const threshold = 0.01;
  const maxTrimSamples = Math.floor(maxTrimSec * sampleRate);
  let start = 0;
  while (start < samples.length && start < maxTrimSamples && Math.abs(samples[start]) < threshold) start++;
  let end = samples.length;
  const minEnd = Math.max(start, samples.length - maxTrimSamples);
  while (end > minEnd && Math.abs(samples[end - 1]) < threshold) end--;
  return samples.subarray(start, end);
}

// Encodes mono 32-bit-float PCM samples as a WAV buffer — same byte layout
// Kokoro's own (unexported) RawAudio.toWav() produces (RIFF/WAVE, fmt chunk
// audioFormat=3 IEEE-float, 1 channel, 32 bits/sample). Needed because
// stitching multiple chunks' raw Float32Array audio together means there's
// no single RawAudio instance left to call the library's own toWav() on.
function encodeMonoFloat32Wav(samples, sampleRate) {
  const bytesPerSample = 4;
  const buffer = new ArrayBuffer(44 + bytesPerSample * samples.length);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF"); view.setUint32(4, 36 + bytesPerSample * samples.length, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, bytesPerSample * sampleRate, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 32, true);
  writeStr(36, "data"); view.setUint32(40, bytesPerSample * samples.length, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += bytesPerSample) view.setFloat32(offset, samples[i], true);
  return buffer;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { trimSilenceFloat32, encodeMonoFloat32Wav };
}
