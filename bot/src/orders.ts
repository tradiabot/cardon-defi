import type { Settings } from './config';
import type { AiDecision } from './ai';

export type Side = 'BUY' | 'SELL';

export interface Order {
  id: number;
  created_ts: number;
  updated_ts: number;
  side: Side;
  trigger_price: number;
  size_usd: number;
  status: string;
  source: 'IA' | 'USUARIO';
  locked: number;
  reason: string;
  expires_ts: number | null;
  trade_id: number | null;
  note: string | null;
  /** Mercado de la orden (las anteriores a varios mercados son de POL). */
  symbol?: string;
}

export interface Desired {
  trigger: number;
  sizeUsd: number;
  reason: string;
}

export const ORDER_TTL_MS = 24 * 3_600_000;
export const EST_COST_PCT = 0.6;
export const MAX_BUY_DISCOUNT_PCT = 8;
export const MIN_ORDER_USD = 1;
const MOVE_TOLERANCE = 0.002;
const SIZE_TOLERANCE = 0.05;

/** Coste para el suelo de venta: lo que pagó el bot por sus compras; si no ha comprado, el coste medio de la cartera. */
export function costBasis(p: { units: number; avgCostUsd: number; botUnits?: number; botAvgCostUsd?: number }): number | null {
  if ((p.botUnits ?? 0) > 1e-9 && (p.botAvgCostUsd ?? 0) > 0) return p.botAvgCostUsd!;
  return p.avgCostUsd > 0 && p.units > 0 ? p.avgCostUsd : null;
}

export function sellFloor(avgCostUsd: number | null | undefined, s: Settings): number | null {
  if (!avgCostUsd || avgCostUsd <= 0) return null;
  return avgCostUsd * (1 + (s.minProfitPct + EST_COST_PCT) / 100);
}

export interface PlanContext {
  price: number;
  usdc: number;
  sellableUnits: number;
  avgCostUsd: number | null;
  /** Rango de las últimas 6 h; sin él no se ajustan los disparos al rango. */
  low6h?: number;
  high6h?: number;
}

/** Margen máximo fuera del rango de 6 h: una orden más lejos casi nunca se llena en un mercado lateral. */
export const RANGE_MARGIN_PCT = 0.3;
/** La IA puede dejar una compra en HOLD con algo menos de confianza que la exigida para comprar ya. */
export const HOLD_CONFIDENCE_SLACK = 15;

export type Plan = Record<Side, Desired | null | undefined>;

export function desiredAiOrders(ai: AiDecision | null, c: PlanContext, s: Settings): Plan {
  if (!ai) return { BUY: undefined, SELL: undefined };
  const plan: Plan = { BUY: null, SELL: null };

  const budget = Math.min(s.maxTradeUsdc, c.usdc - s.minReserveUsdc);
  const minConfidence = ai.action === 'BUY' ? s.minConfidence : s.minConfidence - HOLD_CONFIDENCE_SLACK;
  if (ai.buyTrigger !== null && ai.action !== 'SELL' && ai.confidence >= minConfidence && budget >= MIN_ORDER_USD) {
    let lowest = c.price * (1 - MAX_BUY_DISCOUNT_PCT / 100);
    if (c.low6h) lowest = Math.max(lowest, Math.min(c.low6h, c.price * 0.995) * (1 - RANGE_MARGIN_PCT / 100));
    plan.BUY = { trigger: Math.min(c.price, Math.max(lowest, ai.buyTrigger)), sizeUsd: round2(budget), reason: ai.reason };
  }

  const floor = sellFloor(c.avgCostUsd, s);
  const sellUsd = Math.min(s.maxTradeUsdc, c.sellableUnits * c.price);
  if (ai.sellTrigger !== null && floor !== null && sellUsd >= MIN_ORDER_USD) {
    const highest = c.high6h ? Math.max(c.high6h, c.price * 1.005) * (1 + RANGE_MARGIN_PCT / 100) : Infinity;
    plan.SELL = { trigger: Math.max(floor, Math.min(highest, ai.sellTrigger)), sizeUsd: round2(sellUsd), reason: ai.reason };
  }
  return plan;
}

export interface Reconcile {
  create: (Desired & { side: Side })[];
  update: (Desired & { id: number })[];
  cancel: { id: number; note: string }[];
}

export function reconcile(existing: Order[], plan: Plan): Reconcile {
  const out: Reconcile = { create: [], update: [], cancel: [] };
  for (const side of ['BUY', 'SELL'] as const) {
    const want = plan[side];
    if (want === undefined) continue;
    const mine = existing.filter(o => o.side === side && o.source === 'IA' && !o.locked && o.status === 'ACTIVA');
    const [keep, ...extra] = mine;
    extra.forEach(o => out.cancel.push({ id: o.id, note: 'Duplicada: la IA mantiene una sola orden por lado' }));
    if (want === null) {
      if (keep) out.cancel.push({ id: keep.id, note: 'La IA retiró la orden según el mercado' });
      continue;
    }
    if (!keep) out.create.push({ side, ...want });
    else if (Math.abs(keep.trigger_price - want.trigger) / keep.trigger_price > MOVE_TOLERANCE || Math.abs(keep.size_usd - want.sizeUsd) > SIZE_TOLERANCE) out.update.push({ id: keep.id, ...want });
  }
  return out;
}

export function isTriggered(o: Order, price: number): boolean {
  return o.side === 'BUY' ? price <= o.trigger_price : price >= o.trigger_price;
}

export function pickTriggered(orders: Order[], price: number): Order | null {
  const hit = orders.filter(o => o.status === 'ACTIVA' && isTriggered(o, price));
  hit.sort((a, b) => (a.side === b.side ? a.created_ts - b.created_ts : a.side === 'SELL' ? -1 : 1));
  return hit[0] ?? null;
}

export interface UserOrderInput {
  side: unknown;
  triggerPrice: unknown;
  amountUsdc: unknown;
}

export function validateUserOrder(input: UserOrderInput, c: { price: number; avgCostUsd: number | null }, s: Settings): { side: Side; trigger: number; sizeUsd: number } | { error: string } {
  const side = String(input.side ?? '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') return { error: 'Lado inválido: usa BUY o SELL' };
  const trigger = Number(input.triggerPrice);
  const size = Number(input.amountUsdc);
  if (!Number.isFinite(trigger) || trigger <= 0) return { error: 'Precio de disparo inválido' };
  if (c.price > 0 && (trigger < c.price * 0.5 || trigger > c.price * 2)) return { error: `Precio de disparo fuera de rango (precio actual ${c.price.toFixed(5)})` };
  if (!Number.isFinite(size) || size < MIN_ORDER_USD) return { error: `Monto mínimo ${MIN_ORDER_USD} USDC` };
  if (size > s.maxTradeUsdc) return { error: `Monto máximo por orden: ${s.maxTradeUsdc} USDC` };
  if (side === 'SELL') {
    const floor = sellFloor(c.avgCostUsd, s);
    if (floor === null) return { error: 'No hay monedas compradas por el bot con coste conocido que vender' };
    if (trigger < floor) return { error: `Venta sin ganancia: el mínimo es ${floor.toFixed(5)} (coste ${c.avgCostUsd!.toFixed(5)} + comisiones + ${s.minProfitPct}%)` };
  }
  return { side, trigger, sizeUsd: round2(size) };
}

function round2(n: number): number {
  return Math.floor(n * 100) / 100;
}
