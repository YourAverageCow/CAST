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
// user text — so there is nothing here that needs escaping. `uppercase`
// transforms the text before it's written to that file (not at
// filter-string build time) — keeps the drawtext builder itself unaware of
// text-casing concerns entirely.
function buildCaptionCues(subs, uppercase) {
  const cues = [];
  let i = 0;
  for (const s of subs) {
    if (s.end - s.start < 0.04) continue;
    let text = (s.text || "").trim();
    if (!text) continue;
    if (uppercase) text = text.toUpperCase();
    cues.push({ start: s.start, end: s.end, text, file: "cap" + String(i).padStart(5, "0") + ".txt" });
    i++;
  }
  return cues;
}

// Karaoke grouping's cue builder: one cue PER WORD (not per group) since
// each word needs its own textfile, but carries both the group's whole
// on-screen window (groupStart/groupEnd, for the always-visible base layer)
// and its own speaking window (wordStart/wordEnd, for the highlight layer
// drawn on top only while it's actually being said) — see
// buildDrawtextFilterChain's karaoke branch. `xOffset` (signed pixels from
// frame-center) comes from measureWordOffsets() in app.js — a pure
// DOM-free module can't measure real glyph widths itself.
function buildKaraokeCues(groups, uppercase) {
  const cues = [];
  let i = 0;
  for (const g of groups) {
    if (g.end - g.start < 0.04) continue;
    for (const w of g.words) {
      let text = (w.text || "").trim();
      if (!text) continue;
      if (uppercase) text = text.toUpperCase();
      cues.push({
        file: "kar" + String(i).padStart(5, "0") + ".txt", text,
        groupStart: g.start, groupEnd: g.end,
        wordStart: w.start, wordEnd: w.end,
        xOffset: typeof w.xOffset === "number" ? w.xOffset : 0,
      });
      i++;
    }
  }
  return cues;
}

// Verified live (ffmpeg -h filter=drawtext + a real render, inspected
// frame-by-frame) that fontsize/alpha both accept per-frame `t`-based
// expressions — real pop/fade entrance animation, not an approximation.
// Both expressions are no-ops outside their own cue's `enable` window (a
// disabled timeline filter isn't evaluated for that frame at all), so it's
// safe to key them off each cue's own start time without an explicit
// end-of-animation clamp beyond what's written here.
function entranceFontSizeExpr(entrance, startSec, fontSize) {
  if (entrance !== "pop") return String(fontSize);
  const s = startSec.toFixed(3);
  const minSize = (fontSize * 0.6).toFixed(1);
  const delta = (fontSize * 0.4).toFixed(1);
  return `if(lt(t\\,${s}+0.15)\\,${minSize}+min(t-${s}\\,0.15)/0.15*${delta}\\,${fontSize})`;
}
function entranceAlphaExpr(entrance, startSec) {
  if (entrance !== "fade") return "1";
  const s = startSec.toFixed(3);
  return `if(lt(t\\,${s}+0.2)\\,(t-${s})/0.2\\,1)`;
}

// Shared box/shadow option suffix, appended to every drawtext instance
// (base and highlight layers alike in karaoke mode) when enabled.
function boxShadowOptions({ box, boxColor, boxAlpha, boxBorderW, shadow, shadowColor, shadowX, shadowY }) {
  let opts = "";
  if (box) opts += `:box=1:boxcolor=${boxColor}@${boxAlpha}:boxborderw=${boxBorderW}`;
  if (shadow) opts += `:shadowx=${shadowX}:shadowy=${shadowY}:shadowcolor=${shadowColor}`;
  return opts;
}

