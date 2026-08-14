const test = require("node:test");
const assert = require("node:assert/strict");
const {
  safeColor, buildCaptionCues, buildKaraokeCues, buildDrawtextFilterChain,
  buildAudioFilterChain, buildTitleCardOverlay, parseWavDurationSec,
} = require("./ffmpeg-filters.js");

function makeWav(durationSec, sampleRate) {
  sampleRate = sampleRate || 44100;
  const numSamples = Math.round(durationSec * sampleRate);
  const buf = new ArrayBuffer(44 + numSamples * 2);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF"); dv.setUint32(4, 36 + numSamples * 2, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  writeStr(36, "data"); dv.setUint32(40, numSamples * 2, true);
  return bytes;
}

test("safeColor accepts plain color names", () => {
  assert.equal(safeColor("white", "black"), "white");
});

test("safeColor accepts 6- and 8-digit hex", () => {
  assert.equal(safeColor("#ff00ff", "black"), "#ff00ff");
  assert.equal(safeColor("#ff00ff80", "black"), "#ff00ff80");
  assert.equal(safeColor("0xff00ff", "black"), "0xff00ff");
});

test("safeColor rejects anything that could break out of the filter-graph string", () => {
  // Colons/commas/quotes are filter-graph syntax; this is the actual attack
  // surface (style.textColor/strokeColor come straight from the UI).
  assert.equal(safeColor("white:x=10", "black"), "black");
  assert.equal(safeColor("white,drawbox=1", "black"), "black");
  assert.equal(safeColor("'; rm -rf /'", "black"), "black");
  assert.equal(safeColor(123, "black"), "black");
  assert.equal(safeColor(null, "black"), "black");
});

test("buildCaptionCues emits one cue per sub, with zero-padded sequential filenames", () => {
  const cues = buildCaptionCues([
    { start: 0, end: 1, text: "first" },
    { start: 1, end: 2, text: "second" },
  ]);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 0, end: 1, text: "first", file: "cap00000.txt" });
  assert.deepEqual(cues[1], { start: 1, end: 2, text: "second", file: "cap00001.txt" });
});

test("buildCaptionCues skips cues under 40ms", () => {
  assert.equal(buildCaptionCues([{ start: 0, end: 0.03, text: "blink" }]).length, 0);
});

test("buildCaptionCues skips cues with empty/whitespace-only text", () => {
  assert.equal(buildCaptionCues([{ start: 0, end: 1, text: "   " }]).length, 0);
});

test("buildCaptionCues trims text and does not renumber files around skipped cues", () => {
  const cues = buildCaptionCues([
    { start: 0, end: 1, text: "  padded  " },
    { start: 1, end: 1.01, text: "too short" }, // skipped: < 40ms
    { start: 2, end: 3, text: "kept" },
  ]);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, "padded");
  assert.equal(cues[1].file, "cap00001.txt"); // second *emitted* cue, not third input
});

const BASE_STYLE = { fontSize: 68, textColor: "white", strokeColor: "black", strokeWidth: 3, positionY: 0.55 };

test("buildDrawtextFilterChain emits one drawtext per cue gated by enable=between(t,start,end)", () => {
  const cues = buildCaptionCues([
    { start: 1.5, end: 2.25, text: "hello" },
    { start: 3, end: 4, text: "world" },
  ]);
  const { filterComplex, outLabel } = buildDrawtextFilterChain({ w: 1080, h: 1920, bgW: 1080, bgH: 1920, ...BASE_STYLE, cues });
  assert.equal(outLabel, "vout");
  assert.equal((filterComplex.match(/drawtext=/g) || []).length, 2);
  assert.match(filterComplex, /textfile=cap00000\.txt/);
  assert.match(filterComplex, /enable='between\(t\\,1\.500\\,2\.250\)'/);
  assert.match(filterComplex, /textfile=cap00001\.txt/);
  assert.match(filterComplex, /enable='between\(t\\,3\.000\\,4\.000\)'/);
  assert.match(filterComplex, /^\[0:v\]/);
  assert.match(filterComplex, /\[vout\]$/);
});

