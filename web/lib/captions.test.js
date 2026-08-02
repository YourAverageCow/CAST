const test = require("node:test");
const assert = require("node:assert/strict");
const { computeWordTimings, alignWordsFromCharacters, countFirstParagraphWords, buildSubsFromWords, buildWordCues, sanitizeText } = require("./captions.js");

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

test("computeWordTimings gives digit-heavy tokens extra weight over same-length plain words", () => {
  const times = computeWordTimings("word 15,000", 10);
  const plain = times[0].end - times[0].start;
  const digitToken = times[1].end - times[1].start; // same char length as "word" (4) + comma
  assert.ok(digitToken > plain);
});

test("computeWordTimings gives sentence-ending words more weight than mid-sentence words of the same length", () => {
  const times = computeWordTimings("stop. then go", 10);
  const sentenceEnd = times[0].end - times[0].start; // "stop." (5 chars)
  const midSentence = times[1].end - times[1].start; // "then" (4 chars) — close in length
  // "stop." is only 1 char longer than "then" by raw length, but the
  // sentence-end pause weight should make its share noticeably bigger.
  assert.ok((sentenceEnd - midSentence) > 0.05 * 10);
});

test("alignWordsFromCharacters builds real per-word timing from character alignment", () => {
  const text = "hi there";
  const characters = [..."hi there"];
  const startTimes = characters.map((_, i) => i * 0.1);
  const endTimes = characters.map((_, i) => (i + 1) * 0.1);
  const words = alignWordsFromCharacters(text, characters, startTimes, endTimes);
  assert.deepEqual(words.map(w => w.text), ["hi", "there"]);
  assert.equal(words[0].start, 0);
  assert.equal(words[0].end, 0.2); // end time of the 2nd char ('i', index 1)
  assert.ok(Math.abs(words[1].start - 0.3) < 1e-9); // start time of 't' (index 3)
});

test("alignWordsFromCharacters returns null when a word can't be located in the aligned text", () => {
  const words = alignWordsFromCharacters("hello world", [..."goodbye"], [0,0,0,0,0,0,0], [1,1,1,1,1,1,1]);
  assert.equal(words, null);
});

test("alignWordsFromCharacters returns null on mismatched array lengths", () => {
  const words = alignWordsFromCharacters("hi", ["h", "i"], [0], [1, 1]);
  assert.equal(words, null);
});

test("countFirstParagraphWords counts only the first paragraph", () => {
  assert.equal(countFirstParagraphWords("AITAH for this?\n\nHere is the story body."), 3);
});

test("countFirstParagraphWords lines up with computeWordTimings' word indices", () => {
  const story = "AITAH for this?\n\nHere is the rest of it.";
  const n = countFirstParagraphWords(story);
  const words = computeWordTimings(story, 10);
  assert.deepEqual(words.slice(0, n).map(w => w.text), ["AITAH", "for", "this?"]);
  assert.equal(words[n].text, "Here");
});

test("countFirstParagraphWords ignores standalone punctuation tokens", () => {
  assert.equal(countFirstParagraphWords("hello , world !\n\nnext paragraph"), 2);
});

test("countFirstParagraphWords returns 0 for empty/blank text", () => {
  assert.equal(countFirstParagraphWords(""), 0);
  assert.equal(countFirstParagraphWords("   \n\n  "), 0);
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

test("buildWordCues maps each word 1:1 to its own cue, unlike buildSubsFromWords' grouping", () => {
  const words = [
    { text: "I", start: 0, end: 0.2 },
    { text: "am", start: 0.25, end: 0.5 },
    { text: "here", start: 0.55, end: 0.9 },
  ];
  const cues = buildWordCues(words);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues[0], { start: 0, end: 0.2, text: "I" });
  assert.deepEqual(cues[1], { start: 0.25, end: 0.5, text: "am" });
  assert.deepEqual(cues[2], { start: 0.55, end: 0.9, text: "here" });
});

test("buildWordCues preserves timing gaps between words instead of merging them", () => {
  const words = [{ text: "a", start: 0, end: 0.1 }, { text: "b", start: 5, end: 5.1 }];
  const cues = buildWordCues(words);
  assert.equal(cues[0].end, 0.1);
  assert.equal(cues[1].start, 5);
});
