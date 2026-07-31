import tempfile
import os
import re
import asyncio
from pathlib import Path
import edge_tts
import imageio_ffmpeg

OUTPUT_DIR = Path(__file__).parent / "outputs"
UPLOAD_DIR = Path(__file__).parent / "uploads"

OUTPUT_DIR.mkdir(exist_ok=True)
UPLOAD_DIR.mkdir(exist_ok=True)


def _list_fonts():
    font_dirs = [
        "/System/Library/Fonts",
        "/Library/Fonts",
        os.path.expanduser("~/Library/Fonts"),
        "/usr/share/fonts",
    ]
    found = {}
    for d in font_dirs:
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if not f.lower().endswith((".ttf", ".ttc", ".otf")):
                continue
            name = os.path.splitext(f)[0]
            for sfx in ["-Regular", "-Bold", "-Italic", "-BoldItalic",
                         "-Medium", "-Light", " Regular", " Bold"]:
                if name.endswith(sfx):
                    name = name[:-len(sfx)]
                    break
            path = os.path.join(d, f)
            if name and name not in found:
                found[name] = path
    return [{"name": name, "path": path} for name, path in sorted(found.items())]

SYSTEM_FONTS = _list_fonts()

# Always include these safe defaults even if not found by scan
FONT_DEFAULTS = ["Arial", "Helvetica", "Times", "Courier", "Menlo", "Georgia"]
for fn in FONT_DEFAULTS:
    if not any(f["name"] == fn for f in SYSTEM_FONTS):
        SYSTEM_FONTS.append({"name": fn, "path": fn})

VOICES = [
    {"id": "en-US-JennyNeural", "name": "Jenny (US Female)"},
    {"id": "en-US-GuyNeural", "name": "Guy (US Male)"},
    {"id": "en-US-AriaNeural", "name": "Aria (US Female)"},
    {"id": "en-US-DavisNeural", "name": "Davis (US Male)"},
    {"id": "en-US-ChristopherNeural", "name": "Christopher (US Male)"},
    {"id": "en-GB-SoniaNeural", "name": "Sonia (UK Female)"},
    {"id": "en-GB-RyanNeural", "name": "Ryan (UK Male)"},
    {"id": "en-AU-NatashaNeural", "name": "Natasha (AU Female)"},
]


def _tick_to_sec(tick: int) -> float:
    return tick / 10_000_000


