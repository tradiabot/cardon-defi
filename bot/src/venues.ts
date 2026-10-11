import type { Hex } from 'viem';
import type { Settings } from './config';
import { readBalances, readTokenBalances } from './chain';
import type { DexQuote } from './dex';
import { uniPrice, uniQuote, uniSubmit } from './uniswap';
import { HUB_MIN_GAS_DOT, hubBalances, hubPrice, hubQuote, hubSettlement, hubSubmit } from './hub';
import { hydraBalances, hydraGasTokenUsd, hydraPrice, hydraQuote, hydraSettlement, hydraSubmit } from './hydration';
import { settlement } from './live';
import { fetchPrices, type Quote } from './market';
import type { Market } from './markets';

/** Saldos de un mercado: su moneda, USDC y lo disponible para pagar comisiones de red. `POL` se mantiene por el panel antiguo. */
export interface Balances {
  base: number;
  USDC: number;
  gas: number;
  POL?: number;
}

export const baseOf = (b: { base?: number; POL?: number } | null | undefined): number => b?.base ?? b?.POL ?? 0;

type Side = 'BUY' | 'SELL';

export async function venuePrices(m: Market, s: Settings, trackDot: boolean): Promise<{ prices: Record<string, Quote>; warnings: string[] }> {
  if (m.id === 'POL') {
    const r = await fetchPrices(m, s.rpcs);
    if (!trackDot) delete r.prices.DOT;
    return r;
  }
  if (m.venue === 'hub') return { prices: { [m.id]: { usd: await hubPrice(m.probe), change24h: null, source: 'polkadot-hub' } }, warnings: [] };
  if (m.venue === 'hydration') return { prices: { [m.id]: { usd: await hydraPrice(m, s.wallet), change24h: null, source: 'hydration' } }, warnings: [] };
  return { prices: { [m.id]: { usd: await uniPrice(m, s.rpcs), change24h: null, source: 'uniswap' } }, warnings: [] };
}

export async function venueBalances(m: Market, s: Settings): Promise<Balances> {
  if (m.venue === 'hub') return hubBalances(s.wallet);
  if (m.venue === 'hydration') return hydraBalances(m, s.wallet);
  if (m.native) {
    const b = await readBalances(s.rpcs, s.wallet);
    return { base: b.POL, USDC: b.USDC, gas: b.POL, POL: b.POL };
  }
  return readTokenBalances(s.rpcs, s.wallet, m.address as string, m.decimals);
}

export function venueQuote(m: Market, side: Side, amountIn: number, s: Settings, refPrice: number): Promise<DexQuote> {
  if (m.venue === 'hub') return hubQuote(side, amountIn, refPrice);
  return m.venue === 'hydration' ? hydraQuote(m, side, amountIn, s.wallet, refPrice) : uniQuote(m, side, amountIn, s.rpcs, refPrice);
}

export async function venueSubmit(m: Market, s: Settings, privateKey: string | undefined, side: Side, q: DexQuote): Promise<{ hash: Hex; approveHash: Hex | null }> {
  if (m.venue === 'hub') return { hash: await hubSubmit(s.wallet, privateKey, q, s.slippageBps), approveHash: null };
  if (m.venue !== 'hydration') return uniSubmit(m, s, privateKey, side, q);
  return { hash: await hydraSubmit(s.wallet, privateKey, q, s.slippageBps), approveHash: null };
}

/** Estado de la operación y su comisión de red en USD. `nativeUsd`: precio de POL si ya se conoce. */
export async function venueSettlement(m: Market, s: Settings, hash: Hex, approveHash: Hex | null, polUsd: () => Promise<number>): Promise<{ status: 'PENDIENTE' | 'CONFIRMADA' | 'FALLIDA'; gasUsd: number }> {
  if (m.venue === 'hub') {
    const r = await hubSettlement(hash);
    // El gas se paga en DOT, la moneda del propio mercado.
    return { status: r.status, gasUsd: r.gasNative ? r.gasNative * (await polUsd()) : 0 };
  }
  if (m.venue === 'hydration') {
    const r = await hydraSettlement(hash);
    if (r.status === 'PENDIENTE' || !r.gasNative) return { status: r.status, gasUsd: 0 };
    return { status: r.status, gasUsd: r.gasNative * (await hydraGasTokenUsd(s.wallet)) };
  }
  const r = await settlement(s, hash, approveHash);
  return { status: r.status, gasUsd: r.gasPol ? r.gasPol * (await polUsd()) : 0 };
}

/** Lo mínimo para pagar comisiones: en Polygon POL; en Hydration se cobra de la moneda de comisiones (USDC de referencia). */
export function gasShort(m: Market, s: Settings, b: Balances): boolean {
  if (m.venue === 'hub') return b.gas < HUB_MIN_GAS_DOT;
  if (m.venue === 'hydration') return b.gas + b.base <= 0;
  return b.gas < (m.native ? s.gasReservePol / 4 : MIN_GAS_POL);
}

export const MIN_GAS_POL = 0.2;
