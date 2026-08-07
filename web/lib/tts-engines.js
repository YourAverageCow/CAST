// Pluggable TTS engine registry. Loaded as a classic <script> before app.js
// (declares these as globals) — not pure (does real fetch()/DOM-Audio/
// speechSynthesis work), so unlike web/lib/captions.js etc. this isn't
// unit-tested the same way, but it's kept separate from app.js's DOM-id-
// coupled glue (settings panel elements, toasts) so the actual engine logic
// stays readable and independently reviewable.
//
// Each engine conforms to:
//   { id, label, isFree, needsApiKey, requiresOncePerSessionPermission,
//     listVoices() -> [{id,label}] | Promise<[{id,label}]>,
//     defaultVoice() -> id,
//     async generate(text, voice, config) ->
//       { audioBlob, durationSec, wordTimings?: [{text,start,end}] } }
// wordTimings is optional — real per-word/character alignment when an
// engine can provide it (ElevenLabs' /with-timestamps, Browser Speech's
// native boundary events), tokenized identically to
// captions.js's computeWordTimings so it's a drop-in replacement. app.js
// falls back to computeWordTimings' proportional estimate when absent.
//
// Engines that need app.js-level setup (Piper's ensurePiper(), Kokoro's
// ensureKokoro()) call those as bare globals at CALL time, not parse time —
// classic <script> tags share one global scope and app.js has fully run
// (including init()) long before any generate() call happens, so load
// order here only matters for *this file* being listed before app.js in
// index.html, not for these cross-references.

// Same <audio>-element metadata-probe pattern already used for background
// videos (probeVideoDimensions in app.js) — cloud engines and Kokoro's WAV
// output don't carry a pre-computed duration the way Piper's response does.
function probeAudioDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(audio.duration || 0); };
    audio.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
    audio.src = url;
  });
}

// ---------- Piper (existing engine, unchanged behavior) ----------
// libritts_r is audiobook-trained and reads flat/monotone. These are more
// expressive/energetic Piper voices, verified to actually exist in the
// rhasspy/piper-voices HuggingFace repo AND to use the standard 256-symbol
// phoneme table — voices trained with a different-sized vocabulary throw an
// ONNX Gather out-of-bounds error mid-generation, so they're deliberately
// excluded rather than merely undocumented.
const PIPER_VOICES = [
  "en_US-ryan-medium",
  "en_US-lessac-medium",
  "en_US-amy-medium",
  "en_US-hfc_female-medium",
  "en_US-hfc_male-medium",
  "en_US-joe-medium",
  "en_US-kristin-medium",
  "en_US-norman-medium",
  "en_US-libritts_r-medium",
  "en_GB-alan-medium",
  "en_GB-alba-medium",
  "en_GB-jenny_dioco-medium",
  "en_GB-northern_english_male-medium",
];
const PIPER_VOICE_LABELS = {
  "en_US-ryan-medium": "Ryan (US male)",
  "en_US-lessac-medium": "Lessac (US male, clear)",
  "en_US-amy-medium": "Amy (US female)",
  "en_US-hfc_female-medium": "HFC Female (US)",
  "en_US-hfc_male-medium": "HFC Male (US)",
  "en_US-joe-medium": "Joe (US male)",
  "en_US-kristin-medium": "Kristin (US female)",
  "en_US-norman-medium": "Norman (US male, dramatic)",
  "en_US-libritts_r-medium": "LibriTTS (US, flat/audiobook)",
  "en_GB-alan-medium": "Alan (UK male)",
  "en_GB-alba-medium": "Alba (UK female)",
  "en_GB-jenny_dioco-medium": "Jenny (UK female)",
  "en_GB-northern_english_male-medium": "Northern English (UK male)",
};
const PiperEngine = {
  id: "piper",
  label: "Piper (local, free)",
  isFree: true,
  needsApiKey: false,
  requiresOncePerSessionPermission: false,
  listVoices() {
    return PIPER_VOICES.map(id => ({ id, label: PIPER_VOICE_LABELS[id] || id }));
  },
  defaultVoice() { return PIPER_VOICES[0]; },
  async generate(text, voice) {
    const engine = await ensurePiper();
    const response = await engine.generate(text, voice, 0);
    return { audioBlob: response.file, durationSec: (response.duration || 0) / 1000 };
  },
};

