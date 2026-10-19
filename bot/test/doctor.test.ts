import { describe, expect, it } from 'vitest';
import { classify, FIXES } from '../src/doctor';
import { MARKETS } from '../src/markets';
import type { CycleStatus } from '../src/engine';

const NOW = 1_800_000_000_000;
function cycle(over: Partial<CycleStatus> = {}): CycleStatus {
  return {
    ts: NOW - 60_000, mode: 'live', ok: true, durationMs: 1, errors: [], warnings: [], prices: { POL: { usd: 0.1, change24h: null, source: 'uniswap' } },
    features: null, onchain: { base: 50, USDC: 5, gas: 50, ts: NOW }, onchainLast: null, decision: null, trade: null, settled: null, orders: null, ...over,
  };
}

describe('médico: clasificación de errores', () => {
  it('sin problemas: nada', () => {
    expect(classify(MARKETS.POL, cycle(), true, NOW)).toEqual([]);
  });

  it('errores de red, IA, DEX y ciclo atrasado', () => {
    const f = classify(MARKETS.POL, cycle({ ts: NOW - 20 * 60_000, errors: ['precios: RPC timeout', 'IA: todas fallaron', 'envío (build): STF', 'on-chain: 503'] }), true, NOW);
    expect(f.map(x => x.code)).toEqual(['atrasado', 'precio', 'ia', 'dex', 'onchain']);
    expect(f.find(x => x.code === 'ia')!.fixes).toEqual(['ia_todos']);
    expect(f.find(x => x.code === 'precio')!.detail).toContain('RPC timeout');
    expect(f.find(x => x.code === 'dex')!.fixes).toEqual(['simulacion']);
  });

  it('dinero real sin gas o sin fondos propone simulación; en simulación no', () => {
    const noGas = cycle({ decision: { technical: 'HOLD', ai: null, final: 'HOLD', blockedBy: 'SIN_GAS', trigger: null, orderId: null }, prices: { HDX: { usd: 0.0075, change24h: null, source: 'hydration' } }, onchain: { base: 0, USDC: 0, gas: 0, ts: NOW } });
    const live = classify(MARKETS.HDX, noGas, true, NOW);
    expect(live.map(x => x.code)).toEqual(['gas', 'sin_fondos']);
    expect(live[0].detail).toContain('HDX');
    expect(live.every(x => x.fixes.includes('simulacion'))).toBe(true);
    expect(classify(MARKETS.HDX, noGas, false, NOW)).toEqual([]);
  });

  it('sin precio bloqueado y sin ciclos', () => {
    expect(classify(MARKETS.DOT, cycle({ decision: { technical: 'HOLD', ai: null, final: 'HOLD', blockedBy: 'SIN_PRECIO', trigger: null, orderId: null } }), true, NOW)[0].code).toBe('precio');
    expect(classify(MARKETS.DOT, null, true, NOW)[0].code).toBe('sin_ciclos');
  });

  it('no repite el mismo código y solo usa arreglos de la lista', () => {
    const f = classify(MARKETS.POL, cycle({ errors: ['precios: a', 'precios: b'], decision: { technical: 'HOLD', ai: null, final: 'HOLD', blockedBy: 'SIN_PRECIO', trigger: null, orderId: null } }), true, NOW);
    expect(f.filter(x => x.code === 'precio')).toHaveLength(1);
    expect(f.flatMap(x => x.fixes).every(id => id in FIXES)).toBe(true);
    expect(Object.entries(FIXES).filter(([, v]) => v.safe).map(([k]) => k)).toEqual(['ciclo', 'ia_todos']);
  });
});
