const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeWordTimings, alignWordsFromCharacters, alignWordsBySequence, snapPausesToWords,
  countFirstParagraphWords, groupWords, buildSubsFromWords, buildKaraokeGroups, buildWordCues, sanitizeText,
  expandAitahForSpeech,
} = require("./captions.js");

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

test("alignWordsBySequence uses real ASR timing for exact word matches", () => {
  const asrWords = [
    { text: " hi", start: 0, end: 0.3 },
    { text: " there", start: 0.3, end: 0.8 },
  ];
  const words = alignWordsBySequence("hi there", asrWords, 1);
  assert.deepEqual(words.map(w => w.text), ["hi", "there"]);
  assert.equal(words[0].start, 0);
  assert.equal(words[0].end, 0.3);
  assert.equal(words[1].start, 0.3);
  assert.equal(words[1].end, 0.8);
});

test("alignWordsBySequence interpolates an unmatched word between two real anchors", () => {
  // Real Whisper behavior confirmed live: misheard word ("AITAH" -> "ADA")
  // in the middle of an otherwise-matching sentence.
  const asrWords = [
    { text: " ADA", start: 0, end: 0.3 },
    { text: " for", start: 0.3, end: 0.6 },
    { text: " this", start: 0.6, end: 0.9 },
  ];
  const words = alignWordsBySequence("AITAH for this", asrWords, 1);
  assert.deepEqual(words.map(w => w.text), ["AITAH", "for", "this"]);
  // "AITAH" didn't match "ADA" — interpolated between clip start and "for"'s real start.
  assert.equal(words[0].start, 0);
  assert.ok(words[0].end <= words[1].start + 1e-9);
  assert.equal(words[1].start, 0.3);
  assert.equal(words[2].end, 0.9);
});

test("alignWordsBySequence handles a token Whisper split in two (real repro: \"$15,000\" -> \" $15\" + \",000\")", () => {
  const asrWords = [
    { text: " my", start: 0, end: 0.2 },
    { text: " $15", start: 0.2, end: 0.5 },
    { text: ",000", start: 0.5, end: 0.9 },
    { text: " inheritance", start: 0.9, end: 1.4 },
  ];
  const words = alignWordsBySequence("my $15,000 inheritance", asrWords, 1.5);
  assert.deepEqual(words.map(w => w.text), ["my", "$15,000", "inheritance"]);
  assert.equal(words[0].start, 0);
  assert.equal(words[0].end, 0.2);
  // "$15,000" has no exact match (neither "15000" nor split tokens equal
  // the normalized whole) — interpolated between "my" and "inheritance".
  assert.ok(words[1].start >= 0.2);
  assert.ok(words[1].end <= 0.9 + 1e-9);
  assert.equal(words[2].start, 0.9);
  assert.equal(words[2].end, 1.4);
});

test("alignWordsBySequence returns null when nothing matches at all", () => {
  const asrWords = [{ text: "zzz", start: 0, end: 1 }, { text: "qqq", start: 1, end: 2 }];
  const words = alignWordsBySequence("hello world", asrWords, 2);
  assert.equal(words, null);
});

test("alignWordsBySequence returns null for empty text or empty ASR output", () => {
  assert.equal(alignWordsBySequence("", [{ text: "hi", start: 0, end: 1 }], 1), null);
  assert.equal(alignWordsBySequence("hi there", [], 1), null);
});

test("snapPausesToWords redistributes words around a real detected pause near a sentence end", () => {
  const words = computeWordTimings("stop. then continue talking here", 10);
  const sentenceEndTime = words[0].end; // estimated pause point after "stop."
  // Real pause is later than the estimate guessed — should pull "stop."
  // (and nothing after it, since it's the anchor) forward to the real time.
  const realPause = { start: sentenceEndTime + 0.3, end: sentenceEndTime + 0.7 };
  const snapped = snapPausesToWords(words, [realPause], 10);
  assert.equal(snapped[0].text, "stop.");
  assert.ok(Math.abs(snapped[0].end - realPause.start) < 1e-9);
  // Words after the anchor still cover the full remaining span up to totalDuration.
  assert.ok(Math.abs(snapped[snapped.length - 1].end - 10) < 1e-6);
});

test("snapPausesToWords leaves timing unchanged when no gap is within tolerance", () => {
  const words = computeWordTimings("stop. then go", 5);
  const farGap = { start: 100, end: 100.5 };
  const snapped = snapPausesToWords(words, [farGap], 5, 0.5);
  assert.deepEqual(snapped, words);
});

