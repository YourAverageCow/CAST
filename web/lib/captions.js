// Pure caption/text logic — no DOM, no ffmpeg, no Worker globals. Loaded as
// a classic <script> in the browser (declares these as globals, consumed
// unqualified by app.js) and as a plain require()-able module in tests.

// Splits a single paragraph into word tokens — whitespace-separated,
// standalone punctuation dropped. Shared by computeWordTimings and
// countFirstParagraphWords so the two stay in lockstep: the Nth word this
// produces for a paragraph is always the same Nth entry computeWordTimings
// puts in its flattened words[] array.
function splitParagraphWords(para) {
  return para.split(/\s+/).filter(w => w && !/^[.,!?;:]+$/.test(w));
}

// This is an ESTIMATE, not real forced alignment — there's no access to the
// audio waveform itself, only its total duration. We distribute that
// duration across words proportional to a per-word "weight" meant to track
// roughly how long each word takes to actually say, which is more than just
// character count:
//  - digit-heavy tokens (numbers, currency, dates) are spoken far longer
//    than their character count implies — "$15,000" is 7 characters but is
//    SPOKEN as "fifteen thousand dollars", closer to 24. Left unweighted,
//    every such token this estimate walks past leaves the rest of the video
//    increasingly out of sync with the real audio (errors compound linearly
//    through the transcript — exactly the "captions run ahead of the audio
//    later in the video" failure mode).
//  - trailing sentence/clause punctuation gets extra weight to model the
//    brief pause real speech takes at a comma or sentence end, which a pure
//    character-count model ignores entirely.
// Engines that can report REAL per-word/character timing (see
// alignWordsFromCharacters below) should use that instead of this estimate
// — callers only fall back to this when an engine has no alignment data.
function wordWeight(w) {
  const digits = (w.match(/\d/g) || []).length;
  let weight = w.length + 1 + digits * 3;
  if (/[.!?]["')]?$/.test(w)) weight += 6;      // sentence-end pause
  else if (/[,;:]["')]?$/.test(w)) weight += 2; // comma/clause pause
  return weight;
}
function computeWordTimings(text, totalDuration) {
  // Fallback estimate: if no real duration, assume ~150 words/min (~0.4s/word).
  if (!totalDuration || totalDuration <= 0) {
    const wordCount = (text.trim().split(/\s+/).filter(Boolean)).length || 1;
    totalDuration = wordCount * 0.4;
  }
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
  const allWords = paragraphs.flatMap(splitParagraphWords);

  const weights = allWords.map(wordWeight);
  const weightTotal = weights.reduce((s, w) => s + w, 0) || 1;
  const perWeight = totalDuration / weightTotal;

  const times = [];
  let t = 0;
  for (let i = 0; i < allWords.length; i++) {
    const dur = weights[i] * perWeight;
    times.push({ text: allWords[i], start: t, end: t + dur });
    t += dur;
  }
  // Scale so last word ends exactly at totalDuration
  if (times.length && t > 0) {
    const scale = totalDuration / t;
    times.forEach(x => { x.start *= scale; x.end *= scale; });
  }
  return times;
}

// Builds real per-word timing from character-level forced alignment (e.g.
// ElevenLabs' /with-timestamps response: parallel `characters`/
// `startTimes`/`endTimes` arrays covering the exact text sent to the
// engine). Tokenizes `text` identically to computeWordTimings so the
// result lines up 1:1 with it (same word count/order — required for
// countFirstParagraphWords-based title-card sync to keep working
// regardless of which timing source produced the words[] array), then
// locates each word in turn within the reconstructed aligned string.
// Returns null (never throws) if the alignment doesn't actually correspond
// to `text` — e.g. a word can't be found in order — so callers can safely
// fall back to computeWordTimings's estimate instead of producing broken
// timings from a mismatched alignment.
function alignWordsFromCharacters(text, characters, startTimes, endTimes) {
  if (!Array.isArray(characters) || !characters.length) return null;
  if (characters.length !== startTimes.length || characters.length !== endTimes.length) return null;
  const alignedText = characters.join("");
  const paragraphs = (text || "").split(/\n\s*\n/).filter(p => p.trim());
  const allWords = paragraphs.flatMap(splitParagraphWords);
  if (!allWords.length) return null;

  const times = [];
  let cursor = 0;
  for (const w of allWords) {
    const idx = alignedText.indexOf(w, cursor);
    if (idx === -1) return null;
    const endIdx = idx + w.length - 1;
    times.push({ text: w, start: startTimes[idx], end: endTimes[endIdx] });
    cursor = idx + w.length;
  }
  return times;
}

function buildSubsFromWords(words) {
  const subs = [];
  let i = 0;
  const maxChars = 14;
  while (i < words.length) {
    let takeTwo = false;
    if (i + 1 < words.length) {
      const combined = words[i].text + " " + words[i + 1].text;
      if (combined.length <= maxChars && (words[i + 1].start - words[i].end) < 0.35) takeTwo = true;
    }
    const g = takeTwo ? [words[i], words[i + 1]] : [words[i]];
    subs.push({ start: g[0].start, end: g[g.length - 1].end, text: g.map(w => w.text).join(" ") });
    i += g.length;
  }
  return subs;
}

// "CapCut style" preset: one word on screen at a time, each shown exactly
// during its own spoken window — no grouping, no positional/highlight logic
// needed, just a 1:1 mapping. Deliberately simple: this reuses the same
// per-cue drawtext+enable() rendering path as the phrase-based preset with
// zero new rendering complexity, unlike a true multi-word karaoke-highlight
// effect (which would need precise sub-string pixel positioning inside a
// phrase, measured independently of how ffmpeg itself lays out the text).
function buildWordCues(words) {
  return words.map(w => ({ start: w.start, end: w.end, text: w.text }));
}

// Word count of the story's first paragraph, tokenized identically to
// computeWordTimings. Lets a caller (app.js, for the title-card sync) find
// exactly where the auto-extracted title line ends within the words[]
// array computeWordTimings produces, so those words can be split off from
// the rest of the narration/captions.
function countFirstParagraphWords(text) {
  const paragraphs = (text || "").split(/\n\s*\n/).filter(p => p.trim());
  return paragraphs.length ? splitParagraphWords(paragraphs[0]).length : 0;
}

// Remove characters TextEncoder/ffmpeg choke on (lone surrogates, control chars).
function sanitizeText(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")   // lone high surrogates
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1") // lone low surrogates
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ""); // control chars
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { computeWordTimings, alignWordsFromCharacters, countFirstParagraphWords, buildSubsFromWords, buildWordCues, sanitizeText };
}
