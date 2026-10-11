import { describe, expect, it } from 'vitest';
import { nextTick, TICK_MS } from '../src/scheduler';

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
