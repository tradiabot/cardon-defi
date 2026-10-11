import { describe, expect, it } from 'vitest';
import { compact, hubAccount, quoteMessage, swapMessage } from '../src/hub';
import { marketSettings, MARKETS } from '../src/markets';
import { gasShort } from '../src/venues';

const W = '0x000000000000000000000000000000000000dead';
const hex = (b: number[]) => b.map(x => x.toString(16).padStart(2, '0')).join('');

describe('Polkadot Hub: codificación', () => {
  it('enteros compactos SCALE', () => {
    expect(hex(compact(1n))).toBe('04');
    expect(hex(compact(1337n))).toBe('e514');
    expect(hex(compact(1_000_000n))).toBe('02093d00');
    expect(hex(compact(10n ** 10n))).toBe('0700e40b5402');
  });

  it('cuenta de una dirección 0x: dirección + 12 bytes EE', () => {
    expect(hex(hubAccount(W))).toBe('000000000000000000000000000000000000dead' + 'ee'.repeat(12));
  });

  it('el programa XCM coincide byte a byte con el que la red ejecutó en simulación con la wallet real', () => {
    expect(swapMessage(W, 'DOT', 10n ** 10n, 'USDC', 1237111n)).toBe('0x050c00040100000700e40b54020f00040100000700e40b5402040002043205e51400de814b00010d010000010100000000000000000000000000000000000000deadeeeeeeeeeeeeeeeeeeeeeeee');
    expect(swapMessage(W, 'USDC', 2_000_000n, 'DOT', 15_700_000_000n)).toBe('0x050c00040002043205e5140002127a000f00040002043205e5140002127a00040100000700fdcaa703010d010000010100000000000000000000000000000000000000deadeeeeeeeeeeeeeeeeeeeeeeee');
  });

  it('el mínimo a recibir aplica el deslizamiento; cotizaciones ajenas o vacías se rechazan', () => {
    const q = { amountIn: 1, amountOut: 1.25, srcUsd: 1.25, destUsd: 1.25, gasUsd: 0, costPct: 0, srcAmountRaw: '10000000000', route: { venue: 'hub', give: 'DOT', want: 'USDC', destAmountRaw: '1249608' } };
    // 1249608 × (1 − 0,5 %) = 1243359
    expect(quoteMessage(W, q, 50)).toBe(swapMessage(W, 'DOT', 10n ** 10n, 'USDC', 1243359n));
    expect(() => quoteMessage(W, { ...q, route: { venue: 'hydration' } }, 50)).toThrow();
    expect(() => quoteMessage(W, { ...q, route: { ...q.route, destAmountRaw: '0' } }, 50)).toThrow();
    expect(() => swapMessage(W, 'DOT', 1n, 'DOT', 1n)).toThrow();
  });

  it('DOT guarda 0,3 DOT para gas y se bloquea si queda menos de 0,05', () => {
    expect(MARKETS.DOT.venue).toBe('hub');
    expect(marketSettings({ gasReservePol: 2 } as never, MARKETS.DOT, 'live').gasReservePol).toBe(0.3);
    expect(gasShort(MARKETS.DOT, {} as never, { base: 0.04, USDC: 5, gas: 0.04 })).toBe(true);
    expect(gasShort(MARKETS.DOT, {} as never, { base: 9.7, USDC: 0, gas: 9.7 })).toBe(false);
  });
});
