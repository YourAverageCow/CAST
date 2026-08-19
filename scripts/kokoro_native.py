#!/usr/bin/env python3
# Invoked via `uvx --with kokoro --with soundfile python3 kokoro_native.py ...` —
# see server.js's runNativeKokoro(). Uses the official Python `kokoro` package
# (hexgrad/Kokoro-82M, the same model the browser's kokoro-js/ONNX build uses)
# via its KPipeline, which exposes real per-word start_ts/end_ts derived
# directly from the model's own predicted phoneme durations during synthesis —
# not a separate ASR transcribe-and-align step, so there's nothing for the
# words to mismatch against.
import argparse
import json
import re
import sys

import numpy as np
import soundfile as sf
from kokoro import KPipeline

# Same sentence-boundary split used by the browser build (web/lib/tts-engines.js's
# KokoroEngine) so both backends bound how much text one pipeline() chunk
# receives at once, consistent with the model's known token-limit behavior.
SPLIT_PATTERN = r"\n+|(?<=[.!?])\s+"

# Same trim/gap constants and algorithm as the browser build's
# trimSilenceFloat32()/KOKORO_INTER_CHUNK_GAP_SEC (web/lib/audio-utils.js,
# web/tts-worker.js) — ported here since this script previously just
# np.concatenate()'d raw chunks with no smoothing at all, leaving whatever
# silence KPipeline happened to produce at each chunk boundary (varies
# unpredictably chunk to chunk) instead of a consistent, deliberate gap.
KOKORO_MAX_TRIM_SEC = 0.6
KOKORO_INTER_CHUNK_GAP_SEC = 0.12
SILENCE_THRESHOLD = 0.01


def trim_silence(samples, sample_rate, max_trim_sec):
    """Returns (trimmed_samples, leading_samples_removed) — mirrors
    trimSilenceFloat32()'s energy-threshold trim exactly, but also reports
    how much was cut from the front so caller code can shift word
    timestamps by the same amount."""
    max_trim_samples = int(max_trim_sec * sample_rate)
    n = len(samples)
    start = 0
    while start < n and start < max_trim_samples and abs(samples[start]) < SILENCE_THRESHOLD:
        start += 1
    end = n
    min_end = max(start, n - max_trim_samples)
    while end > min_end and abs(samples[end - 1]) < SILENCE_THRESHOLD:
        end -= 1
    return samples[start:end], start


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--text-file", required=True)
    p.add_argument("--voice", required=True)
    p.add_argument("--lang", required=True)
    p.add_argument("--speed", type=float, default=1.0)
    p.add_argument("--out", required=True)
    p.add_argument("--threads", type=int, default=0)
    args = p.parse_args()

    if args.threads > 0:
        # torch is a transitive dependency of kokoro — set its thread budget
        # before constructing KPipeline so N concurrent invocations (see
        # server.js's threadBudget()) don't each try to grab every core.
        import torch
        torch.set_num_threads(args.threads)

    with open(args.text_file, "r", encoding="utf-8") as f:
        text = f.read()

    # Split the text ourselves, on real punctuation/paragraph boundaries
    # only — segment 0 is always the title line (its own line, ending at
    # the first blank line). Each segment gets its own dedicated
    # pipeline() call below, with split_pattern=None so KPipeline does no
    # further OUTER splitting on it (there's nothing left in an already-
    # atomic segment for \n+/[.!?] to match anyway).
    segments = [s for s in re.split(SPLIT_PATTERN, text.strip()) if s.strip()]

    pipeline = KPipeline(lang_code=args.lang)
    words = []
    chunks = []
    offset = 0.0
    sample_rate = 24000
    gap_samples = int(KOKORO_INTER_CHUNK_GAP_SEC * sample_rate)
    first_segment = True
    for segment in segments:
        # KPipeline can still internally re-split ONE segment into several
        # Results if it phonemizes to more than the model's 510-token
        # limit — a length cutoff, not a punctuation boundary, so those
        # sub-chunks are concatenated raw here (no trim, no gap) rather
        # than treated as a real pause point. Trim+gap is only applied
        # once, below, to the whole segment's combined start/end.
        segment_chunks = []
        segment_tokens = []  # (text, start_local, end_local), relative to segment_chunks concatenated raw
        local_offset = 0.0
        for result in pipeline(segment, voice=args.voice, speed=args.speed, split_pattern=None):
            if result.audio is None:
                continue
            audio = result.audio.numpy().astype(np.float32)
            if result.tokens:
                for t in result.tokens:
                    if t.start_ts is None or t.end_ts is None:
                        continue
                    segment_tokens.append((t.text, local_offset + t.start_ts, local_offset + t.end_ts))
            segment_chunks.append(audio)
            local_offset += len(audio) / sample_rate
        if not segment_chunks:
            continue

        segment_audio = np.concatenate(segment_chunks)
        trimmed, lead_trim = trim_silence(segment_audio, sample_rate, KOKORO_MAX_TRIM_SEC)
        lead_trim_sec = lead_trim / sample_rate

        if not first_segment:
            # A fixed, deliberate gap between segments instead of whatever
            # untrimmed silence KPipeline happened to leave at this
            # boundary — inserted as real silent samples so it survives
            # into the WAV file, not just a timestamp adjustment.
            chunks.append(np.zeros(gap_samples, dtype=np.float32))
            offset += KOKORO_INTER_CHUNK_GAP_SEC

        for tok_text, start_local, end_local in segment_tokens:
            # Shift by -lead_trim_sec to stay relative to the trimmed
            # segment's new start, then by +offset into the final
            # concatenated timeline. Clamped at 0 in case a token's start
            # fell inside the trimmed silence.
            start = max(0.0, start_local - lead_trim_sec) + offset
            end = max(0.0, end_local - lead_trim_sec) + offset
            words.append({"text": tok_text, "start": start, "end": end})

        chunks.append(trimmed)
        offset += len(trimmed) / sample_rate
        first_segment = False

    audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
    sf.write(args.out, audio, sample_rate)
    # Real stdout contract with runNativeKokoro(): the LAST line of stdout is
    # the JSON metadata payload — everything kokoro/spacy/torch may have
    # printed before it (warnings, HF download progress) is ignored.
    print(json.dumps({"words": words, "durationSec": len(audio) / sample_rate}))


if __name__ == "__main__":
    main()
