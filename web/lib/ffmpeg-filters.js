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

// One cue per caption: {start, end, text, file}. Cues under 40ms or with
// empty/whitespace-only text are skipped as not worth rendering. `file` is
// an internally-generated name (cap00000.txt, ...) — never derived from
// user text — so there is nothing here that needs escaping.
function buildCaptionCues(subs) {
  const cues = [];
  let i = 0;
  for (const s of subs) {
    if (s.end - s.start < 0.04) continue;
    const text = (s.text || "").trim();
    if (!text) continue;
    cues.push({ start: s.start, end: s.end, text, file: "cap" + String(i).padStart(5, "0") + ".txt" });
    i++;
  }
  return cues;
}

// One drawtext filter per cue, gated by enable='between(t,start,end)' so it
// only draws while the playhead is inside that cue's window — outside it,
// drawtext no-ops and passes the frame through unchanged. This is the
// standard, well-documented ffmpeg pattern for burning in timed text
// without a subtitle-rendering library (libass), and everything here is a
// build-time filter OPTION, not a runtime command sent via sendcmd — no
// dependency on which AVOptions happen to be flagged runtime-settable
// (the exact landmine that made captions silently never render at all: an
// earlier sendcmd-based version sent `textfile` as a bare runtime command,
// which drawtext's AVOption table doesn't mark as such, so ffmpeg silently
// rejected every one of those commands). Costs one filter node per cue
// instead of two total — slower to build/run for a very long story, but
// nothing here depends on subtle runtime-command semantics, which is worth
// the tradeoff after that class of bug.
function buildDrawtextFilterChain({ w, h, bgW, bgH, fontSize, textColor, strokeColor, strokeWidth, positionY, cues }) {
  const needsScale = !(bgW && bgH && bgW === w && bgH === h);
  const stages = [];
  if (needsScale) stages.push(`scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`);
  for (const cue of cues) {
    // Commas inside the enable='between(t,a,b)' expression must be escaped
    // as \, — the outer filtergraph parser splits on bare commas to
    // separate chained filters, and would otherwise cut this option off
    // partway through the between() call.
    const between = `between(t\\,${cue.start.toFixed(3)}\\,${cue.end.toFixed(3)})`;
    stages.push(
      `drawtext=fontfile=fonts/DejaVuSans.ttf:textfile=${cue.file}:fontsize=${fontSize}` +
      `:fontcolor=${textColor}:borderw=${strokeWidth}:bordercolor=${strokeColor}` +
      `:x=(w-text_w)/2:y=h*${positionY}-text_h/2:enable='${between}'`
    );
  }
  // A filtergraph output pad needs at least one filter feeding it — fall
  // back to a no-op passthrough on the rare video with no renderable cues
  // at all (e.g. a background with no narration) and no scaling needed.
  if (!stages.length) stages.push("null");
  return { filterComplex: `[0:v]${stages.join(",")}[vout]`, outLabel: "vout" };
}

// Minimal RIFF/WAVE header parse: reads the byte rate and the "data" chunk
// size to compute exact duration, without needing ffmpeg/ffprobe to do it.
// Used to give the render an explicit `-t` bound when a title card delays
// the narration — relying on `-shortest` alone was observed to let the
// (infinitely-looped) background video run away well past the narration's
// actual end once an overlay input was added to the graph, rather than
// stopping where the delayed+bounded audio stream does.
function parseWavDurationSec(bytes) {
  if (!bytes || bytes.length < 44) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fourcc = (off) => String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
  if (fourcc(0) !== "RIFF" || fourcc(8) !== "WAVE") return null;
  const byteRate = dv.getUint32(28, true);
  if (!byteRate) return null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = fourcc(offset);
    const size = dv.getUint32(offset + 4, true);
    if (id === "data") return size / byteRate;
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  return null;
}

// Narration is always present at `narrationInputIndex`; optionally mixed
// under a looping music track at `musicInputIndex`. When a title card is
// enabled, `delaySec` prepends silence to the narration (via adelay) so
// speech starts only after the card's on-screen window — the caller is
// responsible for shifting caption cue timings by the same amount, this
// function only handles the audio side. Always routes through a labeled
// filter chain (falls back to a no-op `anull` when there's nothing to do)
// rather than special-casing "just map narration directly", so callers
// never need to branch on whether a filter was actually applied.
function buildAudioFilterChain({ narrationInputIndex, musicInputIndex, musicVolume, delaySec }) {
  const delayMs = Math.max(0, Math.round((delaySec || 0) * 1000));
  const stages = [];
  const narrSrc = `${narrationInputIndex}:a`;
  stages.push(
    delayMs > 0
      ? `[${narrSrc}]adelay=delays=${delayMs}:all=1[narr]`
      : `[${narrSrc}]anull[narr]`
  );
  if (musicInputIndex == null) {
    return { filterChain: stages.join(";"), outLabel: "narr" };
  }
  const vol = Math.max(0, Math.min(1, musicVolume == null ? 0.25 : musicVolume));
  // aloop makes a short track repeat for the whole narration length; amix's
  // duration=first stops the mixed output at the narration's length rather
  // than the (now-infinite) looping music track's.
  stages.push(`[${musicInputIndex}:a]volume=${vol},aloop=loop=-1:size=2e9[music]`);
  stages.push(`[narr][music]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
  return { filterChain: stages.join(";"), outLabel: "aout" };
}

// Composites a pre-rendered title-card PNG (see app.js's canvas-based
// renderTitleCardImage — text/avatar/badge layout is done there, not in
// ffmpeg, so none of that complexity lives in the filter graph) over the
// video for the first `cardDurationSec` seconds. Takes an already-built
// video filter chain (e.g. from buildDrawtextFilterChain) and relabels its
// output pad rather than needing to know its internals.
function buildTitleCardOverlay({ videoFilterComplex, videoOutLabel, w, h, titleCardInputIndex, cardDurationSec }) {
  const relabeled = videoFilterComplex.replace(
    new RegExp(`\\[${videoOutLabel}\\]$`), "[capped]"
  );
  const scaleCard = `[${titleCardInputIndex}:v]scale=${w}:${h}[titlecard]`;
  const between = `lt(t\\,${cardDurationSec.toFixed(3)})`;
  const overlay = `[capped][titlecard]overlay=0:0:enable='${between}'[vout]`;
  return { filterComplex: `${relabeled};${scaleCard};${overlay}`, outLabel: "vout" };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    safeColor, buildCaptionCues, buildDrawtextFilterChain,
    buildAudioFilterChain, buildTitleCardOverlay, parseWavDurationSec,
  };
}
