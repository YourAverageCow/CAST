const test = require("node:test");
const assert = require("node:assert/strict");
const { STORY_PROVIDERS, DEFAULT_STORY_PROVIDER, buildChatRequest, parseSSEDelta } = require("./story-providers.js");

test("DEFAULT_STORY_PROVIDER points at a real registry entry", () => {
  assert.ok(STORY_PROVIDERS[DEFAULT_STORY_PROVIDER]);
});

test("every registry entry has the required shape", () => {
  for (const [id, provider] of Object.entries(STORY_PROVIDERS)) {
    assert.equal(provider.id, id);
    assert.ok(provider.label);
    assert.ok(provider.api === "openai" || provider.api === "anthropic");
    assert.equal(typeof provider.needsApiKey, "boolean");
    assert.ok(typeof provider.baseUrl === "string");
    assert.ok(Array.isArray(provider.models));
  }
});

test("ollama is local, keyless, and has an editable base URL with no fixed model list", () => {
  const ollama = STORY_PROVIDERS.ollama;
  assert.equal(ollama.needsApiKey, false);
  assert.equal(ollama.editableBaseUrl, true);
  assert.equal(ollama.customModel, true);
  assert.deepEqual(ollama.models, []);
  assert.ok(ollama.baseUrl.includes("localhost"));
});

test("buildChatRequest builds an OpenAI-compatible request for an 'openai' provider", () => {
  const provider = STORY_PROVIDERS.deepseek;
  const messages = [{ role: "system", content: "sys" }, { role: "user", content: "hi" }];
  const req = buildChatRequest(provider, { model: "deepseek-chat", messages, temperature: 0.9, apiKey: "key123" });
  assert.equal(req.url, "https://api.deepseek.com/v1/chat/completions");
  assert.equal(req.headers.Authorization, "Bearer key123");
  assert.equal(req.body.model, "deepseek-chat");
  assert.equal(req.body.stream, true);
  assert.deepEqual(req.body.messages, messages);
});

test("buildChatRequest strips trailing slashes from a custom base URL", () => {
  const provider = STORY_PROVIDERS.ollama;
  const req = buildChatRequest(provider, { model: "llama3.1", messages: [], temperature: 0.9, apiKey: "", baseUrl: "http://localhost:11434/v1/" });
  assert.equal(req.url, "http://localhost:11434/v1/chat/completions");
});

test("buildChatRequest omits a real Authorization value when apiKey is empty (Ollama)", () => {
  const provider = STORY_PROVIDERS.ollama;
  const req = buildChatRequest(provider, { model: "llama3.1", messages: [], temperature: 0.9, apiKey: "" });
  assert.equal(req.headers.Authorization, "Bearer ");
});

test("buildChatRequest builds an Anthropic Messages API request, splitting out the system message", () => {
  const provider = STORY_PROVIDERS.anthropic;
  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Write a story." },
  ];
  const req = buildChatRequest(provider, { model: "claude-3-5-sonnet-20241022", messages, temperature: 0.9, apiKey: "sk-ant-key" });
  assert.equal(req.url, "https://api.anthropic.com/v1/messages");
  assert.equal(req.headers["x-api-key"], "sk-ant-key");
  assert.equal(req.headers["anthropic-version"], "2023-06-01");
  assert.equal(req.headers.Authorization, undefined);
  assert.equal(req.body.system, "You are a helpful assistant.");
  assert.deepEqual(req.body.messages, [{ role: "user", content: "Write a story." }]);
  assert.ok(req.body.max_tokens > 0);
});

test("buildChatRequest joins multiple system messages for Anthropic", () => {
  const provider = STORY_PROVIDERS.anthropic;
  const messages = [
    { role: "system", content: "First rule." },
    { role: "system", content: "Second rule." },
    { role: "user", content: "Go." },
  ];
  const req = buildChatRequest(provider, { model: "claude-3-5-sonnet-20241022", messages, temperature: 0.9, apiKey: "k" });
  assert.equal(req.body.system, "First rule.\n\nSecond rule.");
});

test("parseSSEDelta extracts text from an OpenAI-shaped delta", () => {
  const data = { choices: [{ delta: { content: "hello" } }] };
  assert.equal(parseSSEDelta("openai", data), "hello");
});

test("parseSSEDelta returns null for an OpenAI event with no content delta", () => {
  const data = { choices: [{ delta: {} }] };
  assert.equal(parseSSEDelta("openai", data), null);
  assert.equal(parseSSEDelta("openai", {}), null);
});

test("parseSSEDelta extracts text from an Anthropic content_block_delta event", () => {
  const data = { type: "content_block_delta", delta: { type: "text_delta", text: "world" } };
  assert.equal(parseSSEDelta("anthropic", data), "world");
});

test("parseSSEDelta returns null for non-text Anthropic events (message_start, etc.)", () => {
  assert.equal(parseSSEDelta("anthropic", { type: "message_start" }), null);
  assert.equal(parseSSEDelta("anthropic", { type: "content_block_delta", delta: { type: "input_json_delta" } }), null);
});
