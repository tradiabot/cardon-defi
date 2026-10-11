import type { Action, Features } from './indicators';
import { callModel, CallError, modelLabel, type AiKeys } from './providers';
import type { GlobalBrief } from './macro';

export { parseModel, retryAfterMs } from './providers';
export type { AiKeys } from './providers';

export interface AiDecision {
  action: Action;
  confidence: number;
  reason: string;
  model: string;
  buyTrigger: number | null;
  sellTrigger: number | null;
  /** Votos individuales cuando la decisión sale de un consenso. */
  votes?: Vote[];
}

export interface Vote {
  model: string;
  ok: boolean;
  ms: number;
  action?: Action;
  confidence?: number;
  buyTrigger?: number | null;
  sellTrigger?: number | null;
  reason?: string;
  error?: string;
}

export interface AiContext {
  symbol: string;
  /** Red y DEX donde se opera (Polygon, Polkadot · Hydration…). */
  venue?: string;
  price: number;
  features: Features;
  technical: Action;
  position: { units: number; avgCostUsd: number | null; unrealizedPct: number | null; botUnits: number; botAvgCostUsd: number | null };
  usdcAvailable: number;
  sellFloor: number | null;
  rules: { maxTradeUsdc: number; minProfitPct: number; maxBuyDiscountPct: number; estimatedCostPct: number };
  activeOrders: { id: number; side: string; trigger: number; sizeUsd: number; source: string }[];
  global?: GlobalBrief | null;
}

const SYSTEM = `Eres el supervisor de un bot spot de criptomonedas contra USDC en un DEX, con órdenes condicionales. El par y la red vienen en "symbol" y "venue"; «la moneda» es la del par.
Cada 15 minutos (o antes si el precio se mueve) recibes el precio, indicadores (EMA 12/48 sobre muestras de 5 min, RSI 14, cambios 1 h/24 h, mínimo/máximo de 6 h y 24 h), la posición, las órdenes activas y, si hay, "global": el contexto económico, de mercados y político (miedo/codicia, BTC, bolsa, dólar, VIX, titulares y una lectura de riesgo). No inventes datos.

Tu trabajo es fijar el PLAN de órdenes:
- buy_trigger: precio al que comprar la moneda (orden límite), POR DEBAJO del precio actual. Tiene que poder llenarse en las próximas horas: colócalo cerca del mínimo reciente (features.low6h / low24h), no en soportes lejanos que el precio no toca. Lo normal es 0.3-1.5 % bajo el precio. null solo si no conviene comprar (caída fuerte sin señal de giro, sin USDC).
- sell_trigger: precio al que vender la moneda tomando ganancia. NUNCA por debajo de sellFloor (ya incluye coste de compra + comisiones + ganancia mínima). Ponlo donde sea realista alcanzarlo en horas (cerca de features.high6h si está por encima de sellFloor). null si no hay monedas que vender.
- Usa "global" como filtro de riesgo: en RISK_OFF (bolsa y cripto cayendo, VIX alto, noticias graves) compra más abajo o no compres; en RISK_ON puedes acercar la compra al precio. No cambia el suelo de venta.
- Las órdenes de source USUARIO son del dueño: no las dupliques; la tuya puede convivir a otro precio.
- Busca ciclos de compra barata y venta con ganancia; no hace falta certeza total, pero evita comprar en caídas fuertes sin señal de giro.
- Mantén las órdenes estables: muévelas solo si el mercado cambió de verdad.

El sistema valida y recorta tus precios; las ventas sin ganancia se rechazan siempre.
Responde SOLO un objeto JSON:
{"action":"BUY"|"SELL"|"HOLD","confidence":0-100,"buy_trigger":número|null,"sell_trigger":número|null,"reason":"máx 180 caracteres en español explicando el plan"}
action/confidence describen tu lectura actual del mercado (BUY = momento favorable para acumular).`;

function price(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseDecision(raw: string, model: string): AiDecision {
  const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  const action = String(json.action).toUpperCase();
  const confidence = Number(json.confidence);
  if (!['BUY', 'SELL', 'HOLD'].includes(action)) throw new Error(`acción inválida: ${json.action}`);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) throw new Error(`confianza inválida: ${json.confidence}`);
  return {
    action: action as Action, confidence, reason: String(json.reason ?? '').slice(0, 220), model,
    buyTrigger: price(json.buy_trigger), sellTrigger: price(json.sell_trigger),
  };
}

export class AiError extends Error {
  constructor(message: string, readonly cooldowns: Record<string, number>) { super(message); }
}

type Cooldowns = Record<string, number>;

function messages(ctx: AiContext) {
  return [{ role: 'system' as const, content: SYSTEM }, { role: 'user' as const, content: JSON.stringify(ctx) }];
}

