import { describe, expect, it } from 'vitest';
import { nextTick, pool, SUB_CYCLE_CONCURRENCY, TICK_MS } from '../src/scheduler';
import { MARKETS, MAX_ENABLED } from '../src/markets';

describe('reloj de ciclos', () => {
  const base = Date.UTC(2026, 9, 10, 18, 0, 0);
  it('siguiente ciclo: 20 s después del próximo múltiplo de 5 min', () => {
    expect(nextTick(base + 1_000) - base).toBe(TICK_MS + 20_000);
    expect(nextTick(base + 4 * 60_000) - base).toBe(TICK_MS + 20_000);
    expect(nextTick(base + TICK_MS + 21_000) - base).toBe(2 * TICK_MS + 20_000);
  });
  it('nunca programa a menos de 30 s (ni en el pasado)', () => {
    expect(nextTick(base - 5_000) - base).toBe(TICK_MS + 20_000);
    expect(nextTick(base - 60_000) - base).toBe(20_000);
    for (let i = 0; i < 600; i += 7) expect(nextTick(base + i * 1000) - (base + i * 1000)).toBeGreaterThanOrEqual(30_000);
  });
});

describe('reparto de subciclos', () => {
  it('todos los mercados se pueden activar a la vez', () => {
    expect(MAX_ENABLED).toBe(Object.keys(MARKETS).length);
  });
  it('corre cada mercado una vez, sin pasar del máximo simultáneo (6 conexiones del Worker gratuito)', async () => {
    let open = 0, peak = 0;
    const done: string[] = [];
    await pool(['WETH', 'WBTC', 'LINK', 'AAVE', 'DOT', 'HDX'], SUB_CYCLE_CONCURRENCY, async id => {
      open++; peak = Math.max(peak, open);
      await new Promise(r => setTimeout(r, 5));
      done.push(id); open--;
    });
    expect(done.sort()).toEqual(['AAVE', 'DOT', 'HDX', 'LINK', 'WBTC', 'WETH']);
    expect(peak).toBe(SUB_CYCLE_CONCURRENCY);
    expect(SUB_CYCLE_CONCURRENCY + 1).toBeLessThan(6);
  });
});
