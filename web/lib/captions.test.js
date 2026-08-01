const test = require("node:test");
const assert = require("node:assert/strict");
const { computeWordTimings, buildSubsFromWords, sanitizeText } = require("./captions.js");

test("computeWordTimings distributes duration proportionally to word length", () => {
  const times = computeWordTimings("a bb ccc", 6);
  assert.equal(times.length, 3);
  assert.equal(times[0].text, "a");
  assert.equal(times[2].text, "ccc");
  // Longer words get more time.
  assert.ok((times[2].end - times[2].start) > (times[0].end - times[0].start));
  // Contiguous coverage, ends exactly at totalDuration.
  assert.equal(times[0].start, 0);
  assert.ok(Math.abs(times[times.length - 1].end - 6) < 1e-9);
});

test("computeWordTimings falls back to ~150wpm (0.4s/word) with no real duration", () => {
  const times = computeWordTimings("one two three four", 0);
  assert.equal(times.length, 4);
  assert.ok(Math.abs(times[3].end - 1.6) < 1e-9); // 4 words * 0.4s
});

test("computeWordTimings ignores lone punctuation tokens as words", () => {
  const times = computeWordTimings("hello , world !", 2);
  assert.deepEqual(times.map(t => t.text), ["hello", "world"]);
});

test("computeWordTimings respects paragraph breaks (still flattens to one timeline)", () => {
  const times = computeWordTimings("hi there\n\nbye now", 4);
  assert.deepEqual(times.map(t => t.text), ["hi", "there", "bye", "now"]);
});

test("buildSubsFromWords combines two short adjacent words under the char/gap limits", () => {
  const words = [
    { text: "I", start: 0, end: 0.2 },
    { text: "am", start: 0.25, end: 0.5 }, // gap 0.05s < 0.35s, combined len 4 <= 14
  ];
  const subs = buildSubsFromWords(words);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].text, "I am");
  assert.equal(subs[0].start, 0);
  assert.equal(subs[0].end, 0.5);
});

test("buildSubsFromWords keeps words separate when combined text exceeds 14 chars", () => {
  const words = [
    { text: "extraordinary", start: 0, end: 1 },
    { text: "word", start: 1.05, end: 1.5 },
  ];
  const subs = buildSubsFromWords(words);
  assert.equal(subs.length, 2);
});

test("buildSubsFromWords keeps words separate when the gap is >= 0.35s", () => {
  const words = [
    { text: "ok", start: 0, end: 0.2 },
    { text: "go", start: 0.6, end: 0.8 }, // gap 0.4s
  ];
  const subs = buildSubsFromWords(words);
  assert.equal(subs.length, 2);
});

test("buildSubsFromWords handles an odd trailing word with no pair", () => {
  const words = [
    { text: "solo", start: 0, end: 0.3 },
  ];
  const subs = buildSubsFromWords(words);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].text, "solo");
});

test("sanitizeText strips control characters", () => {
  assert.equal(sanitizeText("hello\x01\x1fworld"), "helloworld");
  assert.equal(sanitizeText("keep\ttabs\nand\nnewlines"), "keep\ttabs\nand\nnewlines");
});

test("sanitizeText strips lone surrogates but keeps valid surrogate pairs", () => {
  assert.equal(sanitizeText("a\uD800b"), "ab"); // lone high surrogate
  assert.equal(sanitizeText("a\uDC00b"), "ab"); // lone low surrogate
  assert.equal(sanitizeText("a😀b"), "a😀b"); // valid emoji pair kept
});

test("sanitizeText returns empty string for non-string input", () => {
  assert.equal(sanitizeText(null), "");
  assert.equal(sanitizeText(undefined), "");
});
