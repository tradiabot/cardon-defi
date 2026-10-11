import { settings, type Env, type Settings } from './config';
import { getKv } from './db';
import { bookKey, type CycleStatus } from './engine';
import { applyLimits, storedLimits } from './limits';
import { kvKey, marketConfig, marketSettings, type Market, type MarketMode } from './markets';
import type { Portfolio } from './paper';

/** Lo que la API necesita de un mercado: sus ajustes (con su modo), el último ciclo y su cartera. */
export interface MarketCtx {
  m: Market;
  s: Settings;
  mode: MarketMode;
  enabled: boolean;
  cycle: CycleStatus | null;
  book: Portfolio | null;
  price: number;
}

export async function loadMarket(env: Env, m: Market): Promise<MarketCtx> {
  const cfg = (await marketConfig(env))[m.id];
  const s = marketSettings(applyLimits(settings(env), await storedLimits(env)), m, cfg.mode);
  const [cycle, book] = await Promise.all([getKv<CycleStatus>(env.DB, kvKey(m, 'status')), getKv<Portfolio>(env.DB, bookKey(cfg.mode, m))]);
  return { m, s, mode: cfg.mode, enabled: cfg.enabled, cycle, book, price: cycle?.prices?.[m.id]?.usd ?? 0 };
}