// Fakes a raised/embossed edge on the background box — drawtext's own `box`
// option is a flat rectangle with no bevel support, so this draws two extra
// boxes (same textfile, so they auto-size to match the real box exactly;
// fully transparent text) behind the real one: a dark copy offset toward
// the bottom-right and a light copy offset toward the top-left. Since the
// real (unoffset) box is drawn on top and fully covers the overlap, only a
// `bevelPx`-wide sliver of each survives along two opposite edges — the
// classic raised-button illusion. Returns [] when bevelPx is falsy/0 so
// callers can unconditionally splice this into their stage list.
// `xExpr`/`yExpr` must be the exact same position expressions the real
// box's drawtext instance uses, so the offset boxes track it (including
// karaoke's per-word xOffset).
function buildBevelStages({ fontFile, fontSize, boxBorderW, bevelPx, textfile, xExpr, yExpr, enable }) {
  if (!bevelPx) return [];
  const common = `fontfile=fonts/${fontFile}:textfile=${textfile}:fontsize=${fontSize}:box=1:boxborderw=${boxBorderW}:enable='${enable}'`;
  return [
    `drawtext=${common}:fontcolor=black@0:boxcolor=black@0.4:x=(${xExpr})+${bevelPx}:y=(${yExpr})+${bevelPx}`,
    `drawtext=${common}:fontcolor=white@0:boxcolor=white@0.35:x=(${xExpr})-${bevelPx}:y=(${yExpr})-${bevelPx}`,
  ];
}

