import test from 'node:test';
import assert from 'node:assert/strict';
import { createLLMRouter } from '../../src/ai/router.js';
import { parseChain, simulateOutage, createProvidersFromEnv, createRouterFromEnv } from '../../src/ai/chain.js';
import { AIError } from '../../src/ai/errors.js';
import { fakeProvider, fail, fakeClock } from './helpers.js';

const msgs = [{ role: 'user', content: 'hi' }];

test('uses the first model when it works', async () => {
  const a = fakeProvider('a', () => 'from a');
  const b = fakeProvider('b', () => 'from b');
  const r = createLLMRouter({ chain: [{ provider: 'a', model: 'a1' }, { provider: 'b', model: 'b1' }], providers: { a, b } });
  const out = await r.generate({ messages: msgs });
  assert.equal(out.text, 'from a');
  assert.equal(out.target, 'a:a1');
  assert.equal(b.calls.length, 0);
});

test('falls back to the next model on 503 and records attempts', async () => {
  const a = fakeProvider('a', () => fail('overloaded', { status: 503 }));
  const b = fakeProvider('b', () => 'from b');
  const r = createLLMRouter({ chain: [{ provider: 'a', model: 'a1' }, { provider: 'b', model: 'b1' }], providers: { a, b } });
  const out = await r.generate({ messages: msgs });
  assert.equal(out.text, 'from b');
  assert.deepEqual(out.attempts.map((x) => [x.target, x.ok, x.kind]), [['a:a1', false, 'overloaded'], ['b:b1', true, undefined]]);
});

test('a busy model is skipped during its cooldown, then tried again', async () => {
  const now = fakeClock();
  let aDown = true;
  const a = fakeProvider('a', () => (aDown ? fail('rate_limit', { status: 429, retryAfterMs: 5000 }) : 'from a'));
  const b = fakeProvider('b', () => 'from b');
  const r = createLLMRouter({ chain: [{ provider: 'a', model: 'a1' }, { provider: 'b', model: 'b1' }], providers: { a, b }, now, cooldowns: { rate_limit: 60_000 } });

  await r.generate({ messages: msgs });
  assert.equal(a.calls.length, 1);
  assert.equal(r.status()[0].state, 'cooling');

  await r.generate({ messages: msgs }); // a is cooling -> straight to b
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 2);

  aDown = false;
  now.advance(61_000);
  const out = await r.generate({ messages: msgs });
  assert.equal(out.target, 'a:a1');
  assert.equal(r.status()[0].state, 'ready');
});

test('provider Retry-After wins when longer than the default cooldown', async () => {
  const now = fakeClock();
  const a = fakeProvider('a', () => fail('rate_limit', { retryAfterMs: 120_000 }));
  const b = fakeProvider('b', () => 'ok');
  const r = createLLMRouter({ chain: [{ provider: 'a', model: 'x' }, { provider: 'b', model: 'y' }], providers: { a, b }, now });
  await r.generate({ messages: msgs });
  assert.equal(r.status()[0].coolingForMs, 120_000);
});

test('repeated failures double the cooldown', async () => {
  const now = fakeClock();
  const a = fakeProvider('a', () => fail('overloaded'));
  const b = fakeProvider('b', () => 'ok');
  const r = createLLMRouter({ chain: [{ provider: 'a', model: 'x' }, { provider: 'b', model: 'y' }], providers: { a, b }, now, cooldowns: { overloaded: 1000 } });
  await r.generate({ messages: msgs });
  assert.equal(r.status()[0].coolingForMs, 1000);
  now.advance(1001);
  await r.generate({ messages: msgs });
  assert.equal(r.status()[0].coolingForMs, 2000);
});

test('last-chance pass retries cooling models when nothing else is left', async () => {
  const now = fakeClock();
  let n = 0;
  const a = fakeProvider('a', () => (n++ === 0 ? fail('overloaded') : 'a recovered'));
  const r = createLLMRouter({ chain: [{ provider: 'a', model: 'x' }], providers: { a }, now });
  await assert.rejects(r.generate({ messages: msgs }));
  const out = await r.generate({ messages: msgs }); // cooling, but it is the only option
  assert.equal(out.text, 'a recovered');
});

