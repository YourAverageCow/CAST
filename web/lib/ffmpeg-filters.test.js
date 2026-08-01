const test = require("node:test");
const assert = require("node:assert/strict");
const {
  safeColor, buildCaptionCues, buildDrawtextFilterChain,
} = require("./ffmpeg-filters.js");

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
  assert.equal(count(/fontsize=90/g), 3);
  assert.equal(count(/fontcolor=yellow/g), 3);
  assert.equal(count(/bordercolor=red/g), 3);
  assert.equal(count(/borderw=5/g), 3);
  assert.equal(count(/y=h\*0\.7-text_h\/2/g), 3);
});
