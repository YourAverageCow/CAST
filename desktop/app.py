import os
import uuid
import json
import shutil
import asyncio
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import HTMLResponse, FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from providers import Provider, MODELS, get_provider, DEFAULT_DEEPSEEK_KEY
from generator import generate_story, generate_ideas
from video_processor import captioned_video, VOICES, UPLOAD_DIR, OUTPUT_DIR, SYSTEM_FONTS

BASE = Path(__file__).parent
TEMPLATES = BASE / "templates"


@asynccontextmanager
async def lifespan(app: FastAPI):
    UPLOAD_DIR.mkdir(exist_ok=True)
    OUTPUT_DIR.mkdir(exist_ok=True)

    # Default background video: if video.mp4 exists at the project root,
    # register it in uploads as a stable video_id so the UI can pre-load it.
    root_video = BASE / "video.mp4"
    if root_video.exists() and not (UPLOAD_DIR / "default.mp4").exists():
        shutil.copyfile(root_video, UPLOAD_DIR / "default.mp4")

    yield


app = FastAPI(title="AITAH Video Creator", lifespan=lifespan)

jobs = {}  # job_id -> {"queue": asyncio.Queue, "result": None}


def _safe_output_path(filename: str) -> Path | None:
    name = Path(filename).name
    if name != filename:
        return None
    path = OUTPUT_DIR / name
    return path if path.exists() else None

if TEMPLATES.exists():
    app.mount("/static", StaticFiles(directory=TEMPLATES), name="static")


@app.get("/", response_class=HTMLResponse)
async def index():
    html_path = TEMPLATES / "index.html"
    return html_path.read_text() if html_path.exists() else "Templates not found"


class GenRequest(BaseModel):
    provider: str
    api_key: str
    model: str
    premise: str = ""
    word_count: int = 400


class VideoRequest(BaseModel):
    video_id: str


class TTSRequest(BaseModel):
    text: str
    voice: str = "en-US-JennyNeural"


@app.get("/api/default-video")
async def default_video():
    if (UPLOAD_DIR / "default.mp4").exists():
        return {"video_id": "default.mp4", "video_url": "/api/bg/default.mp4"}
    return {"video_id": None, "video_url": None}


@app.get("/api/bg/{filename}")
async def serve_background(filename: str):
    name = Path(filename).name
    if name != filename:
        return {"error": "invalid"}
    path = UPLOAD_DIR / name
    if path.exists():
        return FileResponse(str(path), media_type="video/mp4")
    return {"error": "not found"}


@app.get("/api/models")
async def list_models():
    return {
        provider.value: models for provider, models in MODELS.items()
    }


@app.get("/api/fonts")
async def list_fonts():
    return {"fonts": SYSTEM_FONTS}


@app.get("/api/voices")
async def list_voices():
    return {"voices": VOICES}


@app.get("/api/default-key")
async def default_key():
    # Return the DeepSeek key configured in .env so the UI can auto-fill it.
    # This is a local single-user app; the key is the user's own.
    return {"api_key": DEFAULT_DEEPSEEK_KEY, "default_provider": "deepseek", "default_model": "deepseek-chat"}


@app.post("/api/generate")
async def generate_one(req: GenRequest):
    provider = get_provider(Provider(req.provider), req.api_key, req.model)
    story = await generate_story(provider, req.premise, req.word_count)
    return {"story": story}


@app.post("/api/generate-stream")
async def generate_stream(req: GenRequest):
    from prompts import STORY_USER, build_story_system
    provider = get_provider(Provider(req.provider), req.api_key, req.model)
    premise = req.premise or "a dramatic family conflict"
    system = build_story_system(req.word_count)

    async def event_stream():
        try:
            async for chunk in provider.stream(system, STORY_USER.format(premise=premise), 0.9):
                yield f"data: {json.dumps({'chunk': chunk})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/ideas")
async def get_ideas(req: GenRequest):
    provider = get_provider(Provider(req.provider), req.api_key, req.model)
    ideas = await generate_ideas(provider)
    return {"ideas": ideas if isinstance(ideas, list) else []}


