import { TOKENS, type Env, type Settings } from './config';
import { getKv, putKv } from './db';

/**
 * Mercados que el bot puede operar, siempre contra USDC y siempre en un DEX con la wallet propia:
 * - polygon: Uniswap V3 directo por RPC (pool token/USDC de la comisión `fee`), sin APIs de terceros;
 * - hub: Polkadot Hub, pool nativo DOT/USDC; la misma dirección 0x opera allí vía el precompile de XCM;
 * - hydration: el DEX de Polkadot; la misma dirección 0x firma allí (chainId 222222).
 * `verified`: la firma con dinero real ya se comprobó contra la red con la wallet real.
 * POL conserva las claves de D1 de siempre; los demás mercados usan «clave:ID».
 */
export type Venue = 'polygon' | 'hub' | 'hydration';

export interface Market {
  id: string;
  name: string;
  venue: Venue;
  decimals: number;
  /** Unidades que se cotizan para medir el precio (unos pocos USD). */
  probe: number;
  /** Polygon: contrato del token; `native` = es la moneda con la que se paga el gas. */
  address?: `0x${string}`;
  native?: boolean;
  /** Polygon: comisión del pool de Uniswap V3 contra USDC (500 = 0,05 %). */
  fee?: number;
  /** Unidades de la propia moneda que se guardan para gas cuando es nativa (por defecto GAS_RESERVE_POL). */
  gasReserve?: number;
  /** Hydration: id del activo en la cadena. */
  assetId?: number;
}

export const VENUES: Record<Venue, { name: string; explorer: string; usdcDecimals: number }> = {
  polygon: { name: 'Polygon', explorer: 'https://polygonscan.com/tx/', usdcDecimals: 6 },
  hub: { name: 'Polkadot Hub', explorer: 'https://assethub-polkadot.subscan.io/tx/', usdcDecimals: 6 },
  hydration: { name: 'Polkadot · Hydration', explorer: 'https://hydration.subscan.io/tx/', usdcDecimals: 6 },
};

export const MARKETS: Record<string, Market> = {
  POL: { id: 'POL', name: 'Polygon', venue: 'polygon', decimals: 18, probe: 10, address: TOKENS.POL.address, native: true, fee: 500 },
  WETH: { id: 'WETH', name: 'Ethereum', venue: 'polygon', decimals: 18, probe: 0.002, address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', fee: 500 },
  WBTC: { id: 'WBTC', name: 'Bitcoin', venue: 'polygon', decimals: 8, probe: 0.0001, address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', fee: 500 },
  LINK: { id: 'LINK', name: 'Chainlink', venue: 'polygon', decimals: 18, probe: 1, address: '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39', fee: 3000 },
  AAVE: { id: 'AAVE', name: 'Aave', venue: 'polygon', decimals: 18, probe: 0.05, address: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B', fee: 3000 },
  DOT: { id: 'DOT', name: 'Polkadot', venue: 'hub', decimals: 10, probe: 5, native: true, gasReserve: 0.3 },
  HDX: { id: 'HDX', name: 'Hydration', venue: 'hydration', decimals: 12, probe: 1000, assetId: 0 },
};

export const DEFAULT_MARKET = 'POL';
export const MAX_ENABLED = 4;

export const market = (id: string | null | undefined): Market | null => MARKETS[String(id ?? DEFAULT_MARKET).toUpperCase()] ?? null;

/** Clave de D1 de un mercado: POL usa las de siempre para no perder su historial. */
export const kvKey = (m: Market, name: string) => (m.id === DEFAULT_MARKET ? name : `${name}:${m.id}`);

export type MarketMode = 'paper' | 'live';
export type MarketConfig = Record<string, { enabled: boolean; mode: MarketMode }>;

/** Configuración guardada. POL sigue a MODE de wrangler.toml (salvo MODE = "app"); los demás empiezan apagados y en simulación. */
export async function marketConfig(env: Env): Promise<MarketConfig> {
  const stored = (await getKv<MarketConfig>(env.DB, 'markets')) ?? {};
  const out: MarketConfig = {};
  for (const id of Object.keys(MARKETS)) {
    const fixed = id === DEFAULT_MARKET && env.MODE !== 'app';
    const mode: MarketMode = fixed ? (env.MODE === 'live' ? 'live' : 'paper') : stored[id]?.mode === 'live' ? 'live' : 'paper';
    out[id] = { enabled: stored[id]?.enabled ?? id === DEFAULT_MARKET, mode };
  }
  return out;
}

export async function enabledMarkets(env: Env): Promise<Market[]> {
  const cfg = await marketConfig(env);
  return Object.values(MARKETS).filter(m => cfg[m.id].enabled);
}

export async function updateMarket(env: Env, body: { market?: unknown; enabled?: unknown; mode?: unknown }, now = Date.now()): Promise<{ error: string } | { ok: true }> {
  const m = market(String(body.market ?? ''));
  if (!m || !body.market) return { error: 'Mercado desconocido' };
  const cfg = await marketConfig(env);
  const next = { ...cfg[m.id] };
  if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);
  if (body.mode !== undefined) {
    if (body.mode !== 'paper' && body.mode !== 'live') return { error: 'mode debe ser paper o live' };
    if (m.id === DEFAULT_MARKET && env.MODE !== 'app') return { error: 'El modo de POL se cambia en wrangler.toml (MODE)' };
    if (body.mode === 'live' && !env.WALLET_PRIVATE_KEY) return { error: 'Falta la clave de firma en tu nube: súbela desde la app antes de pasar a dinero real' };
    next.mode = body.mode;
  }
  const modeChanged = next.mode !== cfg[m.id].mode;
  if (next.enabled && !cfg[m.id].enabled && Object.values(cfg).filter(c => c.enabled).length >= MAX_ENABLED) return { error: `Máximo ${MAX_ENABLED} mercados activos a la vez (cada uno consulta a las IAs)` };
  cfg[m.id] = next;
  await env.DB.batch([
    putKv(env.DB, 'markets', cfg, now),
    // Las órdenes de simulación no deben ejecutarse con dinero real (ni al revés): el plan se rehace en el modo nuevo.
    ...(modeChanged ? [env.DB.prepare("UPDATE orders SET status = 'CANCELADA', note = 'Cancelada al cambiar entre simulación y dinero real', updated_ts = ? WHERE symbol = ? AND status = 'ACTIVA'").bind(now, m.id)] : []),
    ...(modeChanged ? [env.DB.prepare('DELETE FROM kv WHERE key = ?').bind(kvKey(m, 'ai_last'))] : []),
  ]);
  return { ok: true };
}

/** Ajustes del ciclo de un mercado: su modo propio y sin reserva de gas si su moneda no paga el gas. */
export function marketSettings(s: Settings, m: Market, mode: MarketMode): Settings {
  return { ...s, mode, gasReservePol: m.native ? m.gasReserve ?? s.gasReservePol : 0 };
}
