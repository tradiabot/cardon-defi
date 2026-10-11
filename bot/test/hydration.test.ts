import { describe, expect, it } from 'vitest';
import { account32, assetContract, executedAmount, sellCall, swapData } from '../src/hydration';
import { kvKey, market, marketSettings, MARKETS } from '../src/markets';
import { validateSwapTx } from '../src/dex';
import { gasShort } from '../src/venues';

const hex = (b: number[]) => b.map(x => x.toString(16).padStart(2, '0')).join('');

describe('Hydration: codificación', () => {
  it('cuenta de una dirección 0x: ETH\\0 + dirección + 8 ceros', () => {
    expect(hex(account32('0x000000000000000000000000000000000000dead'))).toBe('45544800000000000000000000000000000000000000dead0000000000000000');
    expect(() => account32('0x12')).toThrow();
  });

  it('Router.sell coincide con la llamada que la cadena aceptó en la prueba manual', () => {
    // 1 DOT → USDC, mínimo 0, ruta vacía = 2 + 4 + 4 + 16 + 16 + 1 bytes
    expect(hex(sellCall(5, 22, 10n ** 10n, 0n))).toBe('4300050000001600000000e40b540200000000000000000000000000000000000000000000000000000000');
  });

  it('contrato ERC-20 de un activo', () => {
    expect(assetContract(5)).toBe('0x0000000000000000000000000000000100000005');
    expect(assetContract(22)).toBe('0x0000000000000000000000000000000100000016');
  });

  it('lee lo recibido del evento Router.Executed y rechaza resultados sin swap', () => {
    const event = '0500000016000000' + '00e40b54020000000000000000000000' + 'af4a1300000000000000000000000000';
    expect(executedAmount('0x00aa' + event + 'ff', 5, 22, 10n ** 10n)).toBe(1264303n);
    expect(executedAmount('0x000100000700000000', 5, 22, 10n ** 10n)).toBeNull();
  });

  it('el mínimo a recibir aplica el deslizamiento y nunca queda en cero', () => {
    const q = { amountIn: 1, amountOut: 1.26, srcUsd: 1.26, destUsd: 1.26, gasUsd: 0, costPct: 0, srcAmountRaw: '10000000000', route: { venue: 'hydration', assetIn: 5, assetOut: 22, destAmountRaw: '1264303' } };
    // 1264303 × (1 − 0,5 %) = 1257981
    expect(swapData(q, 50)).toBe('0x' + hex(sellCall(5, 22, 10n ** 10n, 1257981n)));
    expect(() => swapData({ ...q, route: { venue: 'paraswap' } }, 50)).toThrow();
    expect(() => swapData({ ...q, route: { ...q.route, destAmountRaw: '0' } }, 50)).toThrow();
  });
});

describe('mercados', () => {
  it('POL conserva las claves de siempre; los demás llevan su id', () => {
    expect(kvKey(MARKETS.POL, 'status')).toBe('status');
    expect(kvKey(MARKETS.DOT, 'status')).toBe('status:DOT');
    expect(market(null)?.id).toBe('POL');
    expect(market('dot')?.id).toBe('DOT');
    expect(market('NOPE')).toBeNull();
  });

  it('solo POL guarda reserva de gas en su propia moneda', () => {
    const s = { mode: 'live', gasReservePol: 2 } as never;
    expect(marketSettings(s, MARKETS.POL, 'live').gasReservePol).toBe(2);
    expect(marketSettings(s, MARKETS.WETH, 'paper')).toMatchObject({ gasReservePol: 0, mode: 'paper' });
  });

  it('falta de gas: POL nativo usa su reserva; los tokens necesitan algo de POL', () => {
    const s = { gasReservePol: 2 } as never;
    expect(gasShort(MARKETS.POL, s, { base: 0.4, USDC: 5, gas: 0.4 })).toBe(true);
    expect(gasShort(MARKETS.POL, s, { base: 1, USDC: 5, gas: 1 })).toBe(false);
    expect(gasShort(MARKETS.WETH, s, { base: 0.01, USDC: 5, gas: 0.1 })).toBe(true);
    expect(gasShort(MARKETS.WETH, s, { base: 0.01, USDC: 5, gas: 1 })).toBe(false);
  });

  it('vender un token ERC-20 no envía value; vender POL sí', () => {
    const wallet = '0x000000000000000000000000000000000000dead';
    const q = { srcAmountRaw: '1000' } as never;
    const tx = { to: '0x6a000f20005980200259b80c5102003040001068', from: wallet, chainId: 137, data: '0xabcd' };
    expect(validateSwapTx('SELL', { ...tx, value: '0' }, q, wallet, MARKETS.WETH).value).toBe(0n);
    expect(() => validateSwapTx('SELL', { ...tx, value: '1000' }, q, wallet, MARKETS.WETH)).toThrow();
    expect(validateSwapTx('SELL', { ...tx, value: '1000' }, q, wallet, MARKETS.POL).value).toBe(1000n);
  });
});
