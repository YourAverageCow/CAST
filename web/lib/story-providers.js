// Pure story-generation provider registry + request-shape builders — no
// DOM, no fetch, no streaming. Loaded as a classic <script> in the browser
// (declares these as globals, consumed unqualified by app.js) and as a
// plain require()-able module in tests, same isomorphic pattern as
// tts-engines.js. app.js's streamChat() is the only fetch/ReadableStream-
// coupled glue: it calls buildChatRequest() to get {url, headers, body},
// does the actual fetch + SSE read loop, and calls parseSSEDelta() on each
// parsed `data: ` line to extract the next text chunk — those two functions
// are the entire surface a new provider needs to plug into.
//
// Most providers implement the OpenAI-compatible Chat Completions API
// (same endpoint shape, same Bearer auth, same SSE delta shape) — those
// just need a registry entry with api: "openai". Anthropic's Messages API
// is genuinely different (separate `system` field, `x-api-key` auth,
// typed SSE events, `max_tokens` required) and gets its own branch in both
// builder functions, gated on api: "anthropic".

const STORY_PROVIDERS = {
  deepseek: {
    id: "deepseek", label: "DeepSeek", api: "openai", needsApiKey: true,
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  openai: {
    id: "openai", label: "OpenAI", api: "openai", needsApiKey: true,
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4o"],
  },
  groq: {
    id: "groq", label: "Groq", api: "openai", needsApiKey: true,
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
  },
  openrouter: {
    id: "openrouter", label: "OpenRouter", api: "openai", needsApiKey: true,
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "meta-llama/llama-3.3-70b-instruct", "google/gemini-2.0-flash-001"],
  },
  mistral: {
    id: "mistral", label: "Mistral", api: "openai", needsApiKey: true,
    baseUrl: "https://api.mistral.ai/v1",
    models: ["mistral-large-latest", "mistral-small-latest"],
  },
  gemini: {
    id: "gemini", label: "Google Gemini", api: "openai", needsApiKey: true,
    // Google's OpenAI-compatibility endpoint — same chat/completions shape
    // as everything else on the "openai" branch, no special-casing needed.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-2.0-flash", "gemini-1.5-pro"],
  },
  anthropic: {
    id: "anthropic", label: "Anthropic (Claude)", api: "anthropic", needsApiKey: true,
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
  },
  ollama: {
    id: "ollama", label: "Ollama (local)", api: "openai", needsApiKey: false,
    // Editable in Settings — this is also the escape hatch for any other
    // self-hosted OpenAI-compatible server (LM Studio, vLLM, etc.), not
    // just Ollama specifically.
    baseUrl: "http://localhost:11434/v1",
    editableBaseUrl: true,
    // No fixed list — local models are whatever the user has pulled.
    // customModel: true tells the UI to show a free-text field instead of
    // a <select>.
    models: [],
    customModel: true,
  },
};
const DEFAULT_STORY_PROVIDER = "deepseek";

// Builds {url, headers, body} for the given provider/request — the only
// thing that varies per provider. `apiKey` may be an empty string for
// providers with needsApiKey: false (Ollama).
function buildChatRequest(provider, { model, messages, temperature, apiKey, baseUrl }) {
  const base = (baseUrl || provider.baseUrl).replace(/\/+$/, "");

  if (provider.api === "anthropic") {
    // Anthropic's Messages API takes the system prompt as its own top-level
    // field rather than a message with role "system", requires max_tokens,
    // and only accepts user/assistant roles in `messages`.
    const systemMessages = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
    const chatMessages = messages.filter(m => m.role !== "system");
    return {
      url: `${base}/messages`,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model,
        system: systemMessages || undefined,
        messages: chatMessages,
        max_tokens: 4096,
        temperature,
        stream: true,
      },
    };
  }

  // OpenAI-compatible Chat Completions API — the default for every other
  // provider in the registry above.
  return {
    url: `${base}/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey || ""}`,
    },
    body: { model, stream: true, temperature, messages },
  };
}

// Given one parsed JSON payload from an SSE `data: ` line, returns the next
// text chunk to append, or null if this event carries no text (e.g.
// Anthropic's message_start/message_stop bookkeeping events).
function parseSSEDelta(apiType, data) {
  if (apiType === "anthropic") {
    if (data && data.type === "content_block_delta" && data.delta && data.delta.type === "text_delta") {
      return data.delta.text || null;
    }
    return null;
  }
  const delta = data && data.choices && data.choices[0] && data.choices[0].delta;
  return (delta && delta.content) || null;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { STORY_PROVIDERS, DEFAULT_STORY_PROVIDER, buildChatRequest, parseSSEDelta };
}
