// Pure caption/text logic — no DOM, no ffmpeg, no Worker globals. Loaded as
// a classic <script> in the browser (declares these as globals, consumed
// unqualified by app.js) and as a plain require()-able module in tests.

// Estimate per-word timing from the full audio duration.
// We align words to the audio by distributing the narration time across
// words proportional to character length (better than uniform since it
// reflects word size), and respect paragraph pauses in the source text.
function computeWordTimings(text, totalDuration) {
  // Fallback estimate: if no real duration, assume ~150 words/min (~0.4s/word).
  if (!totalDuration || totalDuration <= 0) {
    const wordCount = (text.trim().split(/\s+/).filter(Boolean)).length || 1;
    totalDuration = wordCount * 0.4;
  }
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
  const allWords = paragraphs.flatMap(para =>
    para.split(/\s+/).filter(w => w && !/^[.,!?;:]+$/.test(w))
  );

  const charTotal = allWords.reduce((s, w) => s + w.length + 1, 0) || 1;
  const perChar = totalDuration / charTotal;

  const times = [];
  let t = 0;
  for (const w of allWords) {
    const dur = (w.length + 1) * perChar;
    times.push({ text: w, start: t, end: t + dur });
    t += dur;
  }
  // Scale so last word ends exactly at totalDuration
  if (times.length && t > 0) {
    const scale = totalDuration / t;
    times.forEach(x => { x.start *= scale; x.end *= scale; });
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

// Remove characters TextEncoder/ffmpeg choke on (lone surrogates, control chars).
function sanitizeText(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")   // lone high surrogates
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1") // lone low surrogates
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ""); // control chars
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { computeWordTimings, buildSubsFromWords, buildWordCues, sanitizeText };
}