// ---------- Kokoro (new, local, free — higher quality than Piper) ----------
// 82M-param open-source model (StyleTTS2), run entirely client-side via
// kokoro-js (ONNX + Transformers.js, WASM/WebGPU) — same "no API key, no
// per-use cost" shape as Piper, verified to sound clearly less synthetic in
// every independent comparison checked before building this. Model weights
// (q8 quantized, ~86MB) are vendored locally in web/vendor/kokoro-model/ for
// offline-first-launch, same as Piper's default voice in
// web/vendor/piper-voices/ — see app.js's patchKokoroFetch().
const KOKORO_VOICES = [
  { id: "af_heart", label: "Heart (US female)" },
  { id: "af_bella", label: "Bella (US female)" },
  { id: "af_nova", label: "Nova (US female)" },
  { id: "am_adam", label: "Adam (US male)" },
  { id: "am_michael", label: "Michael (US male)" },
  { id: "am_onyx", label: "Onyx (US male)" },
  { id: "bf_emma", label: "Emma (UK female)" },
  { id: "bf_isabella", label: "Isabella (UK female)" },
  { id: "bm_daniel", label: "Daniel (UK male)" },
  { id: "bm_george", label: "George (UK male)" },
];
const KokoroEngine = {
  id: "kokoro",
  label: "Kokoro (local, free, higher quality)",
  isFree: true,
  needsApiKey: false,
  requiresOncePerSessionPermission: false,
  listVoices() { return KOKORO_VOICES; },
  defaultVoice() { return KOKORO_VOICES[0].id; },
  async generate(text, voice, config) {
    const tts = await ensureKokoro();
    const audio = await tts.generate(text, { voice, speed: (config && config.speed) || 1 });
    const wavBuffer = audio.toWav();
    const audioBlob = new Blob([wavBuffer], { type: "audio/wav" });
    // Parse the WAV header directly (same parseWavDurationSec the ffmpeg
    // worker later uses on these exact bytes for the render's own duration
    // bound) instead of probing via <audio>.duration — the DOM probe was
    // observed to resolve a too-short duration for Kokoro's WAV output,
    // compressing every word timing and (via the title-card's dynamic
    // duration calc) cutting the final render short before the real audio
    // finished. Falls back to the DOM probe only if header parsing fails.
    const durationSec = parseWavDurationSec(new Uint8Array(wavBuffer)) || await probeAudioDuration(audioBlob);
    return { audioBlob, durationSec };
  },
};

// ---------- OpenAI TTS (new, cloud, paid) ----------
const OPENAI_TTS_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
const OpenAIEngine = {
  id: "openaiTts",
  label: "OpenAI TTS (paid)",
  isFree: false,
  needsApiKey: true,
  requiresOncePerSessionPermission: false,
  listVoices() {
    return OPENAI_TTS_VOICES.map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
  },
  defaultVoice() { return OPENAI_TTS_VOICES[0]; },
  async generate(text, voice, config) {
    if (!config || !config.apiKey) throw new Error("OpenAI TTS needs an API key (Settings → Narration Voice).");
    const resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model || "tts-1", voice, input: text, speed: config.speed || 1 }),
    });
    if (!resp.ok) throw new Error(`OpenAI TTS error: ${resp.status} — check your API key.`);
    const audioBlob = await resp.blob();
    const durationSec = await probeAudioDuration(audioBlob);
    return { audioBlob, durationSec };
  },
};

// ---------- ElevenLabs (new, cloud, free tier + paid) ----------
// A short curated set of well-known stock voice IDs — avoids an extra
// /v1/voices round-trip before every single generation just to populate a
// dropdown. (Voice IDs are stable per-account defaults ElevenLabs ships to
// every user, not story/character content.)
const ELEVENLABS_VOICES = [
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel (US female)" },
  { id: "AZnzlk1XvdvUeBnXmlld", label: "Domi (US female)" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Bella (US female)" },
  { id: "ErXwobaYiN019PkySvjV", label: "Antoni (US male)" },
  { id: "TxGEqnHWrfWFTfGW9XjX", label: "Josh (US male)" },
  { id: "VR6AewLTigWG4xSOukaG", label: "Arnold (US male)" },
  { id: "pNInz6obpgDQGcFmaJgB", label: "Adam (US male)" },
  { id: "yoZ06aMxZJJ28mfd3POQ", label: "Sam (US male)" },
];
const ElevenLabsEngine = {
  id: "elevenlabs",
  label: "ElevenLabs (free tier + paid)",
  isFree: false,
  needsApiKey: true,
  requiresOncePerSessionPermission: false,
  listVoices() { return ELEVENLABS_VOICES; },
  defaultVoice() { return ELEVENLABS_VOICES[0].id; },
  async generate(text, voice, config) {
    if (!config || !config.apiKey) throw new Error("ElevenLabs needs an API key (Settings → Narration Voice).");
    // /with-timestamps (vs. the plain endpoint) returns real character-level
    // forced alignment alongside the audio — base64 audio + JSON, not raw
    // bytes — which lets captions land exactly when each word is actually
    // spoken instead of falling back to computeWordTimings' proportional
    // estimate.
    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "xi-api-key": config.apiKey },
      body: JSON.stringify({
        text, model_id: config.modelId || "eleven_multilingual_v2",
        voice_settings: { stability: config.stability ?? 0.5, similarity_boost: config.similarityBoost ?? 0.75 },
      }),
    });
    if (!resp.ok) throw new Error(`ElevenLabs error: ${resp.status} — check your API key.`);
    const data = await resp.json();
    const audioBytes = Uint8Array.from(atob(data.audio_base64), c => c.charCodeAt(0));
    const audioBlob = new Blob([audioBytes], { type: "audio/mpeg" });

    let wordTimings = null;
    let durationSec = 0;
    const alignment = data.alignment;
    if (alignment && alignment.characters && alignment.characters.length) {
      wordTimings = alignWordsFromCharacters(
        text, alignment.characters,
        alignment.character_start_times_seconds, alignment.character_end_times_seconds
      );
      durationSec = alignment.character_end_times_seconds[alignment.character_end_times_seconds.length - 1] || 0;
    }
    if (!durationSec) durationSec = await probeAudioDuration(audioBlob);
    return { audioBlob, durationSec, wordTimings };
  },
};

