import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiProvider } from '../../src/ai/providers/gemini.js';
import { createOpenAICompatibleProvider } from '../../src/ai/providers/openai-compatible.js';
import { kindFromStatus, parseRetryAfter } from '../../src/ai/errors.js';
import { jsonResponse } from './helpers.js';

function stubFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return responder(url, init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const req = { system: 'SYS', messages: [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'Q2' }], json: true };

test('gemini: request shape with systemInstruction, roles and JSON mode', async () => {
  const f = stubFetch(() => jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{"answer":"x"}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } }));
  const g = createGeminiProvider({ apiKey: 'k', fetchImpl: f });
  const out = await g.complete({ ...req, model: 'gemini-3.6-flash' });
  assert.equal(out.text, '{"answer":"x"}');
  assert.deepEqual(out.usage, { inputTokens: 10, outputTokens: 3 });
  const { url, init, body } = f.calls[0];
  assert.match(url, /models\/gemini-3\.6-flash:generateContent$/);
  assert.equal(init.headers['x-goog-api-key'], 'k');
  assert.equal(body.systemInstruction.parts[0].text, 'SYS');
  assert.deepEqual(body.contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
});

test('gemini: Gemma gets the system prompt inline and no JSON mode', async () => {
  const f = stubFetch(() => jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
  await createGeminiProvider({ apiKey: 'k', fetchImpl: f }).complete({ ...req, model: 'gemma-4-31b-it' });
  const body = f.calls[0].body;
  assert.equal(body.systemInstruction, undefined);
  assert.equal(body.generationConfig.responseMimeType, undefined);
  assert.match(body.contents[0].parts[0].text, /^SYS\n/);
});

test('gemini: skips "thought" parts', async () => {
  const f = stubFetch(() => jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: 'final' }] } }] }));
  assert.equal((await createGeminiProvider({ apiKey: 'k', fetchImpl: f }).complete({ ...req, model: 'm' })).text, 'final');
});

test('gemini: 503, 429 with RetryInfo, 404 and empty output are classified', async () => {
  const cases = [
    [jsonResponse(503, { error: { code: 503, message: 'This model is currently experiencing high demand.' } }), 'overloaded'],
    [jsonResponse(429, { error: { code: 429, message: 'Resource exhausted', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41s' }] } }), 'rate_limit', 41_000],
    [jsonResponse(429, { error: { message: 'Quota exceeded for metric generate_content_free_tier_requests, limit PerDay' } }), 'quota'],
    [jsonResponse(404, { error: { message: 'models/gemini-1.5-flash is not found' } }), 'not_found'],
    [jsonResponse(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }), 'auth'],
    [jsonResponse(200, { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }), 'bad_output'],
  ];
  for (const [res, kind, retry] of cases) {
    const g = createGeminiProvider({ apiKey: 'k', fetchImpl: async () => res });
    await assert.rejects(g.complete({ ...req, model: 'm' }), (e) => {
      assert.equal(e.kind, kind);
      if (retry) assert.equal(e.retryAfterMs, retry);
      return true;
    });
  }
});

test('gemini: timeouts and network errors are classified', async () => {
  const timeout = createGeminiProvider({ apiKey: 'k', fetchImpl: async () => { throw new DOMException('t', 'TimeoutError'); } });
  await assert.rejects(timeout.complete({ ...req, model: 'm' }), (e) => e.kind === 'timeout');
  const net = createGeminiProvider({ apiKey: 'k', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(net.complete({ ...req, model: 'm' }), (e) => e.kind === 'network');
});

test('gemini: a real slow server is cut off by timeoutMs', async () => {
  const g = createGeminiProvider({
    apiKey: 'k',
    fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
  });
  const started = Date.now();
  await assert.rejects(g.complete({ ...req, model: 'm', timeoutMs: 80 }), (e) => e.kind === 'timeout');
  assert.ok(Date.now() - started < 1000);
});

test('openai-compatible: request shape, bearer key and extra headers', async () => {
  const f = stubFetch(() => jsonResponse(200, { model: 'served', choices: [{ message: { content: ' hello ' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
  const p = createOpenAICompatibleProvider({ name: 'nvidia', apiKey: 'nv', baseURL: 'https://x/v1/', headers: { 'X-Title': 't' }, fetchImpl: f });
  const out = await p.complete({ ...req, model: 'meta/llama' });
  assert.equal(out.text, 'hello');
  const { url, init, body } = f.calls[0];
  assert.equal(url, 'https://x/v1/chat/completions');
  assert.equal(init.headers.authorization, 'Bearer nv');
  assert.equal(init.headers['X-Title'], 't');
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(body.response_format, undefined, 'JSON mode is opt-in for OpenAI-compatible APIs');
});

test('openai-compatible: OpenRouter 200 with an error body is a failure', async () => {
  const p = createOpenAICompatibleProvider({ name: 'openrouter', apiKey: 'k', baseURL: 'https://x', fetchImpl: async () => jsonResponse(200, { error: { code: 429, message: 'Rate limit exceeded: free-models-per-min' } }) });
  await assert.rejects(p.complete({ ...req, model: 'm' }), (e) => e.kind === 'rate_limit' && e.status === 429);
});

test('openai-compatible: 402 out of credits, empty content, missing key', async () => {
  const p402 = createOpenAICompatibleProvider({ name: 'or', apiKey: 'k', baseURL: 'https://x', fetchImpl: async () => jsonResponse(402, { error: { message: 'Insufficient credits' } }) });
  await assert.rejects(p402.complete({ ...req, model: 'm' }), (e) => e.kind === 'quota');
  const empty = createOpenAICompatibleProvider({ name: 'or', apiKey: 'k', baseURL: 'https://x', fetchImpl: async () => jsonResponse(200, { choices: [{ message: { content: null }, finish_reason: 'length' }] }) });
  await assert.rejects(empty.complete({ ...req, model: 'm' }), (e) => e.kind === 'bad_output');
  const nokey = createOpenAICompatibleProvider({ name: 'or', baseURL: 'https://x' });
  assert.equal(nokey.configured, false);
  await assert.rejects(nokey.complete({ ...req, model: 'm' }), (e) => e.kind === 'auth');
});

test('kindFromStatus and parseRetryAfter', () => {
  assert.equal(kindFromStatus(500), 'overloaded');
  assert.equal(kindFromStatus(529), 'overloaded');
  assert.equal(kindFromStatus(401), 'auth');
  assert.equal(kindFromStatus(400, 'model xyz does not exist'), 'not_found');
  assert.equal(kindFromStatus(400, 'prompt too long'), 'bad_request');
  assert.equal(parseRetryAfter('7'), 7000);
  assert.equal(parseRetryAfter(null, { error: { details: [{ retryDelay: '1.5s' }] } }), 1500);
  assert.equal(parseRetryAfter(null, {}), undefined);
});