test("buildDrawtextFilterChain never uses sendcmd/reinit — regression check for the v52 class of bug", () => {
  // The earlier sendcmd-based version sent `textfile` as a bare runtime
  // command, which drawtext's AVOption table doesn't flag as runtime-
  // settable, so ffmpeg silently rejected it and captions never appeared.
  // This design only ever sets options at filter-construction time, so
  // that whole class of bug structurally can't happen here.
  const cues = buildCaptionCues([{ start: 0, end: 1, text: "hi" }]);
  const { filterComplex } = buildDrawtextFilterChain({ w: 1080, h: 1920, bgW: 1080, bgH: 1920, ...BASE_STYLE, cues });
  assert.doesNotMatch(filterComplex, /sendcmd/);
  assert.doesNotMatch(filterComplex, /reinit/);
});

test("buildDrawtextFilterChain produces a valid passthrough (no crash) with zero cues", () => {
  const { filterComplex, outLabel } = buildDrawtextFilterChain({ w: 1080, h: 1920, bgW: 1080, bgH: 1920, ...BASE_STYLE, cues: [] });
  assert.equal(outLabel, "vout");
  assert.match(filterComplex, /^\[0:v\]null\[vout\]$/);
});

test("buildDrawtextFilterChain includes scale+crop when background resolution is unknown or mismatched", () => {
  const cues = buildCaptionCues([{ start: 0, end: 1, text: "hi" }]);
  const unknown = buildDrawtextFilterChain({ w: 1080, h: 1920, bgW: 0, bgH: 0, ...BASE_STYLE, cues });
  assert.match(unknown.filterComplex, /scale=1080:1920/);

  const mismatched = buildDrawtextFilterChain({ w: 1080, h: 1920, bgW: 1280, bgH: 720, ...BASE_STYLE, cues });
  assert.match(mismatched.filterComplex, /scale=1080:1920/);
});

test("buildDrawtextFilterChain skips scale+crop when background already matches target resolution", () => {
  const cues = buildCaptionCues([{ start: 0, end: 1, text: "hi" }]);
  const matched = buildDrawtextFilterChain({ w: 1080, h: 1920, bgW: 1080, bgH: 1920, ...BASE_STYLE, cues });
  assert.doesNotMatch(matched.filterComplex, /scale=/);
  assert.match(matched.filterComplex, /^\[0:v\]drawtext=/);
});

test("buildDrawtextFilterChain applies style consistently across every cue", () => {
  const cues = buildCaptionCues([
    { start: 0, end: 1, text: "a" },
    { start: 1, end: 2, text: "b" },
    { start: 2, end: 3, text: "c" },
  ]);
  const { filterComplex } = buildDrawtextFilterChain({ w: 1080, h: 1920, bgW: 1080, bgH: 1920, fontSize: 90, textColor: "yellow", strokeColor: "red", strokeWidth: 5, positionY: 0.7, cues });
  // Note: can't naively split filterComplex on "," to isolate each drawtext
  // stage — the enable='between(t\,a\,b)' commas are backslash-escaped for
  // ffmpeg's parser but are still literal commas as far as String.split is
  // concerned, so a naive split fragments each stage. Count occurrences
  // across the whole string instead.
  const count = (re) => (filterComplex.match(re) || []).length;
  assert.equal(count(/drawtext=/g), 3);
  // fontsize/alpha are always quoted now (not just when entrance animation
  // is active) — they're per-frame expressions that happen to be constant
  // when entrance is "none"/unset, not a different code path.
  assert.equal(count(/fontsize='90'/g), 3);
  assert.equal(count(/fontcolor=yellow/g), 3);
  assert.equal(count(/bordercolor=red/g), 3);
  assert.equal(count(/borderw=5/g), 3);
  assert.equal(count(/y=h\*0\.7-text_h\/2/g), 3);
});