// ---------- Browser Speech (new, free, OS-native voices) ----------
// speechSynthesis plays live through the OS's TTS voices with no standard
// API to retrieve the audio as a file — the only capture path is recording
// tab audio via getDisplayMedia while the utterance plays. Requires a
// one-time "share tab audio" permission grant; the resulting MediaStream is
// cached and reused for the rest of the session so this doesn't reprompt on
// every single generation. Structurally the least reliable engine here —
// quality depends entirely on the OS's installed voices, and tab-audio
// capture support is historically weaker/more inconsistent in Firefox than
// Chrome — surfaced to the user via requiresOncePerSessionPermission and an
// explicit settings-panel note, not hidden.
let cachedSpeechStream = null;
async function ensureSpeechCaptureStream() {
  if (cachedSpeechStream && cachedSpeechStream.active) return cachedSpeechStream;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  } catch (e) {
    throw new Error("Screen/tab-audio sharing was denied or cancelled — Browser Speech needs it to record narration.");
  }
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach(t => t.stop());
    throw new Error("No audio track was captured — make sure to check \"Share tab audio\" in the picker.");
  }
  stream.getVideoTracks().forEach(t => t.stop()); // discard video, keep only the audio track(s)
  cachedSpeechStream = stream;
  stream.getAudioTracks()[0].addEventListener("ended", () => { cachedSpeechStream = null; });
  return stream;
}
// speechSynthesis.getVoices() is populated asynchronously in some browsers
// (empty on first call until the "voiceschanged" event fires) — race a
// short timeout so this never hangs forever on a browser that never fires it.
function getSpeechVoicesAsync() {
  return new Promise((resolve) => {
    const existing = speechSynthesis.getVoices();
    if (existing.length) { resolve(existing); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      speechSynthesis.onvoiceschanged = null;
      resolve(speechSynthesis.getVoices());
    };
    speechSynthesis.onvoiceschanged = finish;
    setTimeout(finish, 1000);
  });
}
const BrowserSpeechEngine = {
  id: "browserSpeech",
  label: "Browser Speech (free, OS voices)",
  isFree: true,
  needsApiKey: false,
  requiresOncePerSessionPermission: true,
  async listVoices() {
    const voices = await getSpeechVoicesAsync();
    return voices.map(v => ({ id: v.name, label: `${v.name} (${v.lang})` }));
  },
  defaultVoice() { return null; }, // resolved async — caller falls back to whatever listVoices()[0] is
  async generate(text, voiceName, config) {
    const stream = await ensureSpeechCaptureStream();
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = (e) => reject(e.error || new Error("MediaRecorder failed"));
    });
    // SpeechSynthesisUtterance fires a native 'boundary' event per word (in
    // supporting browsers — Chrome/Edge; not guaranteed everywhere) with a
    // real elapsed-time offset, for free, during the exact recording window
    // above — real alignment data instead of computeWordTimings' estimate.
    // charIndex marks a word's START only; used below (relative to
    // recording start, which happens right before speak()) to build
    // {charIndex, elapsedTime} pairs.
    const boundaries = [];
    recorder.start();
    try {
      const voices = await getSpeechVoicesAsync();
      const utter = new SpeechSynthesisUtterance(text);
      const voice = voices.find(v => v.name === voiceName);
      if (voice) utter.voice = voice;
      utter.rate = (config && config.rate) || 1;
      utter.pitch = (config && config.pitch) || 1;
      utter.onboundary = (e) => {
        if (e.name && e.name !== "word") return; // some browsers also fire sentence boundaries
        boundaries.push({ charIndex: e.charIndex, elapsedTime: e.elapsedTime });
      };
      const spoken = new Promise((resolve, reject) => {
        utter.onend = resolve;
        utter.onerror = (e) => reject(new Error("Speech synthesis failed: " + (e.error || "unknown")));
      });
      speechSynthesis.speak(utter);
      await spoken;
    } finally {
      recorder.stop();
    }
    await stopped;
    const audioBlob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    const durationSec = await probeAudioDuration(audioBlob);

    // Only trust the boundary events if there's exactly one per word this
    // app's own tokenizer would produce — browsers don't guarantee 'word'
    // boundaries line up 1:1 with whitespace-tokenization (numbers,
    // contractions, locale quirks), and a mismatched mapping would silently
    // assign wrong words to wrong times, worse than just estimating.
    let wordTimings = null;
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
    const allWords = paragraphs.flatMap(splitParagraphWords);
    if (boundaries.length === allWords.length) {
      wordTimings = allWords.map((w, i) => ({
        text: w,
        start: boundaries[i].elapsedTime,
        end: i + 1 < allWords.length ? boundaries[i + 1].elapsedTime : durationSec,
      }));
    }
    return { audioBlob, durationSec, wordTimings };
  },
};