def _clean_text(text: str) -> str:
    # Strip markdown-ish artifacts and collapse whitespace.
    text = re.sub(r"\*{1,3}(.+?)\*{1,3}", r"\1", text)
    text = re.sub(r"#+\s*", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    # Normalize line endings and collapse 3+ blank lines to exactly one blank line
    text = re.sub(r"\r\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    # Within a paragraph, collapse runs of spaces (but not newlines)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def _insert_tts_pauses(text: str) -> str:
    """Edge TTS ignores blank lines, so convert paragraph breaks into an
    ellipsis pause marker (Edge reads '...' as a distinct pause)."""
    # A blank line = end of paragraph -> add an explicit pause.
    text = re.sub(r"\n\n", " ... ", text)
    # Remaining single newlines become spaces.
    text = re.sub(r"\n", " ", text)
    return text.strip()


def _is_pause_only(text: str) -> bool:
    return re.fullmatch(r"[.\s]{2,}", text) is not None


async def generate_tts(
    text: str,
    voice: str = "en-US-JennyNeural",
    rate: str = "+0%",
    output_path: str | None = None,
) -> tuple[bytes, list[dict]]:
    clean_text = _clean_text(text)
    tts_text = _insert_tts_pauses(clean_text)
    communicate = edge_tts.Communicate(tts_text, voice, rate=rate, boundary="WordBoundary")
    words = []
    audio_data = bytearray()

    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_data.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            start_s = _tick_to_sec(chunk["offset"])
            end_s = _tick_to_sec(chunk["offset"] + chunk["duration"])
            word_text = chunk["text"].strip()
            if not word_text or _is_pause_only(word_text):
                continue
            words.append({
                "start": start_s,
                "end": end_s,
                "text": word_text,
            })

    audio_bytes = bytes(audio_data)
    if output_path:
        with open(output_path, "wb") as f:
            f.write(audio_bytes)

    return audio_bytes, words


def build_subtitles(
    words: list[dict],
    max_words: int = 2,
    max_chars: int = 14,
) -> list[dict]:
    """Group exact word-level timestamps into 1-2 word caption chunks.

    Caption boundaries follow the actual spoken timing from Edge TTS, so
    words appear the moment they are said (no estimation, no drift).
    """
    if not words:
        return []

    subs = []
    i = 0
    while i < len(words):
        # Prefer pairing two words when they fit within max_chars and are
        # spoken close together.
        take_two = False
        if i + 1 < len(words):
            a, b = words[i], words[i + 1]
            combined = a["text"] + " " + b["text"]
            if len(combined) <= max_chars and (b["start"] - a["end"]) < 0.35:
                take_two = True

        group = words[i:i + 2] if take_two else [words[i]]
        g_start = group[0]["start"]
        g_end = group[-1]["end"]
        text = " ".join(w["text"] for w in group)

        if g_end - g_start < 0.05:
            g_end = g_start + 0.05

        subs.append({"start": g_start, "end": g_end, "text": text})
        i += len(group)

    return subs


def _sec_to_ass(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _write_ass(
    subtitles: list[dict],
    output_path: str,
    font_path: str = "Arial",
    font_size: int = 68,
    text_color: str = "white",
    stroke_color: str = "black",
    stroke_width: int = 3,
    position_y: float = 0.55,
    resolution: tuple = (1080, 1920),
):
    color_map = {
        "white": "&H00FFFFFF",
        "black": "&H00000000",
        "red": "&H000000FF",
        "yellow": "&H0000FFFF",
        "green": "&H0000FF00",
        "blue": "&H00FF0000",
        "cyan": "&H00FFFF00",
        "magenta": "&H00FF00FF",
    }

    def _parse_color(c: str) -> str:
        c = c.lower().strip().lstrip("#")
        if c in color_map:
            return color_map[c]
        if len(c) == 6:
            r, g, b = c[0:2], c[2:4], c[4:6]
            return f"&H00{b}{g}{r}"
        return "&H00FFFFFF"

    primary = _parse_color(text_color)
    outline_col = _parse_color(stroke_color)

    # Alignment 5 = center-center; MarginV offset from center, positive = down
    margin_v = int((position_y - 0.5) * resolution[1])
    play_w, play_h = resolution

    lines = [
        "[Script Info]",
        "Title: AITAH Captions",
        "ScriptType: v4.00+",
        "WrapStyle: 0",
        f"PlayResX: {play_w}",
        f"PlayResY: {play_h}",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Default,{font_path},{font_size},{primary},&H00000000,{outline_col},&H00000000,-1,0,0,0,100,100,0,0,1,{stroke_width},0,5,20,20,{margin_v},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    for sub in subtitles:
        if sub["end"] - sub["start"] < 0.04:
            continue
        start_ass = _sec_to_ass(sub["start"])
        end_ass = _sec_to_ass(sub["end"])
        text = sub["text"].replace("\n", "\\N")
        lines.append(f"Dialogue: 0,{start_ass},{end_ass},Default,,0,0,0,,{text}")

    with open(output_path, "w") as f:
        f.write("\n".join(lines))


async def captioned_video(
    background_path: str,
    story_text: str,
    output_filename: str,
    voice: str = "en-US-JennyNeural",
    rate: str = "+0%",
    font_size: int = 68,
    font: str = "Arial",
    text_color: str = "white",
    stroke_color: str = "black",
    stroke_width: int = 3,
    highlight_color: str = "#FFD700",
    position_y: float = 0.55,
    resolution: tuple = (1080, 1920),
    fps: int = 30,
    progress_callback=None,
) -> str:
    output_path = str(OUTPUT_DIR / output_filename)

    # Resolve the requested font to an actual font file path.
    # Exact name match first, then a partial/substring match (e.g. "Arial"
    # matches "Arial Unicode.ttf" on macOS). Never silently guess an unrelated
    # font: if nothing matches, raise a clear error.
    DEFAULT_FONT = "Arial"

    def _font_path(name: str):
        low = name.lower()
        for sf in SYSTEM_FONTS:
            if sf["name"].lower() == low and sf["path"].startswith("/"):
                return sf["path"]
        for sf in SYSTEM_FONTS:
            if low in sf["name"].lower() and sf["path"].startswith("/"):
                return sf["path"]
        return None

    resolved_font = _font_path(font)
    if resolved_font is None:
        resolved_font = _font_path(DEFAULT_FONT)
        if resolved_font is None:
            raise RuntimeError(
                f"Font '{font}' not found, and the fallback '{DEFAULT_FONT}' is also "
                "not installed on this system. Install the font or choose one listed "
                "under /api/fonts."
            )

    audio_bytes, sentences = await generate_tts(story_text, voice, rate)
    subtitles = build_subtitles(sentences)
    total_duration = subtitles[-1]["end"] if subtitles else 0

    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(audio_bytes)
        temp_audio = f.name

    with tempfile.NamedTemporaryFile(suffix=".ass", delete=False) as f:
        temp_ass = f.name

    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as f:
        progress_file = f.name

    try:
        _write_ass(subtitles, temp_ass, resolved_font, font_size,
                    text_color, stroke_color, stroke_width, position_y, resolution)

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        target_w, target_h = resolution

        vf = (
            f"scale={target_w}:{target_h}:force_original_aspect_ratio=increase,"
            f"crop={target_w}:{target_h},"
            f"subtitles={temp_ass}"
        )

        cmd = [
            ffmpeg,
            "-threads", "0",
            "-stream_loop", "-1",
            "-i", background_path,
            "-threads", "0",
            "-i", temp_audio,
            "-filter_complex", f"[0:v]{vf}[v]",
            "-map", "[v]",
            "-map", "1:a",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "28",
            "-threads", "0",
            "-c:a", "aac",
            "-b:a", "128k",
            "-pix_fmt", "yuv420p",
            "-r", str(fps),
            "-progress", progress_file,
            "-nostats",
            "-shortest",
            "-y",
            output_path,
        ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stderr=asyncio.subprocess.PIPE,
        )
        stderr_task = asyncio.create_task(_read_stderr(proc))

        last_pct = 0
        while True:
            try:
                with open(progress_file) as pf:
                    for line in pf:
                        line = line.strip()
                        if line.startswith("out_time_us="):
                            us = int(line.split("=")[1])
                            pct = min(round(us / (total_duration * 1_000_000) * 100), 99) if total_duration > 0 else 0
                            if pct > last_pct:
                                last_pct = pct
                                if progress_callback:
                                    await progress_callback(pct)
            except Exception:
                pass

            ret = proc.returncode
            if ret is not None:
                break
            await asyncio.sleep(0.3)

        await proc.wait()
        await stderr_task
        if progress_callback:
            await progress_callback(100)

        if proc.returncode != 0:
            raise RuntimeError("ffmpeg failed to render video")

    finally:
        for p in [temp_audio, temp_ass, progress_file]:
            if os.path.exists(p):
                os.unlink(p)

    return output_path


async def _read_stderr(proc):
    try:
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
    except Exception:
        pass


async def preview_data(
    story_text: str,
    voice: str = "en-US-JennyNeural",
    rate: str = "+0%",
) -> dict:
    audio_bytes, sentences = await generate_tts(story_text, voice, rate)
    subtitles = build_subtitles(sentences)

    import uuid
    audio_id = f"{uuid.uuid4().hex}.mp3"
    audio_path = OUTPUT_DIR / audio_id
    with open(audio_path, "wb") as f:
        f.write(audio_bytes)

    return {
        "audio_url": f"/api/audio/{audio_id}",
        "subtitles": subtitles,
        "duration": subtitles[-1]["end"] if subtitles else 0,
    }