test("snapPausesToWords returns words unchanged with no pause gaps", () => {
  const words = computeWordTimings("hello world", 2);
  assert.equal(snapPausesToWords(words, [], 2), words);
  assert.equal(snapPausesToWords(words, null, 2), words);
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

test("groupWords: respects maxWords beyond 2", () => {
  const words = [
    { text: "a", start: 0, end: 0.1 },
    { text: "b", start: 0.1, end: 0.2 },
    { text: "c", start: 0.2, end: 0.3 },
    { text: "d", start: 0.3, end: 0.4 },
  ];
  const groups = groupWords(words, { maxWords: 3, maxChars: 100, maxGapSec: 1 });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].length, 3);
  assert.equal(groups[1].length, 1);
});

test("groupWords: stops a group at maxChars even under maxWords", () => {
  const words = [
    { text: "extraordinary", start: 0, end: 1 },
    { text: "word", start: 1, end: 1.5 },
    { text: "hi", start: 1.5, end: 1.6 },
  ];
  const groups = groupWords(words, { maxWords: 3, maxChars: 14, maxGapSec: 1 });
  // "extraordinary" alone is already 13 chars; adding " word" (18 total) exceeds 14.
  assert.equal(groups[0].length, 1);
  assert.equal(groups[0][0].text, "extraordinary");
});

test("groupWords: counts an emoji as one character, not two UTF-16 code units", () => {
  const words = [
    { text: "fire", start: 0, end: 0.3 },
    { text: "🔥", start: 0.3, end: 0.5 }, // U+1F525 FIRE, a surrogate pair
  ];
  // "fire 🔥" is 6 visual characters, well under maxChars — a
  // .length-based (UTF-16 code unit) count would see 7 and wrongly split
  // this into two groups.
  const groups = groupWords(words, { maxWords: 2, maxChars: 14, maxGapSec: 1 });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
});

test("groupWords: default params reproduce buildSubsFromWords exactly", () => {
  const words = [
    { text: "hi", start: 0, end: 0.1 },
    { text: "there", start: 0.15, end: 0.4 },
    { text: "friend", start: 0.5, end: 0.8 },
  ];
  const viaGroupWords = groupWords(words).map(g => ({
    start: g[0].start, end: g[g.length - 1].end, text: g.map(w => w.text).join(" "),
  }));
  assert.deepEqual(viaGroupWords, buildSubsFromWords(words));
});

test("buildKaraokeGroups: groups up to 3 words, keeps per-word timings intact", () => {
  const words = [
    { text: "this", start: 0, end: 0.2 },
    { text: "is", start: 0.2, end: 0.35 },
    { text: "great", start: 0.35, end: 0.7 },
  ];
  const groups = buildKaraokeGroups(words);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].words.length, 3);
  assert.equal(groups[0].start, 0);
  assert.equal(groups[0].end, 0.7);
  assert.deepEqual(groups[0].words[1], { text: "is", start: 0.2, end: 0.35 });
});

test("buildKaraokeGroups: splits on a large gap even under maxWords/maxChars", () => {
  const words = [
    { text: "hi", start: 0, end: 0.1 },
    { text: "there", start: 2, end: 2.3 }, // gap 1.9s
  ];
  const groups = buildKaraokeGroups(words);
  assert.equal(groups.length, 2);
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

test("expandAitahForSpeech spells out AITAH and AITA, case-insensitively", () => {
  assert.equal(expandAitahForSpeech("AITAH for eating the last slice?"), "am I the asshole for eating the last slice?");
  assert.equal(expandAitahForSpeech("aitah for this?"), "am I the asshole for this?");
  assert.equal(expandAitahForSpeech("AITA for leaving early?"), "am I the asshole for leaving early?");
});

test("expandAitahForSpeech doesn't touch words that merely contain the pattern", () => {
  assert.equal(expandAitahForSpeech("WAITAHOUR and AITAHOLIC are not AITAH"), "WAITAHOUR and AITAHOLIC are not am I the asshole");
});

test("expandAitahForSpeech leaves the rest of the story untouched", () => {
  const story = "AITAH for this? My sister said AITA too. Anyway here's the story.";
  assert.equal(expandAitahForSpeech(story), "am I the asshole for this? My sister said am I the asshole too. Anyway here's the story.");
});

test("expandAitahForSpeech returns empty string for non-string input", () => {
  assert.equal(expandAitahForSpeech(null), "");
  assert.equal(expandAitahForSpeech(undefined), "");
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