// ---------- PocketTTS (new, native backend — Kyutai, CPU-only, no browser build) ----------
// A small (100M param) model with no client-side/WASM/ONNX build, unlike
// Piper/Kokoro — server.js shells out to it via `uvx pocket-tts` the same
// way it already does for whisper (checkPocketTts/runNativePocketTts,
// mirroring checkWhisper/runNativeTranscribe). "Voice" here is really
// language selection: `pocket-tts generate --language <id>` (with `--voice`
// omitted) auto-picks one Kyutai-curated built-in voice per language —
// confirmed live via `uvx pocket-tts generate --help`, which documents the
// exact mapping quoted in each label below. There's no way to pick a named
// voice independent of language without pointing `--voice` at a custom
// cloning-reference audio file, which is out of scope here (same fixed-
// voice-roster UX as every other engine, not a cloning UI).
const POCKET_TTS_VOICES = [
  { id: "english", label: "Alba (English)" },
  { id: "french", label: "Estelle (French)" },
  { id: "german", label: "Juergen (German)" },
  { id: "italian", label: "Giovanni (Italian)" },
  { id: "portuguese", label: "Rafael (Portuguese)" },
  { id: "spanish", label: "Lola (Spanish)" },
];
const PocketTtsEngine = {
  id: "pocketTts",
  label: "PocketTTS (local, free, CPU)",
  isFree: true,
  needsApiKey: false,
  requiresOncePerSessionPermission: false,
  listVoices() { return POCKET_TTS_VOICES; },
  defaultVoice() { return POCKET_TTS_VOICES[0].id; },
  async generate(text, voice) {
    const resp = await fetch("/pockettts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });
    if (!resp.ok) {
      let msg = `PocketTTS error: ${resp.status}`;
      try { const errJson = await resp.json(); if (errJson.error) msg = errJson.error; } catch (e) { /* non-JSON error body */ }
      throw new Error(msg);
    }
    const audioBlob = await resp.blob();
    // Deliberately NOT parseWavDurationSec here (unlike Kokoro, which
    // prefers it) — confirmed live that pocket-tts writes a placeholder
    // RIFF/data chunk size (a fixed ~2,000,000,000-byte sentinel, never
    // patched to the real size after writing) rather than the true byte
    // count, which would silently poison every downstream caption timing
    // with a wildly wrong duration. The DOM-based probe reads the audio
    // itself instead of trusting that header field, so it's unaffected.
    const durationSec = await probeAudioDuration(audioBlob);
    return { audioBlob, durationSec };
  },
};

const TTS_ENGINES = {
  piper: PiperEngine,
  kokoro: KokoroEngine,
  openaiTts: OpenAIEngine,
  elevenlabs: ElevenLabsEngine,
  browserSpeech: BrowserSpeechEngine,
  pocketTts: PocketTtsEngine,
};
const DEFAULT_TTS_ENGINE = "piper";

if (typeof module !== "undefined" && module.exports) {
  module.exports = { TTS_ENGINES, DEFAULT_TTS_ENGINE, probeAudioDuration };
}
