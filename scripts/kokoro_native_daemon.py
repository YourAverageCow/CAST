#!/usr/bin/env python3
# Long-running variant of kokoro_native.py — invoked via `uvx --with kokoro
# --with soundfile python3 kokoro_native_daemon.py --threads N` by server.js's
# KokoroWarmPool. Stays alive across many generation requests (loading each
# KPipeline it actually needs exactly once) instead of the one-shot script's
# "load the model, synthesize once, exit" per-call cost. See that script for
# the model/timestamp background — this file only changes lifecycle/protocol,
# not the synthesis logic itself, which is copied line-for-line below.
#
# Protocol: newline-delimited JSON over stdin/stdout. One line in is one
# request, one line out is one response — no length-prefix/framing needed
# since exactly one response is written per request line read.
#   in:  {"id": <int>, "text": str, "voice": str, "speed": float, "lang": str}
#   out: {"id": <int>, "audioBase64": str, "durationSec": float, "words": [...]}
#     or {"id": <int>, "error": str} if that one request failed
# The very first line printed, before reading any input, is {"ready": true} —
# the pool manager's explicit startup signal.
import argparse
import base64
import json
import os
import sys
import tempfile

import numpy as np
import soundfile as sf
from kokoro import KPipeline

SPLIT_PATTERN = r"\n+|(?<=[.!?])\s+"

# Same trim/gap constants and algorithm as kokoro_native.py — see that
# file's comment. Kept duplicated here rather than shared, matching this
# file's own existing "synthesis logic copied line-for-line" convention.
KOKORO_MAX_TRIM_SEC = 0.6
KOKORO_INTER_CHUNK_GAP_SEC = 0.12
SILENCE_THRESHOLD = 0.01


def trim_silence(samples, sample_rate, max_trim_sec):
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


def synthesize(pipelines, text, voice, speed, lang):
    if lang not in pipelines:
        # Lazy per-lang load — a batch that only ever uses "a" voices
        # shouldn't pay to load "b" too.
        pipelines[lang] = KPipeline(lang_code=lang)
    pipeline = pipelines[lang]

    words = []
    chunks = []
    offset = 0.0
    sample_rate = 24000
    gap_samples = int(KOKORO_INTER_CHUNK_GAP_SEC * sample_rate)
    first_chunk = True
    for result in pipeline(text, voice=voice, speed=speed, split_pattern=SPLIT_PATTERN):
        if result.audio is None:
            continue
        audio = result.audio.numpy().astype(np.float32)
        trimmed, lead_trim = trim_silence(audio, sample_rate, KOKORO_MAX_TRIM_SEC)
        lead_trim_sec = lead_trim / sample_rate
        if not first_chunk:
            chunks.append(np.zeros(gap_samples, dtype=np.float32))
            offset += KOKORO_INTER_CHUNK_GAP_SEC
        if result.tokens:
            for t in result.tokens:
                if t.start_ts is None or t.end_ts is None:
                    continue
                start = max(0.0, t.start_ts - lead_trim_sec) + offset
                end = max(0.0, t.end_ts - lead_trim_sec) + offset
                words.append({"text": t.text, "start": start, "end": end})
        chunks.append(trimmed)
        offset += len(trimmed) / sample_rate
        first_chunk = False

    audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
    fd, out_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        sf.write(out_path, audio, sample_rate)
        with open(out_path, "rb") as f:
            audio_bytes = f.read()
    finally:
        try:
            os.remove(out_path)
        except OSError:
            pass
    return {
        "audioBase64": base64.b64encode(audio_bytes).decode("ascii"),
        "durationSec": len(audio) / sample_rate,
        "words": words,
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--threads", type=int, default=0)
    args = p.parse_args()

    if args.threads > 0:
        # torch is a transitive dependency of kokoro — set its thread budget
        # before any pipeline is constructed, since it's process-global and
        # doesn't change mid-life for this daemon.
        import torch
        torch.set_num_threads(args.threads)

    pipelines = {}
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            # Malformed request line — no id to reply with, nothing sane to
            # do but skip it; a real client always sends valid JSON.
            continue
        req_id = req.get("id")
        try:
            result = synthesize(
                pipelines,
                req.get("text", ""),
                req.get("voice", "af_heart"),
                req.get("speed") or 1.0,
                req.get("lang", "a"),
            )
            result["id"] = req_id
            print(json.dumps(result), flush=True)
        except Exception as e:
            # One bad request must not kill the worker — the other jobs still
            # queued to it would otherwise lose their warm-pool speedup for
            # no reason.
            print(json.dumps({"id": req_id, "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
