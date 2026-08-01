const test = require("node:test");
const assert = require("node:assert/strict");
const {
  safeColor, buildCaptionEvents, buildSendcmdScript, buildDrawtextFilterString,
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

test("buildCaptionEvents emits a show+clear pair per cue", () => {
  const events = buildCaptionEvents([{ start: 0, end: 1, text: "hi" }]);
  assert.equal(events.length, 2);
  assert.equal(events[0].time, 0);
  assert.equal(events[0].file, "cap00000.txt");
  assert.equal(events[1].time, 1);
  assert.equal(events[1].file, "capempty.txt");
});

test("buildCaptionEvents skips cues under 40ms", () => {
  const events = buildCaptionEvents([{ start: 0, end: 0.03, text: "blink" }]);
  assert.equal(events.length, 0);
});

test("buildCaptionEvents skips cues with empty/whitespace-only text", () => {
  const events = buildCaptionEvents([{ start: 0, end: 1, text: "   " }]);
  assert.equal(events.length, 0);
});

test("buildCaptionEvents ties: clear-cue lands before the next show-cue at the same timestamp", () => {
  const events = buildCaptionEvents([
    { start: 0, end: 1, text: "first" },
    { start: 1, end: 2, text: "second" },
  ]);
  // 4 events, two of them tied at time=1: first's clear and second's show.
  const atOne = events.filter(e => e.time === 1);
  assert.equal(atOne.length, 2);
  assert.equal(atOne[0].file, "capempty.txt"); // clear (first cue's end)
  assert.equal(atOne[1].file, "cap00001.txt"); // show (second cue's start) — text wins over a blank gap
});

test("buildSendcmdScript emits reinit 'textfile=<file>' (not a bare textfile command)", () => {
  const events = buildCaptionEvents([{ start: 1.5, end: 2.25, text: "hello" }]);
  const script = buildSendcmdScript(events);
  assert.match(script, /^1\.500 drawtext@cap reinit 'textfile=cap00000\.txt';$/m);
  assert.match(script, /^2\.250 drawtext@cap reinit 'textfile=capempty\.txt';$/m);
  // Regression check for the v52 bug: `textfile` is not a runtime-settable
  // AVOption on drawtext, only `reinit` is — a bare `drawtext@cap textfile '...'`
  // command is silently rejected by ffmpeg and captions never appear.
  assert.doesNotMatch(script, /drawtext@cap textfile /);
});

test("buildDrawtextFilterString includes scale+crop when background resolution is unknown or mismatched", () => {
  const unknown = buildDrawtextFilterString({ w: 1080, h: 1920, bgW: 0, bgH: 0, fontSize: 68, textColor: "white", strokeColor: "black", strokeWidth: 3, positionY: 0.55 });
  assert.equal(unknown.needsScale, true);
  assert.match(unknown.filterComplex, /scale=1080:1920/);

  const mismatched = buildDrawtextFilterString({ w: 1080, h: 1920, bgW: 1280, bgH: 720, fontSize: 68, textColor: "white", strokeColor: "black", strokeWidth: 3, positionY: 0.55 });
  assert.equal(mismatched.needsScale, true);
  assert.match(mismatched.filterComplex, /scale=1080:1920/);
});

test("buildDrawtextFilterString skips scale+crop when background already matches target resolution", () => {
  const matched = buildDrawtextFilterString({ w: 1080, h: 1920, bgW: 1080, bgH: 1920, fontSize: 68, textColor: "white", strokeColor: "black", strokeWidth: 3, positionY: 0.55 });
  assert.equal(matched.needsScale, false);
  assert.doesNotMatch(matched.filterComplex, /scale=/);
  assert.match(matched.filterComplex, /^\[0:v\]sendcmd=f=cmds\.txt,drawtext@cap=/);
});
