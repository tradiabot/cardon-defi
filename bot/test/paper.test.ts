import { describe, expect, it } from 'vitest';
import { applyTrade, seed, unrealizedPct } from '../src/paper';
import { ema, rsi, technicalSignal, features } from '../src/indicators';
import { fromUnits } from '../src/chain';

const q = (amountIn: number, amountOut: number, gasUsd = 0) => ({ amountIn, amountOut, srcUsd: 0, destUsd: 0, gasUsd, costPct: 0 });

describe('cartera paper', () => {
  it('compra recalcula el coste medio incluyendo el gas', () => {
    const p = seed(10, 0, 0.1, 0);
    const { next } = applyTrade(p, 'BUY', q(2, 20, 0.01));
    expect(next.usdc).toBeCloseTo(7.99);
    expect(next.units).toBe(20);
    expect(next.avgCostUsd).toBeCloseTo(0.1005);
  });
  it('venta realiza P/L contra el coste medio', () => {
    const p = { ...seed(0, 20, 0.1, 0) };
    const { next, realized } = applyTrade(p, 'SELL', q(10, 1.2, 0));
    expect(realized).toBeCloseTo(0.2);
    expect(next.units).toBe(10);
    expect(next.usdc).toBeCloseTo(1.2);
    expect(next.realizedPnlUsd).toBeCloseTo(0.2);
  });
  it('rechaza operar sin saldo', () => {
    expect(() => applyTrade(seed(1, 0, 0.1, 0), 'BUY', q(2, 20))).toThrow();
    expect(() => applyTrade(seed(0, 1, 0.1, 0), 'SELL', q(2, 0.2))).toThrow();
  });
  it('P/L abierto', () => {
    expect(unrealizedPct(seed(0, 10, 0.1, 0), 0.11)).toBeCloseTo(10);
    expect(unrealizedPct(seed(5, 0, 0.1, 0), 0.11)).toBeNull();
  });
});

describe('unidades del bot', () => {
  const f = (amountIn: number, amountOut: number) => ({ amountIn, amountOut, gasUsd: 0 });
  it('las compras del bot se registran con su propio coste medio', () => {
    const { next } = applyTrade(seed(10, 50, 0.1, 0), 'BUY', f(2, 25));
    expect(next.botUnits).toBe(25);
    expect(next.botAvgCostUsd).toBeCloseTo(0.08);
  });
  it('una venta por IA consume primero las tenencias previas', () => {
    const p = applyTrade(seed(10, 50, 0.1, 0), 'BUY', f(2, 25)).next;
    expect(applyTrade(p, 'SELL', f(40, 4)).next.botUnits).toBe(25);
    expect(applyTrade(p, 'SELL', f(60, 6)).next.botUnits).toBe(15);
  });
  it('una venta por stop-loss consume las unidades del bot', () => {
    const p = applyTrade(seed(10, 50, 0.1, 0), 'BUY', f(2, 25)).next;
    const next = applyTrade(p, 'SELL', f(25, 1.9), true).next;
    expect(next.botUnits).toBe(0);
    expect(next.botAvgCostUsd).toBe(0);
    expect(next.units).toBe(50);
  });
  it('carteras antiguas sin campos del bot funcionan', () => {
    const legacy = { usdc: 1, units: 10, avgCostUsd: 0.1, realizedPnlUsd: 0, seededAt: 0, seedValueUsd: 2 };
    expect(applyTrade(legacy, 'SELL', f(5, 0.5)).next.botUnits).toBe(0);
  });
});

describe('indicadores', () => {
  it('EMA de serie constante es la constante', () => {
    expect(ema(Array(60).fill(2), 12)).toBeCloseTo(2);
    expect(ema([1, 2], 12)).toBeNull();
  });
  it('RSI en tendencia alcista es 100 y bajista 0', () => {
    expect(rsi(Array.from({ length: 30 }, (_, i) => i + 1))).toBe(100);
    expect(rsi(Array.from({ length: 30 }, (_, i) => 30 - i))).toBe(0);
  });
  it('sin suficientes muestras la señal es HOLD', () => {
    expect(technicalSignal(features([1, 2, 3], 0))).toBe('HOLD');
  });
  it('tendencia alcista moderada da BUY', () => {
    const up = Array.from({ length: 80 }, (_, i) => 1 + i * 0.001 + (i % 2 ? 0.002 : -0.002));
    expect(technicalSignal(features(up, 1))).toBe('BUY');
  });
});

describe('unidades on-chain', () => {
  it('convierte wei y unidades de 6 decimales', () => {
    expect(fromUnits('0x2fb0032b416fa0000', 18)).toBeCloseTo(54.98, 2);
    expect(fromUnits('0xcf850', 6)).toBeCloseTo(0.85, 6);
    expect(fromUnits('0x', 6)).toBe(0);
  });
});
