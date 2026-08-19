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

    pipeline = KPipeline(lang_code=args.lang)
    words = []
    chunks = []
    offset = 0.0
    sample_rate = 24000
    gap_samples = int(KOKORO_INTER_CHUNK_GAP_SEC * sample_rate)
    first_chunk = True
    for result in pipeline(text, voice=args.voice, speed=args.speed, split_pattern=SPLIT_PATTERN):
        if result.audio is None:
            continue
        audio = result.audio.numpy().astype(np.float32)
        trimmed, lead_trim = trim_silence(audio, sample_rate, KOKORO_MAX_TRIM_SEC)
        lead_trim_sec = lead_trim / sample_rate
        if not first_chunk:
            # A fixed, deliberate gap between chunks instead of whatever
            # untrimmed silence KPipeline happened to leave at this
            # boundary — inserted as real silent samples so it survives
            # into the WAV file, not just a timestamp adjustment.
            chunks.append(np.zeros(gap_samples, dtype=np.float32))
            offset += KOKORO_INTER_CHUNK_GAP_SEC
        if result.tokens:
            for t in result.tokens:
                if t.start_ts is None or t.end_ts is None:
                    continue
                # Token timestamps are relative to this chunk's own
                # (untrimmed) start — shift by -lead_trim_sec to stay
                # relative to the trimmed chunk's new start, then by
                # +offset into the final concatenated timeline. Clamped at
                # 0 in case a token's start fell inside the trimmed silence.
                start = max(0.0, t.start_ts - lead_trim_sec) + offset
                end = max(0.0, t.end_ts - lead_trim_sec) + offset
                words.append({"text": t.text, "start": start, "end": end})
        chunks.append(trimmed)
        offset += len(trimmed) / sample_rate
        first_chunk = False

    audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
    sf.write(args.out, audio, sample_rate)
    # Real stdout contract with runNativeKokoro(): the LAST line of stdout is
    # the JSON metadata payload — everything kokoro/spacy/torch may have
    # printed before it (warnings, HF download progress) is ignored.
    print(json.dumps({"words": words, "durationSec": len(audio) / sample_rate}))


if __name__ == "__main__":
    main()