@app.post("/api/ideas-stream")
async def ideas_stream(req: GenRequest):
    from prompts import IDEAS_PROMPT
    provider = get_provider(Provider(req.provider), req.api_key, req.model)

    async def event_stream():
        try:
            async for chunk in provider.stream("You output only one short creative idea. No markdown, no quotes.", IDEAS_PROMPT, 1.0):
                yield f"data: {json.dumps({'chunk': chunk})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            yield f"data: {json.dumps({'done': True})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/upload-video")
async def upload_video(file: UploadFile = File(...)):
    ext = Path(file.filename).suffix or ".mp4"
    video_id = f"{uuid.uuid4().hex}{ext}"
    path = UPLOAD_DIR / video_id
    with open(path, "wb") as f:
        shutil.copyfileobj(file.file, f)
    return {"video_id": video_id, "filename": file.filename}


@app.post("/api/preview-tts")
async def preview_tts(req: TTSRequest):
    from video_processor import generate_tts

    audio_bytes, sentences = await generate_tts(req.text, req.voice)
    preview_id = f"{uuid.uuid4().hex}.mp3"
    preview_path = OUTPUT_DIR / preview_id
    with open(preview_path, "wb") as f:
        f.write(audio_bytes)

    duration = sentences[-1]["end"] if sentences else 0

    # Prune stale audio files so outputs/ doesn't fill up
    _prune_outputs(suffix=".mp3")

    return {
        "preview_url": f"/api/audio/{preview_id}",
        "sentence_count": len(sentences),
        "duration_seconds": round(duration, 1),
    }


def _prune_outputs(suffix: str, max_age: float = 600, keep: int = 20):
    """Delete old files with the given suffix, keeping the most recent `keep`."""
    files = sorted(
        (p for p in OUTPUT_DIR.iterdir() if p.suffix == suffix),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for p in files[keep:]:
        try:
            if (Path(__file__).parent.stat().st_mtime or 0) or p.stat().st_mtime:
                p.unlink()
        except OSError:
            pass


@app.get("/api/audio/{filename}")
async def serve_audio(filename: str):
    path = _safe_output_path(filename)
    if path and path.exists():
        return FileResponse(str(path), media_type="audio/mpeg")
    return {"error": "not found"}


@app.post("/api/create-video")
async def create_video(
    video_id: str = Form(...),
    story_text: str = Form(...),
    voice: str = Form("en-US-JennyNeural"),
    rate: str = Form("+0%"),
    font_size: int = Form(68),
    font: str = Form("Arial"),
    text_color: str = Form("white"),
    stroke_color: str = Form("black"),
    stroke_width: int = Form(3),
    highlight_color: str = Form("#FFD700"),
    position_y: float = Form(0.55),
    resolution_w: int = Form(1080),
    resolution_h: int = Form(1920),
    fps: int = Form(30),
):
    bg_path = UPLOAD_DIR / video_id
    if not bg_path.exists():
        return {"error": "Video not found. Upload a background video first."}

    job_id = uuid.uuid4().hex
    queue = asyncio.Queue()
    jobs[job_id] = {"queue": queue, "result": None, "progress": 0, "stage": None}

    async def progress_callback(pct):
        jobs[job_id]["progress"] = pct
        await queue.put({"progress": pct})

    async def run_export():
        output_filename = f"{job_id}.mp4"
        jobs[job_id]["progress"] = 5
        jobs[job_id]["stage"] = "voice"
        await queue.put({"progress": 5, "stage": "voice"})
        try:
            output_path = await captioned_video(
                background_path=str(bg_path),
                story_text=story_text,
                output_filename=output_filename,
                voice=voice,
                rate=rate,
                font_size=font_size,
                font=font,
                text_color=text_color,
                stroke_color=stroke_color,
                stroke_width=stroke_width,
                highlight_color=highlight_color,
                position_y=position_y,
                resolution=(resolution_w, resolution_h),
                fps=fps,
                progress_callback=progress_callback,
            )
            jobs[job_id]["result"] = {"video_url": f"/api/video/{output_filename}"}
        except Exception as e:
            jobs[job_id]["result"] = {"error": str(e)}
        await queue.put({"done": True, "result": jobs[job_id]["result"]})

        async def _cleanup():
            await asyncio.sleep(300)
            jobs.pop(job_id, None)
        asyncio.create_task(_cleanup())

    asyncio.create_task(run_export())
    return {"job_id": job_id}


@app.get("/api/progress/{job_id}")
async def job_progress(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return StreamingResponse(
            iter([f"data: {json.dumps({'error': 'Job not found'})}\n\n"]),
            media_type="text/event-stream",
        )

    async def event_stream():
        queue = job["queue"]
        try:
            while True:
                msg = await queue.get()
                yield f"data: {json.dumps(msg)}\n\n"
                if msg.get("done") or msg.get("error"):
                    break
        finally:
            # Always send a terminal event so the client never hangs waiting.
            yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/api/job/{job_id}")
async def job_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return {"status": "gone"}
    return {
        "status": "done" if job["result"] else "processing",
        "progress": job.get("progress", 0),
        "stage": job.get("stage"),
        "result": job["result"],
    }


class PreviewRequest(BaseModel):
    story_text: str
    voice: str = "en-US-JennyNeural"
    rate: str = "+0%"


@app.post("/api/preview")
async def preview(req: PreviewRequest):
    from video_processor import preview_data
    return await preview_data(req.story_text, req.voice, req.rate)


@app.get("/api/video/{filename}")
async def serve_video(filename: str):
    path = _safe_output_path(filename)
    if path and path.exists():
        return FileResponse(str(path), media_type="video/mp4")
    return {"error": "not found"}


@app.post("/api/cleanup")
async def cleanup():
    for d in [UPLOAD_DIR, OUTPUT_DIR]:
        for f in d.iterdir():
            if f.is_file():
                try:
                    f.unlink()
                except OSError:
                    pass
    return {"status": "ok"}
