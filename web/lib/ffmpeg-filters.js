// Pure ffmpeg filter-graph string building — no ffmpeg.FS, no Worker
// globals. Loaded via importScripts() in the worker (declares these as
// globals, consumed unqualified by ffmpeg-worker.js) and as a plain
// require()-able module in tests.

// Only allow plain color names or hex, since this gets interpolated straight
// into an ffmpeg filter-graph string.
function safeColor(c, fallback) {
  if (typeof c !== "string") return fallback;
  c = c.trim();
  if (/^[a-zA-Z]+$/.test(c)) return c;
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(c)) return c;
  if (/^0x[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(c)) return c;
  return fallback;
}

// Builds the sorted {time, file} event list driving the sendcmd script: one
// "show" event at each cue's start (pointing at that cue's own text file)
// and one "clear" event at its end (pointing at the shared empty file).
// Cues under 40ms or with empty text are skipped as not worth rendering.
function buildCaptionEvents(subs) {
  const events = [];
  let i = 0;
  for (const s of subs) {
    if (s.end - s.start < 0.04) continue;
    const text = (s.text || "").trim();
    if (!text) continue;
    const fname = "cap" + String(i).padStart(5, "0") + ".txt";
    events.push({ time: s.start, file: fname, text });
    events.push({ time: s.end, file: "capempty.txt" });
    i++;
  }
  // Stable sort: for two events at the identical timestamp (a cue's end
  // exactly meeting the next cue's start), insertion order is preserved,
  // and since each cue pushes [start, end] in that order across cues
  // processed chronologically, "show next cue" always lands after
  // "clear this cue" at a tie — text wins over a blank gap, as intended.
  events.sort((a, b) => a.time - b.time);
  return events;
}

// One drawtext instance, driven by sendcmd swapping its `textfile` at each
// cue's start/end timestamp via the `reinit` command. drawtext's own AVOption
// table only flags `text` as directly runtime-settable — `textfile` is not,
// so sending it as a bare command is silently rejected by ffmpeg and the
// on-screen text never advances past the initial empty file. `reinit`
// (documented, always supported) re-applies a `key=value` option string on
// top of the filter's current options, so `textfile=<file>` here swaps just
// that one option while leaving fontsize/color/etc. untouched.
function buildSendcmdScript(events) {
  return events.map(e => `${e.time.toFixed(3)} drawtext@cap reinit 'textfile=${e.file}';`).join("\n");
}

// The final [0:v]...[vout] filter-graph string: scale+crop to the target
// resolution (skipped entirely when the background is already at that
// resolution — the common case for a purpose-shot/pre-cropped clip, and
// otherwise wasted per-frame work), then sendcmd-driven drawtext for
// captions. Doesn't touch ffmpeg.FS — the caller writes cmds.txt/cap*.txt
// separately using the events from buildCaptionEvents.
function buildDrawtextFilterString({ w, h, bgW, bgH, fontSize, textColor, strokeColor, strokeWidth, positionY }) {
  const needsScale = !(bgW && bgH && bgW === w && bgH === h);
  const vf =
    (needsScale ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},` : "") +
    `sendcmd=f=cmds.txt,` +
    `drawtext@cap=fontfile=fonts/DejaVuSans.ttf:textfile=capempty.txt:fontsize=${fontSize}` +
    `:fontcolor=${textColor}:borderw=${strokeWidth}:bordercolor=${strokeColor}` +
    `:x=(w-text_w)/2:y=h*${positionY}-text_h/2`;
  return { filterComplex: `[0:v]${vf}[vout]`, outLabel: "vout", needsScale };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { safeColor, buildCaptionEvents, buildSendcmdScript, buildDrawtextFilterString };
}