test("buildCaptionCues: uppercase transforms text but not the file name", () => {
  const cues = buildCaptionCues([{ start: 0, end: 1, text: "hello there" }], true);
  assert.equal(cues[0].text, "HELLO THERE");
  assert.equal(cues[0].file, "cap00000.txt");
});

test("buildDrawtextFilterChain: box adds box/boxcolor/boxborderw once per cue", () => {
  const cues = buildCaptionCues([{ start: 0, end: 1, text: "hi" }]);
  const { filterComplex } = buildDrawtextFilterChain({
    w: 1080, h: 1920, bgW: 1080, bgH: 1920, ...BASE_STYLE, cues,
    box: true, boxColor: "#000000", boxAlpha: 0.5, boxBorderW: 16,
  });
  assert.match(filterComplex, /box=1:boxcolor=#000000@0\.5:boxborderw=16/);
});

test("buildDrawtextFilterChain: no box option emitted when box is falsy", () => {
  const cues = buildCaptionCues([{ start: 0, end: 1, text: "hi" }]);
  const { filterComplex } = buildDrawtextFilterChain({ w: 1080, h: 1920, bgW: 1080, bgH: 1920, ...BASE_STYLE, cues });
  assert.doesNotMatch(filterComplex, /box=/);
});

test("buildDrawtextFilterChain: boxBevel adds two offset box-only drawtext layers before the real box", () => {
  const cues = buildCaptionCues([{ start: 0, end: 1, text: "hi" }]);
  const { filterComplex } = buildDrawtextFilterChain({
    w: 1080, h: 1920, bgW: 1080, bgH: 1920, ...BASE_STYLE, cues,
    box: true, boxColor: "#000000", boxAlpha: 0.5, boxBorderW: 16, boxBevel: 4,
  });
  // Dark (shadow) layer offset +4, light (highlight) layer offset -4, both
  // ahead of the real (unoffset) box in the filter chain.
  const darkIdx = filterComplex.indexOf("boxcolor=black@0.4");
  const lightIdx = filterComplex.indexOf("boxcolor=white@0.35");
  const realIdx = filterComplex.indexOf("boxcolor=#000000@0.5");
  assert.ok(darkIdx >= 0 && lightIdx >= 0 && realIdx >= 0);
  assert.ok(darkIdx < realIdx && lightIdx < realIdx);
  assert.match(filterComplex, /x=\(\(w-text_w\)\/2\)\+4/);
  assert.match(filterComplex, /x=\(\(w-text_w\)\/2\)-4/);
});

test("buildDrawtextFilterChain: no bevel layers when boxBevel is 0/falsy, even with box on", () => {
  const cues = buildCaptionCues([{ start: 0, end: 1, text: "hi" }]);
  const { filterComplex } = buildDrawtextFilterChain({
    w: 1080, h: 1920, bgW: 1080, bgH: 1920, ...BASE_STYLE, cues,
    box: true, boxColor: "#000000", boxAlpha: 0.5, boxBorderW: 16,
  });
  assert.doesNotMatch(filterComplex, /boxcolor=black@0\.4|boxcolor=white@0\.35/);
});

test("buildDrawtextFilterChain: boxBevel is a no-op when box is off", () => {
  const cues = buildCaptionCues([{ start: 0, end: 1, text: "hi" }]);
  const { filterComplex } = buildDrawtextFilterChain({
    w: 1080, h: 1920, bgW: 1080, bgH: 1920, ...BASE_STYLE, cues, boxBevel: 4,
  });
  assert.doesNotMatch(filterComplex, /boxcolor=black@0\.4|boxcolor=white@0\.35/);
});

test("buildDrawtextFilterChain: shadow adds shadowx/shadowy/shadowcolor", () => {
  const cues = buildCaptionCues([{ start: 0, end: 1, text: "hi" }]);
  const { filterComplex } = buildDrawtextFilterChain({
    w: 1080, h: 1920, bgW: 1080, bgH: 1920, ...BASE_STYLE, cues,
    shadow: true, shadowColor: "#000000", shadowX: 3, shadowY: 4,
  });
  assert.match(filterComplex, /shadowx=3:shadowy=4:shadowcolor=#000000/);
});

test("buildDrawtextFilterChain: pop entrance produces a fontsize expression referencing t", () => {
  const cues = buildCaptionCues([{ start: 1.2, end: 2, text: "hi" }]);
  const { filterComplex } = buildDrawtextFilterChain({ w: 1080, h: 1920, bgW: 1080, bgH: 1920, ...BASE_STYLE, cues, entrance: "pop" });
  assert.match(filterComplex, /fontsize='if\(lt\(t\\,1\.200\+0\.15\)/);
});

test("buildDrawtextFilterChain: fade entrance produces an alpha expression referencing t", () => {
  const cues = buildCaptionCues([{ start: 1.2, end: 2, text: "hi" }]);
  const { filterComplex } = buildDrawtextFilterChain({ w: 1080, h: 1920, bgW: 1080, bgH: 1920, ...BASE_STYLE, cues, entrance: "fade" });
  assert.match(filterComplex, /alpha='if\(lt\(t\\,1\.200\+0\.2\)/);
});

test("buildDrawtextFilterChain: none entrance keeps fontsize/alpha constant", () => {
  const cues = buildCaptionCues([{ start: 0, end: 1, text: "hi" }]);
  const { filterComplex } = buildDrawtextFilterChain({ w: 1080, h: 1920, bgW: 1080, bgH: 1920, ...BASE_STYLE, cues, entrance: "none" });
  assert.match(filterComplex, /fontsize='68':alpha='1':/);
});

test("buildKaraokeCues: emits one cue per word with group + word windows and xOffset", () => {
  const groups = [{ start: 0, end: 1, words: [
    { text: "a", start: 0, end: 0.4, xOffset: -10 },
    { text: "b", start: 0.4, end: 1, xOffset: 10 },
  ] }];
  const cues = buildKaraokeCues(groups, false);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { file: "kar00000.txt", text: "a", groupStart: 0, groupEnd: 1, wordStart: 0, wordEnd: 0.4, xOffset: -10 });
  assert.equal(cues[1].xOffset, 10);
});

test("buildDrawtextFilterChain: karaoke grouping emits two drawtext layers per word", () => {
  const groups = [{ start: 0, end: 1, words: [
    { text: "a", start: 0, end: 0.4, xOffset: -10 },
    { text: "b", start: 0.4, end: 1, xOffset: 10 },
  ] }];
  const cues = buildKaraokeCues(groups, false);
  const { filterComplex } = buildDrawtextFilterChain({
    w: 1080, h: 1920, bgW: 1080, bgH: 1920, ...BASE_STYLE, cues,
    grouping: "karaoke", highlightColor: "cyan",
  });
  const count = (re) => (filterComplex.match(re) || []).length;
  assert.equal(count(/drawtext=/g), 4); // 2 words x 2 layers
  assert.equal(count(/fontcolor=cyan/g), 2); // one highlight layer per word
  // Base layer spans the whole group; highlight layer spans just that word.
  assert.match(filterComplex, /between\(t\\,0\.000\\,1\.000\)/); // base layer (both words share group window)
  assert.match(filterComplex, /between\(t\\,0\.000\\,0\.400\)/); // word "a"'s own window
  assert.match(filterComplex, /between\(t\\,0\.400\\,1\.000\)/); // word "b"'s own window
});

test("buildAudioFilterChain maps narration directly (via anull) with no music and no delay", () => {
  const { filterChain, outLabel } = buildAudioFilterChain({ narrationInputIndex: 1, musicInputIndex: null, musicVolume: null, delaySec: 0 });
  assert.equal(outLabel, "narr");
  assert.match(filterChain, /^\[1:a\]anull\[narr\]$/);
});

test("buildAudioFilterChain delays narration with adelay when a title card is enabled", () => {
  const { filterChain, outLabel } = buildAudioFilterChain({ narrationInputIndex: 1, musicInputIndex: null, musicVolume: null, delaySec: 2.5 });
  assert.equal(outLabel, "narr");
  assert.match(filterChain, /\[1:a\]adelay=delays=2500:all=1\[narr\]/);
});

test("buildAudioFilterChain mixes music under narration, looped and volume-scaled", () => {
  const { filterChain, outLabel } = buildAudioFilterChain({ narrationInputIndex: 1, musicInputIndex: 2, musicVolume: 0.3, delaySec: 0 });
  assert.equal(outLabel, "aout");
  assert.match(filterChain, /\[2:a\]volume=0\.3,aloop=loop=-1:size=2e9\[music\]/);
  assert.match(filterChain, /\[narr\]\[music\]amix=inputs=2:duration=first:dropout_transition=0\[aout\]/);
});

test("buildAudioFilterChain clamps music volume to [0,1]", () => {
  const tooLoud = buildAudioFilterChain({ narrationInputIndex: 1, musicInputIndex: 2, musicVolume: 5, delaySec: 0 });
  assert.match(tooLoud.filterChain, /volume=1(?!\.)/); // clamped to 1, not 5
  const negative = buildAudioFilterChain({ narrationInputIndex: 1, musicInputIndex: 2, musicVolume: -1, delaySec: 0 });
  assert.match(negative.filterChain, /volume=0,/);
});

test("buildTitleCardOverlay relabels the video chain's output and appends a scale+overlay stage", () => {
  const cues = buildCaptionCues([{ start: 0, end: 1, text: "hi" }]);
  const video = buildDrawtextFilterChain({ w: 1080, h: 1920, bgW: 1080, bgH: 1920, ...BASE_STYLE, cues });
  const { filterComplex, outLabel } = buildTitleCardOverlay({
    videoFilterComplex: video.filterComplex, videoOutLabel: video.outLabel,
    w: 1080, h: 1920, titleCardInputIndex: 3, cardDurationSec: 2.5,
  });
  assert.equal(outLabel, "vout");
  // Original chain's output pad is renamed, not left dangling as [vout] twice.
  assert.doesNotMatch(filterComplex.slice(0, filterComplex.indexOf("[titlecard]")), /\[vout\]/);
  assert.match(filterComplex, /\[capped\]/);
  assert.match(filterComplex, /\[3:v\]scale=1080:1920\[titlecard\]/);
  assert.match(filterComplex, /\[capped\]\[titlecard\]overlay=0:0:enable='lt\(t\\,2\.500\)'\[vout\]$/);
});

test("parseWavDurationSec reads exact duration from a synthetic WAV header", () => {
  assert.ok(Math.abs(parseWavDurationSec(makeWav(3.5)) - 3.5) < 1e-6);
  // sample-count rounding (duration*sampleRate isn't always an integer)
  // means this isn't bit-exact — a sub-millisecond tolerance is fine.
  assert.ok(Math.abs(parseWavDurationSec(makeWav(0.25, 22050)) - 0.25) < 0.001);
});

test("parseWavDurationSec returns null for non-WAV or truncated input", () => {
  assert.equal(parseWavDurationSec(new Uint8Array(10)), null);
  assert.equal(parseWavDurationSec(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])), null);
  assert.equal(parseWavDurationSec(null), null);
});

test("parseWavDurationSec returns null (not a wildly wrong duration) when the data chunk's size field is an implausible placeholder", () => {
  // Real-world repro: some WAV writers (confirmed: PocketTTS) never patch
  // the data chunk's declared size after writing, leaving a fixed sentinel
  // (here modeled as ~2GB) far larger than the file actually is — trusting
  // it blindly used to compute a nonsense multi-hour duration for a
  // sub-second clip instead of falling back to a real probe.
  const bytes = makeWav(1.0);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  dv.setUint32(40, 2_000_000_000, true); // overwrite the "data" chunk size field
  assert.equal(parseWavDurationSec(bytes), null);
});