// One drawtext filter per cue (two per word in karaoke mode — see below),
// gated by enable='between(t,start,end)' so it only draws while the
// playhead is inside that window — outside it, drawtext no-ops and passes
// the frame through unchanged. This is the standard, well-documented ffmpeg
// pattern for burning in timed text without a subtitle-rendering library
// (libass), and everything here — including the new fontsize/alpha
// per-frame expressions — is a build-time filter OPTION, not a runtime
// command sent via sendcmd — no dependency on which AVOptions happen to be
// flagged runtime-settable (the exact landmine that made captions silently
// never render at all: an earlier sendcmd-based version sent `textfile` as
// a bare runtime command, which drawtext's AVOption table doesn't mark as
// such, so ffmpeg silently rejected every one of those commands). Costs one
// filter node per cue (two in karaoke mode) instead of two total — slower
// to build/run for a very long story, but nothing here depends on subtle
// runtime-command semantics, which is worth the tradeoff after that class
// of bug.
function buildDrawtextFilterChain({
  w, h, bgW, bgH, fontFile, fontSize, textColor, strokeColor, strokeWidth, positionY,
  highlightColor, box, boxColor, boxAlpha, boxBorderW, boxBevel,
  shadow, shadowColor, shadowX, shadowY, entrance,
  grouping, cues,
}) {
  fontFile = fontFile || "DejaVuSans.ttf";
  const needsScale = !(bgW && bgH && bgW === w && bgH === h);
  const stages = [];
  if (needsScale) stages.push(`scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`);
  const boxShadow = boxShadowOptions({ box, boxColor, boxAlpha, boxBorderW, shadow, shadowColor, shadowX, shadowY });
  const bevelPx = box ? (boxBevel || 0) : 0;

  if (grouping === "karaoke") {
    for (const cue of cues) {
      // Commas inside between()/if()/min() expressions must be escaped as
      // \, — the outer filtergraph parser splits on bare commas to
      // separate chained filters, and would otherwise cut an option off
      // partway through.
      const groupBetween = `between(t\\,${cue.groupStart.toFixed(3)}\\,${cue.groupEnd.toFixed(3)})`;
      const wordBetween = `between(t\\,${cue.wordStart.toFixed(3)}\\,${cue.wordEnd.toFixed(3)})`;
      const x = `(w/2)+${cue.xOffset.toFixed(1)}-text_w/2`;
      const y = `h*${positionY}-text_h/2`;
      const fontSizeExpr = entranceFontSizeExpr(entrance, cue.groupStart, fontSize);
      const alphaExpr = entranceAlphaExpr(entrance, cue.groupStart);
      // Bevel edges sit behind the base layer only — it's the one visible
      // for the group's whole on-screen window, so that's where the box
      // (and its beveled edge) reads as "always there" rather than
      // flickering in and out per word.
      stages.push(...buildBevelStages({
        fontFile, fontSize, boxBorderW, bevelPx, textfile: cue.file, xExpr: x, yExpr: y, enable: groupBetween,
      }));
      // Base layer: visible for the whole group's on-screen window, in the
      // regular text color.
      stages.push(
        `drawtext=fontfile=fonts/${fontFile}:textfile=${cue.file}:fontsize='${fontSizeExpr}':alpha='${alphaExpr}'` +
        `:fontcolor=${textColor}:borderw=${strokeWidth}:bordercolor=${strokeColor}${boxShadow}` +
        `:x=${x}:y=${y}:enable='${groupBetween}'`
      );
      // Highlight layer: identical position, drawn on top only during this
      // word's own speaking window — visually "swaps" the color instead of
      // needing an unverified fontcolor_expr mechanism.
      stages.push(
        `drawtext=fontfile=fonts/${fontFile}:textfile=${cue.file}:fontsize=${fontSize}` +
        `:fontcolor=${highlightColor}:borderw=${strokeWidth}:bordercolor=${strokeColor}${boxShadow}` +
        `:x=${x}:y=${y}:enable='${wordBetween}'`
      );
    }
  } else {
    for (const cue of cues) {
      const between = `between(t\\,${cue.start.toFixed(3)}\\,${cue.end.toFixed(3)})`;
      const fontSizeExpr = entranceFontSizeExpr(entrance, cue.start, fontSize);
      const alphaExpr = entranceAlphaExpr(entrance, cue.start);
      const x = `(w-text_w)/2`;
      const y = `h*${positionY}-text_h/2`;
      stages.push(...buildBevelStages({
        fontFile, fontSize, boxBorderW, bevelPx, textfile: cue.file, xExpr: x, yExpr: y, enable: between,
      }));
      stages.push(
        `drawtext=fontfile=fonts/${fontFile}:textfile=${cue.file}:fontsize='${fontSizeExpr}':alpha='${alphaExpr}'` +
        `:fontcolor=${textColor}:borderw=${strokeWidth}:bordercolor=${strokeColor}${boxShadow}` +
        `:x=${x}:y=${y}:enable='${between}'`
      );
    }
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
    if (id === "data") {
      // Some WAV writers emit a placeholder/sentinel data-chunk size instead
      // of the true byte count (confirmed live: PocketTTS's output does
      // this, off by orders of magnitude) — trusting it unconditionally
      // produces a wildly wrong duration rather than failing loudly. If the
      // claimed size exceeds what's actually left in the buffer, it can't
      // be real; fall through to the caller's DOM-probe fallback instead.
      if (size > bytes.length - offset - 8) return null;
      return size / byteRate;
    }
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

// Speeds up (or slows down) the whole composite — video via setpts (PTS
// divided by speed: smaller/faster-advancing timestamps play back faster),
// audio via atempo (its own direct tempo-change factor, pitch-corrected,
// not just a naive resample) — applied as the LAST step of each chain, after
// captions/title-card overlay and after music mixing. Because it's the very
// last video/audio step, every upstream `enable='between(t,...)'` caption
// gate and the title-card's own on-screen window are evaluated against the
// original (pre-speed) timeline and need no rescaling themselves — the
// entire already-composited result just gets uniformly compressed in time
// at the end, video and audio by the same factor, so they stay in sync.
// speed === 1 (or falsy) is a no-op passthrough, so callers can splice this
// in unconditionally rather than branching. atempo's single-instance valid
// range is 0.5–2.0, comfortably covering this app's expected ~1.0–1.5x.
function applyPlaybackSpeed({ videoFilterComplex, videoOutLabel, audioFilterChain, audioOutLabel, speed }) {
  if (!speed || speed === 1) return { videoFilterComplex, videoOutLabel, audioFilterChain, audioOutLabel };
  const video = videoFilterComplex.replace(new RegExp(`\\[${videoOutLabel}\\]$`), "[prespeed]") +
    `;[prespeed]setpts=PTS/${speed}[speedv]`;
  const audio = `${audioFilterChain};[${audioOutLabel}]atempo=${speed}[speeda]`;
  return { videoFilterComplex: video, videoOutLabel: "speedv", audioFilterChain: audio, audioOutLabel: "speeda" };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    safeColor, buildCaptionCues, buildKaraokeCues, buildDrawtextFilterChain,
    buildBevelStages, buildAudioFilterChain, buildTitleCardOverlay, applyPlaybackSpeed, parseWavDurationSec,
  };
}
