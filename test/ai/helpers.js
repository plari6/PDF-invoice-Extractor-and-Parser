import { AIError } from '../../src/ai/errors.js';

/** A fake provider: `behaviour(model, call)` returns text or throws. Records calls. */
export function fakeProvider(name, behaviour) {
  const calls = [];
  return {
    name,
    configured: true,
    calls,
    async complete(req) {
      calls.push(req);
      return { text: await behaviour(req.model, req, calls.length) };
    },
  };
}

export const fail = (kind, extra = {}) => {
  throw new AIError(`${kind}`, { kind, ...extra });
};

export function fakeClock(start = Date.UTC(2026, 10, 4, 12)) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

/** JSON Response-like object for fetch stubs. */
export function jsonResponse(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}