test('bad keys and retired models are not retried in the last-chance pass', async () => {
  const a = fakeProvider('a', () => fail('auth', { status: 401 }));
  const b = fakeProvider('b', () => fail('not_found', { status: 404 }));
  const r = createLLMRouter({ chain: [{ provider: 'a', model: 'x' }, { provider: 'b', model: 'y' }], providers: { a, b } });
  await assert.rejects(r.generate({ messages: msgs }), /All AI providers failed/);
  await assert.rejects(r.generate({ messages: msgs }));
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
});

test('unusable output (parse throws) moves on to the next model without cooldown', async () => {
  const a = fakeProvider('a', () => 'not json');
  const b = fakeProvider('b', () => '{"answer":"hi"}');
  const r = createLLMRouter({ chain: [{ provider: 'a', model: 'x' }, { provider: 'b', model: 'y' }], providers: { a, b } });
  const out = await r.generate({ messages: msgs, parse: JSON.parse });
  assert.deepEqual(out.data, { answer: 'hi' });
  assert.equal(out.attempts[0].kind, 'bad_output');
  assert.equal(r.status()[0].state, 'ready');
});

test('per-model timeout is tight while there is a fallback, full budget for the last one', async () => {
  const seen = [];
  const a = fakeProvider('a', (m, req) => {
    seen.push(['a', req.timeoutMs]);
    return fail('timeout');
  });
  const b = fakeProvider('b', (m, req) => {
    seen.push(['b', req.timeoutMs]);
    return 'ok';
  });
  const r = createLLMRouter({ chain: [{ provider: 'a', model: 'x' }, { provider: 'b', model: 'y' }], providers: { a, b }, timeoutMs: 1000, totalBudgetMs: 20_000 });
  await r.generate({ messages: msgs });
  assert.equal(seen[0][1], 1000);
  assert.ok(seen[1][1] > 15_000, `last model should get the remaining budget, got ${seen[1][1]}`);
});

test('models without a key are skipped and reported as disabled', async () => {
  const providers = createProvidersFromEnv({ GEMINI_API_KEY: '' });
  const r = createLLMRouter({ chain: parseChain('gemini:g,ollama:l'), providers });
  assert.equal(r.enabledCount, 0);
  assert.deepEqual(r.status().map((s) => s.disabledReason), ['no API key', 'set OLLAMA_BASE_URL to enable']);
  await assert.rejects(r.generate({ messages: msgs }), /No AI provider is configured/);
});

test('`only` pins a single target and ignores its cooldown (health checks)', async () => {
  const now = fakeClock();
  let n = 0;
  const a = fakeProvider('a', () => (n++ === 0 ? fail('overloaded') : 'a ok'));
  const b = fakeProvider('b', () => 'b ok');
  const r = createLLMRouter({ chain: [{ provider: 'a', model: 'x' }, { provider: 'b', model: 'y' }], providers: { a, b }, now });
  await r.generate({ messages: msgs });
  const out = await r.generate({ messages: msgs, only: 'a:x' });
  assert.equal(out.text, 'a ok');
  assert.equal(b.calls.length, 1);
});

test('a caller abort stops the chain', async () => {
  const ac = new AbortController();
  const a = fakeProvider('a', () => {
    ac.abort();
    throw new AIError('cancelled', { kind: 'aborted' });
  });
  const b = fakeProvider('b', () => 'b');
  const r = createLLMRouter({ chain: [{ provider: 'a', model: 'x' }, { provider: 'b', model: 'y' }], providers: { a, b } });
  await assert.rejects(r.generate({ messages: msgs, signal: ac.signal }), /cancelled/i);
  assert.equal(b.calls.length, 0);
});

