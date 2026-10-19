export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** El propio Worker: cada mercado extra corre su ciclo en una invocación aparte (límite de subpeticiones). */
  SELF?: Fetcher;
  /** Reloj propio (Durable Object con alarma) que marca los ciclos; el cron queda de respaldo. */
  CLOCK?: DurableObjectNamespace;
  GROQ_API_KEY?: string;
  ADMIN_TOKEN?: string;
  WALLET_PRIVATE_KEY?: string;
  NTFY_TOPIC?: string;
  MODE: string;
  LIMITS_EDITABLE?: string;
  GAS_RESERVE_POL: string;
  SLIPPAGE_BPS: string;
  WALLET_ADDRESS: string;
  POLYGON_RPC: string;
  GROQ_MODELS: string;
  MAX_TRADE_USDC: string;
  MAX_TRADES_PER_DAY: string;
  MIN_CONFIDENCE: string;
  MIN_RESERVE_USDC: string;
  MIN_PROFIT_PCT: string;
  STOP_LOSS_PCT: string;
  COOLDOWN_MINUTES: string;
  AI_EVERY_MINUTES?: string;
  MAX_COST_PCT: string;
  PANEL_URL: string;
}

export interface Settings {
  mode: 'paper' | 'live';
  gasReservePol: number;
  slippageBps: number;
  wallet: string;
  rpcs: string[];
  models: string[];
  maxTradeUsdc: number;
  maxTradesPerDay: number;
  minConfidence: number;
  minReserveUsdc: number;
  minProfitPct: number;
  stopLossPct: number;
  cooldownMs: number;
  aiEveryMs: number;
  maxCostPct: number;
  panelUrl: string;
}

function num(value: string | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Variable ${name} inválida: ${value}`);
  return n;
}

function list(value: string, name: string): string[] {
  const items = value.split(',').map(v => v.trim()).filter(Boolean);
  if (!items.length) throw new Error(`Variable ${name} vacía`);
  return items;
}

export function settings(env: Env): Settings {
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.WALLET_ADDRESS)) throw new Error('WALLET_ADDRESS inválida');
  // «app»: cada mercado (también POL) se pasa a dinero real desde la app; hasta entonces todo es simulación.
  if (env.MODE !== 'paper' && env.MODE !== 'live' && env.MODE !== 'app') throw new Error(`MODE inválido: ${env.MODE}`);
  const slippageBps = num(env.SLIPPAGE_BPS, 'SLIPPAGE_BPS');
  if (slippageBps < 1 || slippageBps > 300) throw new Error('SLIPPAGE_BPS fuera de rango (1-300)');
  return {
    mode: env.MODE === 'live' ? 'live' : 'paper',
    gasReservePol: num(env.GAS_RESERVE_POL, 'GAS_RESERVE_POL'),
    slippageBps,
    wallet: env.WALLET_ADDRESS,
    rpcs: list(env.POLYGON_RPC, 'POLYGON_RPC'),
    models: list(env.GROQ_MODELS, 'GROQ_MODELS'),
    maxTradeUsdc: num(env.MAX_TRADE_USDC, 'MAX_TRADE_USDC'),
    maxTradesPerDay: num(env.MAX_TRADES_PER_DAY, 'MAX_TRADES_PER_DAY'),
    minConfidence: num(env.MIN_CONFIDENCE, 'MIN_CONFIDENCE'),
    minReserveUsdc: num(env.MIN_RESERVE_USDC, 'MIN_RESERVE_USDC'),
    minProfitPct: num(env.MIN_PROFIT_PCT, 'MIN_PROFIT_PCT'),
    stopLossPct: num(env.STOP_LOSS_PCT, 'STOP_LOSS_PCT'),
    cooldownMs: num(env.COOLDOWN_MINUTES, 'COOLDOWN_MINUTES') * 60_000,
    aiEveryMs: num(env.AI_EVERY_MINUTES ?? '15', 'AI_EVERY_MINUTES') * 60_000,
    maxCostPct: num(env.MAX_COST_PCT, 'MAX_COST_PCT'),
    panelUrl: env.PANEL_URL,
  };
}

export const TOKENS = {
  POL: { address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18 },
  USDC: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
} as const;

export const COINGECKO_IDS: Record<string, string> = { POL: 'polygon-ecosystem-token', DOT: 'polkadot' };
export const TRADABLE = 'POL';
export const WPOL = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
export const QUICKSWAP_V2_ROUTER = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff';
export const AUGUSTUS_V6 = '0x6a000f20005980200259b80c5102003040001068';
export const PENDING_TIMEOUT_MS = 20 * 60_000;
export const CYCLE_MS = 5 * 60_000;
export const STALE_MS = 15 * 60_000;
export const HISTORY_DAYS = 7;