async function vote(keys: AiKeys, entry: string, ctx: AiContext, now: number, cooldowns: Cooldowns): Promise<Vote & { decision?: AiDecision }> {
  const t = Date.now();
  try {
    const d = parseDecision(await callModel(entry, keys, messages(ctx), { now }), entry);
    return { model: entry, ok: true, ms: Date.now() - t, action: d.action, confidence: d.confidence, buyTrigger: d.buyTrigger, sellTrigger: d.sellTrigger, reason: d.reason, decision: d };
  } catch (error) {
    if (error instanceof CallError && error.cooldownUntil) cooldowns[entry] = error.cooldownUntil;
    return { model: entry, ok: false, ms: Date.now() - t, error: (error as Error).message.slice(0, 200) };
  }
}

function available(models: string[], blockedUntil: Cooldowns, now: number) {
  return models.filter(m => (blockedUntil[m] ?? 0) <= now);
}

/**
 * Prueba los modelos en orden hasta que uno responda. `blockedUntil` lleva los modelos en pausa
 * por límite; el resultado (o el error) devuelve las pausas nuevas para no gastar llamadas.
 */
export async function decide(keys: AiKeys, models: string[], ctx: AiContext, blockedUntil: Cooldowns = {}, now = Date.now()): Promise<AiDecision & { cooldowns: Cooldowns }> {
  const errors: string[] = [];
  const cooldowns: Cooldowns = {};
  for (const entry of models) {
    if ((blockedUntil[entry] ?? 0) > now) {
      errors.push(`${entry}: límite agotado, vuelve ${new Date(blockedUntil[entry]).toISOString().slice(11, 16)} UTC`);
      continue;
    }
    const v = await vote(keys, entry, ctx, now, cooldowns);
    if (v.decision) return { ...v.decision, cooldowns };
    errors.push(`${entry}: ${v.error}`);
  }
  throw new AiError(errors.join(' | '), cooldowns);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Junta los votos en una decisión:
 * - acción = la de mayor confianza sumada (empate → HOLD);
 * - confianza = media de quienes votaron esa acción × (0.5 + 0.5 × acuerdo), así 3/3 conserva la
 *   confianza y 2/3 la recorta un 17 %;
 * - disparos = mediana de los propuestos, solo si al menos la mitad de los votos propone uno
 *   (las compras solo de quienes no votaron SELL).
 */
export function combineVotes(votes: Vote[]): AiDecision | null {
  const ok = votes.filter(v => v.ok && v.action);
  if (!ok.length) return null;
  const score: Record<Action, number> = { BUY: 0, SELL: 0, HOLD: 0 };
  for (const v of ok) score[v.action!] += Math.max(1, v.confidence ?? 0);
  const ranked = (Object.keys(score) as Action[]).sort((a, b) => score[b] - score[a]);
  const action: Action = score[ranked[0]] === score[ranked[1]] ? 'HOLD' : ranked[0];
  const voters = ok.filter(v => v.action === action);
  const agreement = voters.length / ok.length;
  const base = voters.length ? voters.reduce((a, v) => a + (v.confidence ?? 0), 0) / voters.length : Math.min(...ok.map(v => v.confidence ?? 0));
  const buys = ok.filter(v => v.action !== 'SELL' && v.buyTrigger).map(v => v.buyTrigger!);
  const sells = ok.filter(v => v.sellTrigger).map(v => v.sellTrigger!);
  const lead = [...(voters.length ? voters : ok)].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
  const tally = ok.map(v => `${modelLabel(v.model).split(' · ')[0]} ${v.action} ${Math.round(v.confidence ?? 0)}`).join(', ');
  return {
    action,
    confidence: Math.round(base * (0.5 + 0.5 * agreement)),
    buyTrigger: buys.length * 2 >= ok.length ? median(buys) : null,
    sellTrigger: sells.length * 2 >= ok.length ? median(sells) : null,
    reason: `Consenso ${voters.length}/${ok.length} (${tally}): ${lead.reason ?? ''}`.slice(0, 220),
    model: `consenso:${ok.map(v => v.model).join('+')}`,
    votes,
  };
}

/**
 * Consulta a la vez los `size` primeros modelos disponibles y combina sus votos. Si responde menos
 * de la mitad, completa con los siguientes de la lista uno a uno; si no responde ninguno, falla.
 */
export async function consensus(keys: AiKeys, models: string[], ctx: AiContext, size: number, blockedUntil: Cooldowns = {}, now = Date.now()): Promise<AiDecision & { cooldowns: Cooldowns }> {
  const cooldowns: Cooldowns = {};
  const pool = available(models, blockedUntil, now);
  const first = pool.slice(0, Math.max(2, size));
  const votes = await Promise.all(first.map(m => vote(keys, m, ctx, now, cooldowns)));
  for (const m of pool.slice(first.length)) {
    if (votes.filter(v => v.ok).length * 2 >= first.length) break;
    votes.push(await vote(keys, m, ctx, now, cooldowns));
  }
  const clean = votes.map(({ decision: _, ...v }) => v);
  const combined = combineVotes(clean);
  if (!combined) throw new AiError(clean.map(v => `${v.model}: ${v.error}`).join(' | ') || 'sin modelos disponibles', cooldowns);
  return { ...combined, cooldowns };
}
