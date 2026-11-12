import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * AI result cache keyed by PDF SHA-256 + prompt version + mode. Re-running a folder after
 * adding one new invoice costs one AI call, not fifty. Writes are atomic (tmp + rename).
 */
export function createCache(dir) {
  if (!dir) return { get: async () => null, set: async () => {} };
  const file = (key) => join(dir, `${key}.json`);
  return {
    async get(key) {
      try {
        return JSON.parse(await readFile(file(key), 'utf8'));
      } catch {
        return null;
      }
    },
    async set(key, value) {
      try {
        await mkdir(dir, { recursive: true });
        const tmp = `${file(key)}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(value));
        await rename(tmp, file(key)).catch(() => writeFile(file(key), JSON.stringify(value)));
      } catch {
        /* the cache is an optimisation; never fail a run because of it */
      }
    },
  };
}