test('plain (non-AIError) exceptions are treated as failures, not crashes', async () => {
  const a = fakeProvider('a', () => {
    throw new TypeError('boom');
  });
  const b = fakeProvider('b', () => 'b');
  const r = createLLMRouter({ chain: [{ provider: 'a', model: 'x' }, { provider: 'b', model: 'y' }], providers: { a, b } });
  assert.equal((await r.generate({ messages: msgs })).text, 'b');
});

test('parseChain handles models containing ":" and "/"', () => {
  assert.deepEqual(parseChain('openrouter:google/gemma-4-31b-it:free, gemini:gemini-3.6-flash'), [
    { provider: 'openrouter', model: 'google/gemma-4-31b-it:free' },
    { provider: 'gemini', model: 'gemini-3.6-flash' },
  ]);
  assert.throws(() => parseChain('gemini'), /provider:model/);
});

test('simulateOutage makes the named providers fail with 503', async () => {
  const p = simulateOutage({ a: fakeProvider('a', () => 'x'), b: fakeProvider('b', () => 'y') }, ['a']);
  await assert.rejects(p.a.complete({ model: 'm' }), (e) => e.kind === 'overloaded' && e.status === 503);
  assert.equal((await p.b.complete({ model: 'm' })).text, 'y');
});

test('createRouterFromEnv emits events', async () => {
  const events = [];
  const providers = { gemini: fakeProvider('gemini', () => 'ok') };
  const r = createRouterFromEnv({ AI_CHAIN: 'gemini:x' }, { providers, onEvent: (e) => events.push(e.type) });
  await r.generate({ messages: msgs });
  assert.deepEqual(events, ['attempt', 'success']);
});

const delay = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

test('hedging: a slow model is raced by the next one and the faster answer wins', async () => {
  const events = [];
  const a = fakeProvider('a', () => delay(300, 'slow a'));
  const b = fakeProvider('b', () => delay(20, 'fast b'));
  const r = createLLMRouter({ chain: [{ provider: 'a', model: 'x' }, { provider: 'b', model: 'y' }], providers: { a, b }, hedgeAfterMs: 50, onEvent: (e) => events.push(e.type) });
  const started = Date.now();
  const out = await r.generate({ messages: msgs });
  assert.equal(out.text, 'fast b');
  assert.ok(Date.now() - started < 250, 'did not wait for the slow model');
  assert.ok(events.includes('hedge'));
  assert.equal(a.calls[0].signal.aborted, true, 'the slow request is cancelled');
  await delay(320);
  const s = r.status()[0];
  assert.equal(s.failures, 0, 'losing a race is not a failure');
  assert.equal(s.state, 'cooling', 'but the slow model is parked briefly');
  assert.deepEqual(out.attempts.map((x) => x.target), ['b:y']);
});

test('hedging: a fast first model never triggers a second request', async () => {
  const a = fakeProvider('a', () => delay(10, 'a'));
  const b = fakeProvider('b', () => 'b');
  const r = createLLMRouter({ chain: [{ provider: 'a', model: 'x' }, { provider: 'b', model: 'y' }], providers: { a, b }, hedgeAfterMs: 100 });
  assert.equal((await r.generate({ messages: msgs })).text, 'a');
  assert.equal(b.calls.length, 0);
});

test('hedging: if the hedged model fails, the original slow one can still win', async () => {
  const a = fakeProvider('a', () => delay(120, 'slow a'));
  const b = fakeProvider('b', () => fail('overloaded'));
  const c = fakeProvider('c', () => delay(500, 'c'));
  const r = createLLMRouter({ chain: [{ provider: 'a', model: 'x' }, { provider: 'b', model: 'y' }, { provider: 'c', model: 'z' }], providers: { a, b, c }, hedgeAfterMs: 30 });
  const out = await r.generate({ messages: msgs });
  assert.equal(out.text, 'slow a');
  assert.equal(r.status()[1].lastErrorKind, 'overloaded');
});
