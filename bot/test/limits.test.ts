import { describe, expect, it } from 'vitest';
import { applyLimits, saveLimits, storedLimits } from '../src/limits';
import type { Env, Settings } from '../src/config';

function env(mode: string, stored?: unknown) {
  const kv = new Map<string, string>();
  if (stored !== undefined) kv.set('limits', JSON.stringify(stored));
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => (kv.has(String(args[0])) ? { value: kv.get(String(args[0])) } : null),
        run: async () => { if (/INSERT|REPLACE/i.test(sql)) kv.set(String(args[0]), String(args[1])); return {}; },
      }),
    }),
  };
  return { env: { MODE: mode, DB } as unknown as Env, kv };
}

describe('límites editables', () => {
  it('con MODE fijo no se leen ni se guardan', async () => {
    const { env: e, kv } = env('live', { maxTradeUsdc: 50 });
    expect(await storedLimits(e)).toEqual({});
    expect(await saveLimits(e, { maxTradeUsdc: 10 })).toHaveProperty('error');
    expect(JSON.parse(kv.get('limits')!)).toEqual({ maxTradeUsdc: 50 });
  });

  it('con MODE = app guarda dentro de rango y rechaza fuera de rango', async () => {
    const { env: e } = env('app');
    expect(await saveLimits(e, { maxTradeUsdc: 25, maxTradesPerDay: 4 })).toEqual({ limits: { maxTradeUsdc: 25, maxTradesPerDay: 4 } });
    expect(await storedLimits(e)).toEqual({ maxTradeUsdc: 25, maxTradesPerDay: 4 });
    const r = await saveLimits(e, { maxTradeUsdc: 100000 });
    expect('error' in r && r.error).toContain('maxTradeUsdc');
    expect(await storedLimits(e)).toEqual({ maxTradeUsdc: 25, maxTradesPerDay: 4 });
  });

  it('ignora valores guardados inválidos y no toca lo demás', async () => {
    const { env: e } = env('app', { maxTradeUsdc: -3, minProfitPct: 2, wallet: '0xmalo' });
    const limits = await storedLimits(e);
    expect(limits).toEqual({ minProfitPct: 2 });
    const s = applyLimits({ maxTradeUsdc: 2, minProfitPct: 1, wallet: '0xbueno' } as Settings, limits);
    expect(s).toMatchObject({ maxTradeUsdc: 2, minProfitPct: 2, wallet: '0xbueno' });
  });
});
