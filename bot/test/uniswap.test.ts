import { describe, expect, it } from 'vitest';
import { decodeFunctionData, parseAbi } from 'viem';
import { MARKETS } from '../src/markets';
import { uniSwapTx, UNI_ROUTER } from '../src/uniswap';

const W = '0x000000000000000000000000000000000000dead';
const ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function refundETH() payable',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
]);
const quote = (market: string, side: string, srcAmountRaw: string, destAmountRaw: string, fee = 500) => ({ amountIn: 0, amountOut: 0, srcUsd: 0, destUsd: 0, gasUsd: 0, costPct: 0, srcAmountRaw, route: { venue: 'uniswap', market, side, fee, destAmountRaw } });
const decode = (data: `0x${string}`) => {
  const { args } = decodeFunctionData({ abi: ABI, data });
  const [deadline, calls] = args as [bigint, `0x${string}`[]];
  return { deadline, calls: calls.map(c => decodeFunctionData({ abi: ABI, data: c })) };
};
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const WPOL = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';

describe('Uniswap V3: transacción construida localmente', () => {
  it('vender POL: envía el POL como value, cobra USDC en la wallet con mínimo y fecha límite', () => {
    const tx = uniSwapTx(MARKETS.POL, 'SELL', quote('POL', 'SELL', '20000000000000000000', '2033000'), W, 50, 1_000);
    expect(tx).toMatchObject({ to: UNI_ROUTER, value: 20n * 10n ** 18n, approve: null });
    const d = decode(tx.data);
    expect(d.deadline).toBe(1_600n);
    expect(d.calls.map(c => c.functionName)).toEqual(['exactInputSingle', 'refundETH']);
    expect((d.calls[0].args as any)[0]).toMatchObject({ tokenIn: WPOL, tokenOut: USDC, fee: 500, amountIn: 20n * 10n ** 18n, amountOutMinimum: 2022835n });
    expect((d.calls[0].args as any)[0].recipient.toLowerCase()).toBe(W);
  });

  it('comprar POL: aprueba solo lo que gasta, recibe en el router y lo desenvuelve a la wallet con el mismo mínimo', () => {
    const tx = uniSwapTx(MARKETS.POL, 'BUY', quote('POL', 'BUY', '2000000', '19668000000000000000'), W, 50, 1_000);
    expect(tx.value).toBe(0n);
    expect(tx.approve).toEqual({ token: USDC, amount: 2_000_000n });
    const d = decode(tx.data);
    expect(d.calls.map(c => c.functionName)).toEqual(['exactInputSingle', 'unwrapWETH9']);
    const min = (19668000000000000000n * 9950n) / 10000n;
    expect((d.calls[0].args as any)[0]).toMatchObject({ tokenIn: USDC, tokenOut: WPOL, recipient: '0x0000000000000000000000000000000000000002', amountOutMinimum: min });
    expect((d.calls[1].args as any)[0]).toBe(min);
    expect((d.calls[1].args as any)[1].toLowerCase()).toBe(W);
  });

  it('tokens ERC-20: sin value, aprobando el token que se entrega y usando la comisión de su pool', () => {
    const sell = uniSwapTx(MARKETS.LINK, 'SELL', quote('LINK', 'SELL', '155000000000000000', '2025000', 3000), W, 50, 1_000);
    expect(sell.value).toBe(0n);
    expect(sell.approve).toEqual({ token: MARKETS.LINK.address, amount: 155000000000000000n });
    expect((decode(sell.data).calls[0].args as any)[0]).toMatchObject({ tokenIn: MARKETS.LINK.address, tokenOut: USDC, fee: 3000 });
    const buy = uniSwapTx(MARKETS.WBTC, 'BUY', quote('WBTC', 'BUY', '2000000', '2400'), W, 50, 1_000);
    expect(buy.approve).toEqual({ token: USDC, amount: 2_000_000n });
    expect(decode(buy.data).calls.map(c => c.functionName)).toEqual(['exactInputSingle']);
  });

  it('rechaza cotizaciones de otro mercado, lado, exchange o pool, y mínimos en cero', () => {
    const ok = quote('POL', 'SELL', '1000000000000000000', '101000');
    expect(() => uniSwapTx(MARKETS.WETH, 'SELL', ok, W, 50, 1)).toThrow();
    expect(() => uniSwapTx(MARKETS.POL, 'BUY', ok, W, 50, 1)).toThrow();
    expect(() => uniSwapTx(MARKETS.POL, 'SELL', { ...ok, route: { ...ok.route, venue: 'hub' } }, W, 50, 1)).toThrow();
    expect(() => uniSwapTx(MARKETS.POL, 'SELL', { ...ok, route: { ...ok.route, fee: 3000 } }, W, 50, 1)).toThrow();
    expect(() => uniSwapTx(MARKETS.POL, 'SELL', quote('POL', 'SELL', '1000000000000000000', '0'), W, 50, 1)).toThrow();
    expect(() => uniSwapTx(MARKETS.DOT, 'SELL', ok, W, 50, 1)).toThrow();
  });
});
