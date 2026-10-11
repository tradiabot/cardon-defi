import type { Env } from './config';
import { loadMarket } from './context';
import { MARKETS, market, type Market } from './markets';
import { costBasis, validateUserOrder, type Order } from './orders';

const USER_ORDER_TTL_MS = 7 * 86_400_000;
const EDITABLE = new Set(['ACTIVA']);

export async function listOrders(env: Env, limit = 40, m?: Market): Promise<Order[]> {
  const { results } = await env.DB
    .prepare(`SELECT * FROM orders ${m ? 'WHERE symbol = ?' : ''} ORDER BY CASE status WHEN 'ACTIVA' THEN 0 WHEN 'EJECUTANDO' THEN 1 WHEN 'REVISAR' THEN 2 ELSE 3 END, updated_ts DESC LIMIT ?`)
    .bind(...(m ? [m.id, limit] : [limit]))
    .all<Order>();
  return results;
}

async function context(env: Env, m: Market) {
  const c = await loadMarket(env, m);
  return { s: c.s, price: c.price, avgCostUsd: c.book ? costBasis(c.book) : null, enabled: c.enabled };
}

type Result = { order: Order } | { error: string; status: number };

export async function createUserOrder(env: Env, body: Record<string, unknown>, m: Market = market(body.market as string) ?? MARKETS.POL): Promise<Result> {
  const c = await context(env, m);
  if (!c.enabled) return { error: `El mercado ${m.id} está apagado: actívalo primero`, status: 409 };
  if (!(c.price > 0)) return { error: `Aún no hay precio de ${m.id}: espera al primer ciclo`, status: 409 };
  const v = validateUserOrder({ side: body.side, triggerPrice: body.triggerPrice, amountUsdc: body.amountUsdc }, c, c.s);
  if ('error' in v) return { error: v.error, status: 400 };
  const now = Date.now();
  const order = await env.DB
    .prepare("INSERT INTO orders (created_ts, updated_ts, side, trigger_price, size_usd, status, source, locked, reason, expires_ts, symbol) VALUES (?, ?, ?, ?, ?, 'ACTIVA', 'USUARIO', 1, ?, ?, ?) RETURNING *")
    .bind(now, now, v.side, v.trigger, v.sizeUsd, String(body.reason ?? 'Orden creada por el usuario').slice(0, 160), now + USER_ORDER_TTL_MS, m.id)
    .first<Order>();
  return order ? { order } : { error: 'No se pudo crear la orden', status: 500 };
}

async function find(env: Env, id: number): Promise<Order | null> {
  return env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Order>();
}

export async function editOrder(env: Env, id: number, body: Record<string, unknown>): Promise<Result> {
  const current = await find(env, id);
  if (!current) return { error: 'Orden no encontrada', status: 404 };
  if (!EDITABLE.has(current.status)) return { error: `La orden está ${current.status}: ya no se puede editar`, status: 409 };
  const c = await context(env, market(current.symbol) ?? MARKETS.POL);
  const v = validateUserOrder({ side: current.side, triggerPrice: body.triggerPrice ?? current.trigger_price, amountUsdc: body.amountUsdc ?? current.size_usd }, c, c.s);
  if ('error' in v) return { error: v.error, status: 400 };
  const now = Date.now();
  const order = await env.DB
    .prepare("UPDATE orders SET trigger_price = ?, size_usd = ?, locked = 1, note = ?, updated_ts = ?, expires_ts = ? WHERE id = ? AND status = 'ACTIVA' RETURNING *")
    .bind(v.trigger, v.sizeUsd, `Editada por el usuario${current.source === 'IA' ? ' · la IA ya no la modifica' : ''}`, now, now + USER_ORDER_TTL_MS, id)
    .first<Order>();
  return order ? { order } : { error: 'La orden cambió de estado mientras se editaba', status: 409 };
}

export async function cancelOrder(env: Env, id: number): Promise<Result> {
  const now = Date.now();
  const order = await env.DB
    .prepare("UPDATE orders SET status = 'CANCELADA', note = 'Cancelada por el usuario', updated_ts = ? WHERE id = ? AND status = 'ACTIVA' RETURNING *")
    .bind(now, id)
    .first<Order>();
  if (order) return { order };
  const current = await find(env, id);
  return current ? { error: `La orden está ${current.status}: no se puede cancelar`, status: 409 } : { error: 'Orden no encontrada', status: 404 };
}
