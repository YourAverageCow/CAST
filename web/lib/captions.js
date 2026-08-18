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

// Distributes `words` (plain strings) proportionally across [startTime,
// endTime] using the same wordWeight heuristic computeWordTimings uses.
// Shared by alignWordsBySequence and snapPausesToWords to fill the gap
// between two REAL anchors (ASR-matched words, or detected pause
// boundaries) with the best available estimate, scoped to just that
// bounded span instead of the whole clip — so gaps self-correct locally
// rather than reintroducing the global drift this whole feature exists to fix.
function distributeWordsInSpan(words, startTime, endTime) {
  const weights = words.map(wordWeight);
  const weightTotal = weights.reduce((s, w) => s + w, 0) || 1;
  const span = Math.max(0, endTime - startTime);
  const times = [];
  let t = startTime;
  for (let i = 0; i < words.length; i++) {
    const dur = (weights[i] / weightTotal) * span;
    times.push({ text: words[i], start: t, end: t + dur });
    t += dur;
  }
  return times;
}

function normalizeForMatch(w) {
  return (w || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Aligns Whisper-style word-level ASR output (real timestamps, but the
// transcribed words may not match the known script 1:1 — numbers spoken
// differently, misheard words, merged/split tokens; confirmed live: a real
// Whisper run split "$15,000" into two separate word tokens) onto the
// KNOWN narration text via an LCS-style sequence alignment. Unlike
// alignWordsFromCharacters below (character-level, needs an exactly
// reconstructable string), this tolerates insertions/deletions on either
// side: matched known-words get the ASR word's real timing, and unmatched
// runs are filled in between the nearest real anchors (or the clip's start
// /end) via distributeWordsInSpan above — a few ASR misses self-correct
// locally instead of drifting. Captions always show the KNOWN script's
// word, never Whisper's transcription. Returns null (never throws) if
// nothing matched at all, so callers fall back to computeWordTimings.
function alignWordsBySequence(text, asrWords, totalDuration) {
  const paragraphs = (text || "").split(/\n\s*\n/).filter(p => p.trim());
  const knownWords = paragraphs.flatMap(splitParagraphWords);
  if (!knownWords.length || !Array.isArray(asrWords) || !asrWords.length) return null;

  const a = knownWords.map(normalizeForMatch);
  const b = asrWords.map(w => normalizeForMatch(w.text));

  const n = a.length, m = b.length;
  // LCS DP table — word counts are small (a few hundred at most for a
  // typical story), so O(n*m) is trivial.
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = (a[i - 1] && a[i - 1] === b[j - 1])
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const matches = []; // {i, j} — knownWords[i] matched to asrWords[j]
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] && a[i - 1] === b[j - 1]) {
      matches.push({ i: i - 1, j: j - 1 });
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  matches.reverse();
  if (!matches.length) return null;

  const times = new Array(n);
  for (const match of matches) {
    times[match.i] = { text: knownWords[match.i], start: asrWords[match.j].start, end: asrWords[match.j].end };
  }

  let idx = 0;
  while (idx < n) {
    if (times[idx]) { idx++; continue; }
    let gapEnd = idx;
    while (gapEnd < n && !times[gapEnd]) gapEnd++;
    const spanStart = idx > 0 ? times[idx - 1].end : 0;
    const spanEnd = gapEnd < n ? times[gapEnd].start : totalDuration;
    const filled = distributeWordsInSpan(knownWords.slice(idx, gapEnd), spanStart, spanEnd);
    for (let k = 0; k < filled.length; k++) times[idx + k] = filled[k];
    idx = gapEnd;
  }
  return times;
}

// Nudges computeWordTimings' punctuation-pause ESTIMATE to match REAL
// detected silence in the actual audio (see detectSilenceGaps in app.js —
// a lightweight Web Audio energy-threshold pass, not a trained VAD model).
// Every word ending in sentence/clause punctuation is a candidate pause
// point; if a real gap starts within `toleranceSec` of that word's
// estimated end, its timing becomes a real anchor and everything between
// anchors is redistributed via distributeWordsInSpan — so one correctly
// detected pause corrects every word around it, not just the word it
// happened to land near. Returns `words` unchanged if no gap is close
// enough to any candidate pause point.
function snapPausesToWords(words, pauseGaps, totalDuration, toleranceSec) {
  if (!Array.isArray(words) || !words.length) return words;
  if (!Array.isArray(pauseGaps) || !pauseGaps.length) return words;
  toleranceSec = toleranceSec == null ? 0.5 : toleranceSec;

  const anchors = []; // {index, time} — words[index] should END exactly at time
  for (let i = 0; i < words.length; i++) {
    const w = words[i].text || "";
    if (!/[.!?,;:]["')]?$/.test(w)) continue;
    let best = null, bestDist = toleranceSec;
    for (const gap of pauseGaps) {
      const dist = Math.abs(gap.start - words[i].end);
      if (dist <= bestDist) { best = gap; bestDist = dist; }
    }
    if (best) anchors.push({ index: i, time: best.start });
  }
  if (!anchors.length) return words;

  const knownWords = words.map(w => w.text);
  const result = new Array(words.length);
  let prevIndex = -1, prevTime = 0;
  for (const anchor of anchors) {
    const span = distributeWordsInSpan(knownWords.slice(prevIndex + 1, anchor.index + 1), prevTime, anchor.time);
    for (let k = 0; k < span.length; k++) result[prevIndex + 1 + k] = span[k];
    prevIndex = anchor.index;
    prevTime = anchor.time;
  }
  if (prevIndex + 1 < words.length) {
    const span = distributeWordsInSpan(knownWords.slice(prevIndex + 1), prevTime, totalDuration || words[words.length - 1].end);
    for (let k = 0; k < span.length; k++) result[prevIndex + 1 + k] = span[k];
  }
  return result;
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

// TTS engines have no idea "AITAH"/"AITA" are initialisms — spoken
// literally they come out as a garbled run of letters. This ONLY
// transforms the copy of the text handed to the TTS engine — captions/
// story text keep showing "AITAH" exactly as written; only what gets
// spoken changes. "AITAH" is matched before the shorter "AITA" pattern
// gets a chance to see it, since "AITAH" has no word boundary right after
// "AITA" — the two patterns can't double-match the same span.
function expandAitahForSpeech(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/\bAITAH\b/gi, "am I the asshole")
    .replace(/\bAITA\b/gi, "am I the asshole");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    computeWordTimings, alignWordsFromCharacters, alignWordsBySequence, snapPausesToWords,
    countFirstParagraphWords, buildSubsFromWords, buildWordCues, sanitizeText,
    expandAitahForSpeech,
  };
}
