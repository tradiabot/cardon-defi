import type { Env, Settings } from './config';
import { getKv, putKv } from './db';

/**
 * Límites que el usuario puede ajustar desde la app cuando MODE = "app" (cada quien en su nube)
 * o cuando LIMITS_EDITABLE = "true". Si no, siguen mandando las variables de wrangler.toml.
 */
export const LIMIT_RANGES = {
  maxTradeUsdc: [1, 500],
  maxTradesPerDay: [1, 24],
  minConfidence: [50, 95],
  minReserveUsdc: [0, 100],
  minProfitPct: [0.3, 10],
} as const;

export type LimitKey = keyof typeof LIMIT_RANGES;
export type Limits = Partial<Record<LimitKey, number>>;

export const limitsEditable = (env: Env) => env.MODE === 'app' || env.LIMITS_EDITABLE === 'true';

function clean(raw: Record<string, unknown>): Limits {
  const out: Limits = {};
  for (const key of Object.keys(LIMIT_RANGES) as LimitKey[]) {
    const n = Number(raw[key]);
    const [min, max] = LIMIT_RANGES[key];
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '' && Number.isFinite(n) && n >= min && n <= max) out[key] = n;
  }
  return out;
}

export async function storedLimits(env: Env): Promise<Limits> {
  if (!limitsEditable(env)) return {};
  return clean((await getKv<Record<string, unknown>>(env.DB, 'limits')) ?? {});
}

export const applyLimits = (s: Settings, limits: Limits): Settings => ({ ...s, ...limits });

export async function saveLimits(env: Env, body: Record<string, unknown>, now = Date.now()): Promise<{ error: string } | { limits: Limits }> {
  if (!limitsEditable(env)) return { error: 'En esta instalación los límites se cambian en wrangler.toml' };
  const asked = (Object.keys(LIMIT_RANGES) as LimitKey[]).filter(k => body[k] !== undefined);
  const next = clean(body);
  const bad = asked.filter(k => next[k] === undefined);
  if (bad.length) return { error: bad.map(k => `${k} debe estar entre ${LIMIT_RANGES[k][0]} y ${LIMIT_RANGES[k][1]}`).join('; ') };
  const limits = { ...(await storedLimits(env)), ...next };
  await putKv(env.DB, 'limits', limits, now).run();
  return { limits };
}
