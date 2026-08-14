const test = require("node:test");
const assert = require("node:assert/strict");
const { trimSilenceFloat32, encodeMonoFloat32Wav } = require("./audio-utils.js");

test("trimSilenceFloat32 trims near-silent samples from both ends", () => {
  const samples = new Float32Array([0.001, 0.002, 0.5, 0.6, 0.5, 0.001]);
  const trimmed = trimSilenceFloat32(samples, 8000, 1);
  assert.deepEqual(Array.from(trimmed), [0.5, 0.6, 0.5].map(Math.fround));
});

test("trimSilenceFloat32 never trims past maxTrimSec worth of samples, even if silence continues", () => {
  const sampleRate = 100;
  const samples = new Float32Array(50).fill(0); // 0.5s of pure silence
  // maxTrimSec=0.1 -> only the first/last 10 samples are eligible to trim
  const trimmed = trimSilenceFloat32(samples, sampleRate, 0.1);
  assert.equal(trimmed.length, 30); // 50 - 10 (start) - 10 (end)
});

test("trimSilenceFloat32 leaves loud audio with no silent edges untouched", () => {
  const samples = new Float32Array([0.9, 0.8, 0.9]);
  const trimmed = trimSilenceFloat32(samples, 8000, 1);
  // Float32Array stores the nearest float32 representation, not the exact
  // JS double literal — compare against Math.fround'd expectations.
  assert.deepEqual(Array.from(trimmed), [0.9, 0.8, 0.9].map(Math.fround));
});

test("encodeMonoFloat32Wav produces a valid RIFF/WAVE header with the right sample rate and byte counts", () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1]);
  const sampleRate = 24000;
  const buffer = encodeMonoFloat32Wav(samples, sampleRate);
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const str = (off, len) => String.fromCharCode(...bytes.slice(off, off + len));
  assert.equal(str(0, 4), "RIFF");
  assert.equal(str(8, 4), "WAVE");
  assert.equal(str(12, 4), "fmt ");
  assert.equal(dv.getUint16(20, true), 3); // IEEE float format code
  assert.equal(dv.getUint16(22, true), 1); // mono
  assert.equal(dv.getUint32(24, true), sampleRate);
  assert.equal(dv.getUint16(34, true), 32); // bits per sample
  assert.equal(str(36, 4), "data");
  assert.equal(dv.getUint32(40, true), samples.length * 4);
  assert.equal(buffer.byteLength, 44 + samples.length * 4);
});

test("encodeMonoFloat32Wav round-trips sample values exactly", () => {
  const samples = new Float32Array([0, 0.25, -0.75, 1, -1]);
  const buffer = encodeMonoFloat32Wav(samples, 24000);
  const dv = new DataView(buffer);
  const readBack = [];
  for (let i = 0; i < samples.length; i++) readBack.push(dv.getFloat32(44 + i * 4, true));
  assert.deepEqual(readBack, Array.from(samples));
});

test("encodeMonoFloat32Wav handles zero samples without throwing", () => {
  const buffer = encodeMonoFloat32Wav(new Float32Array(0), 24000);
  assert.equal(buffer.byteLength, 44);
});
