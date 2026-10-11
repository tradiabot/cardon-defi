import { COINGECKO_IDS } from './config';
import { uniPrice } from './uniswap';
import type { Market } from './markets';
import { quickswapPolPrice } from './chain';

export interface Quote {
  usd: number;
  change24h: number | null;
  source: 'uniswap' | 'paraswap' | 'quickswap' | 'coingecko' | 'hydration' | 'polkadot-hub';
}

async function coingecko(): Promise<Record<string, { usd: number; change24h: number | null }>> {
  const ids = Object.values(COINGECKO_IDS).join(',');
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`, {
    headers: { accept: 'application/json', 'user-agent': 'dex-pilot/1.0' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data = await res.json<Record<string, { usd?: number; usd_24h_change?: number }>>();
  const out: Record<string, { usd: number; change24h: number | null }> = {};
  for (const [symbol, id] of Object.entries(COINGECKO_IDS)) {
    const row = data[id];
    if (typeof row?.usd === 'number' && row.usd > 0) out[symbol] = { usd: row.usd, change24h: row.usd_24h_change ?? null };
  }
  return out;
}

/**
 * Precio de POL: Uniswap V3 por RPC (el mismo pool donde se opera); si falla, QuickSwap y luego CoinGecko.
 * CoinGecko solo aporta el cambio de 24 h y el precio de referencia de DOT cuando ese mercado está apagado.
 */
export async function fetchPrices(pol: Market, rpcs: string[]): Promise<{ prices: Record<string, Quote>; warnings: string[] }> {
  const [dex, cg] = await Promise.allSettled([uniPrice(pol, rpcs), coingecko()]);
  const warnings: string[] = [];
  const gecko = cg.status === 'fulfilled' ? cg.value : {};
  if (cg.status === 'rejected') warnings.push(`CoinGecko: ${(cg.reason as Error).message}`);

  const prices: Record<string, Quote> = {};
  if (dex.status === 'fulfilled' && dex.value > 0) {
    prices.POL = { usd: dex.value, change24h: gecko.POL?.change24h ?? null, source: 'uniswap' };
  } else {
    if (dex.status === 'rejected') warnings.push(`Uniswap precio: ${(dex.reason as Error).message}`);
    try {
      prices.POL = { usd: await quickswapPolPrice(rpcs), change24h: gecko.POL?.change24h ?? null, source: 'quickswap' };
    } catch (error) {
      warnings.push(`QuickSwap precio: ${(error as Error).message}`);
      if (gecko.POL) prices.POL = { ...gecko.POL, source: 'coingecko' };
    }
  }
  if (!prices.POL) throw new Error(`sin precio de POL (${warnings.join(' | ')})`);
  if (gecko.DOT) prices.DOT = { ...gecko.DOT, source: 'coingecko' };
  return { prices, warnings };
}
