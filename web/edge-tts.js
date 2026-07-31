// Edge TTS client that runs entirely in the browser.
// Replicates the edge-tts protocol over WebSocket — high-quality Microsoft
// neural voices, no server, no wasm, works on GitHub Pages.
// Returns WAV audio (decoded from MP3 chunks) plus word boundary timings.

// Secure clock helpers
function getUnixTimestamp() {
  return Math.floor(Date.now() / 1000);
}

// SHA-256 hex digest
async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Generate the Sec-MS-GEC token (edge-tts DRM)
async function generateSecMsGec() {
  const WIN_EPOCH = 11644473600;      // seconds from 1601-01-01 to 1970-01-01
  const S_TO_NS = 1e9;
  const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  let ticks = getUnixTimestamp() + WIN_EPOCH;
  ticks -= ticks % 300;               // round down to nearest 5 minutes
  ticks *= S_TO_NS / 100;             // 100-nanosecond intervals
  const strToHash = `${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`;
  return (await sha256Hex(strToHash)).toUpperCase();
}

function connectId() {
  // UUID v4
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function dateToString() {
  return new Date().toUTCString();
}

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function mkssml(voice, text, rate = "+0%", pitch = "+0Hz", volume = "+0%") {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
    `${escapeXml(text)}` +
    "</prosody></voice></speak>"
  );
}

// MP3 decoder (minimal) — we use the browser's built-in decoder instead:
// chunks are fed to a MediaSource / or decoded via AudioContext.

// Main synthesis: returns a Blob (WAV) + word timings
export async function edgeTTS(text, {
  voice = "en-US-EmmaMultilingualNeural",
  rate = "+0%",
  pitch = "+0Hz",
  volume = "+0%",
  onProgress = null,
} = {}) {
  const WSS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
  const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  const SEC_MS_GEC_VERSION = "1-143.0.3650.75";
  const wsUrl = `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&ConnectionId=${connectId()}` +
    `&Sec-MS-GEC=${await generateSecMsGec()}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, "13");
    const audioChunks = [];
    let wordBoundaries = [];
    let settled = false;

    function fail(err) {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) {}
      reject(err);
    }

    function finish() {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) {}
      // Concatenate MP3 chunks and decode to WAV
      decodeMp3ToWav(audioChunks).then(wav => {
        resolve({ file: wav, words: wordBoundaries, duration: 0 });
      }).catch(fail);
    }

    ws.onopen = () => {
      // 1. speech.config
      ws.send(
        "X-Timestamp:" + dateToString() + "\r\n" +
        "Content-Type:application/json; charset=utf-8\r\n" +
        "Path:speech.config\r\n\r\n" +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
        '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"' +
        '},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
      );

      // 2. SSML
      const ssml = mkssml(voice, text, rate, pitch, volume);
      ws.send(
        "X-RequestId:" + connectId() + "\r\n" +
        "Content-Type:application/ssml+xml\r\n" +
        "X-Timestamp:" + dateToString() + "\r\n" +
        "Path:ssml\r\n\r\n" +
        ssml
      );
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        // Text metadata frame
        if (event.data.includes("Path:audio.metadata")) {
          const body = event.data.split("\r\n\r\n")[1] || "";
          try {
            const json = JSON.parse(body);
            const metas = json?.Metadata || [];
            for (const m of metas) {
              if (m.Type === "WordBoundary") {
                // Offset/Duration are directly on Data, in 100-nanosecond ticks
                const offsetMs = Number(m.Data?.Offset || 0) / 10000;
                const durMs = Number(m.Data?.Duration || 0) / 10000;
                const w = String(m.Data?.text?.Text || "").trim();
                if (w) {
                  wordBoundaries.push({
                    text: w,
                    start: offsetMs / 1000,
                    end: (offsetMs + durMs) / 1000,
                  });
                }
              }
            }
          } catch (e) {}
        }
      } else if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
        // Binary audio frame
        event.data.arrayBuffer().then(buf => {
          audioChunks.push(new Uint8Array(buf));
          if (onProgress) onProgress(audioChunks.length);
        });
      }
    };

    ws.onerror = (e) => fail(new Error("Edge TTS connection failed"));
    ws.onclose = () => {
      if (!settled) finish();
    };
  });
}

// Decode MP3 chunks (browser handles this) -> WAV Blob
async function decodeMp3ToWav(mp3Chunks) {
  const blob = new Blob(mp3Chunks, { type: "audio/mpeg" });
  const arrayBuf = await blob.arrayBuffer();

  // Use AudioContext to decode, then encode to WAV
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);
  await ctx.close();

  return encodeWav(audioBuf);
}

// Convert AudioBuffer to 16-bit PCM WAV Blob
function encodeWav(audioBuffer) {
  const numCh = Math.min(audioBuffer.numberOfChannels, 2);
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);           // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  // Interleave channels into 16-bit PCM
  let offset = 44;
  for (let ch = 0; ch < numCh; ch++) {
    const chData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < numFrames; i++) {
      const sample = Math.max(-1, Math.min(1, chData[i]));
      view.setInt16(offset + (ch * bytesPerSample), sample * 0x7FFF, true);
    }
    offset += numFrames * bytesPerSample;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export const EDGE_VOICES = [
  { id: "en-US-JennyNeural", name: "Jenny (US Female)" },
  { id: "en-US-GuyNeural", name: "Guy (US Male)" },
  { id: "en-US-AriaNeural", name: "Aria (US Female)" },
  { id: "en-US-DavisNeural", name: "Davis (US Male)" },
  { id: "en-US-EmmaMultilingualNeural", name: "Emma (US Female, Multilingual)" },
  { id: "en-GB-SoniaNeural", name: "Sonia (UK Female)" },
  { id: "en-GB-RyanNeural", name: "Ryan (UK Male)" },
  { id: "en-AU-NatashaNeural", name: "Natasha (AU Female)" },
];
