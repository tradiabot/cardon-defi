import { CYCLE_MS, HISTORY_DAYS, PENDING_TIMEOUT_MS, STALE_MS, settings, type Env, type Settings } from './config';
import { applyLimits, storedLimits } from './limits';
import { DEFAULT_MARKET, kvKey, MARKETS, marketConfig, marketSettings, VENUES, type Market, type MarketMode } from './markets';
import { baseOf, gasShort, venueBalances, venuePrices, venueQuote, venueSettlement, venueSubmit, type Balances } from './venues';
import { features, technicalSignal, type Action, type Features } from './indicators';
import { AiError, consensus, decide, type AiDecision } from './ai';
import { loadAi } from './aiConfig';
import { brief, fetchMacro, MACRO_TTL_MS, type Macro } from './macro';
import type { DexQuote } from './dex';
import { buyGuard, checkExecution, gate, orderSize, stopLossSize } from './strategy';
import { applyFill, applyTrade, botUnrealizedPct, seed, unrealizedPct, type Portfolio } from './paper';
import { SubmitError } from './live';
import { acquireLock, ensureReadIndexes, getKv, priceSeries, putKv, releaseLock, tradeStats } from './db';
import { alert, sendAlerts, type Alert } from './alerts';
import { costBasis, desiredAiOrders, EST_COST_PCT, MAX_BUY_DISCOUNT_PCT, ORDER_TTL_MS, pickTriggered, reconcile, sellFloor, type Order, type Side } from './orders';

export interface Control {
  paused: boolean;
  reason: string;
  changedAt: number;
}

export interface CycleStatus {
  ts: number;
  /** Mercado del ciclo (los estados guardados antes de haber varios mercados no lo traen: son de POL). */
  market?: string;
  mode: 'paper' | 'live';
  ok: boolean;
  durationMs: number;
  errors: string[];
  warnings: string[];
  prices: Record<string, { usd: number; change24h: number | null; source: string }>;
  features: Features | null;
  onchain: (Balances & { ts: number }) | null;
  onchainLast: (Balances & { ts: number }) | null;
  /** Plan de la IA vigente cuando este ciclo no la consultó (cadencia) o la IA falló. */
  aiPlan?: { decision: AiDecision; ts: number; reused: boolean } | null;
  decision: { technical: string; ai: AiDecision | null; final: string; blockedBy: string | null; trigger: string | null; orderId: number | null } | null;
  trade: { side: string; amountIn: number; amountOut: number; costPct: number; status: string; txHash: string | null } | null;
  settled: { id: number; status: string } | null;
  orders: { active: number; created: number; updated: number; cancelled: number; expired: number; sellFloor: number | null } | null;
}

interface TradeRow {
  id: number;
  ts: number;
  side: 'BUY' | 'SELL';
  amount_in: number;
  amount_out: number;
  status: string;
  tx_hash: `0x${string}` | null;
  approve_hash: `0x${string}` | null;
  reason: string;
}

interface Candidate {
  side: Side;
  sizeUsd: number;
  orderId: number | null;
  trigger: 'ORDEN' | 'STOP_LOSS';
  reason: string;
}

const SERIES_LIMIT = 300;
const FAIL_ALERT_STREAK = 3;
const DECISIONS_RETENTION_DAYS = 30;
const scan = (m: Market, hash: string | null) => (hash ? `${VENUES[m.venue].explorer}${hash}` : 'sin hash');
/** Cartera de práctica de un mercado en simulación cuando la wallet aún no tiene fondos en esa red. */
const PRACTICE_USDC = 10;

export interface Health {
  failStreak: number;
  lastOkTs: number;
  alerted: boolean;
  lastDaily: string;
}
export const bookKey = (mode: 'paper' | 'live', m: Market = MARKETS[DEFAULT_MARKET]) => kvKey(m, mode === 'live' ? 'live_book' : 'portfolio');

function utcDayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Un ciclo de un mercado. `lead`: el mercado que además refresca el contexto global y sigue el precio de DOT. */
export async function runCycle(env: Env, now = Date.now(), m: Market = MARKETS[DEFAULT_MARKET], opts: { mode?: MarketMode; lead?: boolean; trackDot?: boolean } = {}): Promise<CycleStatus | { skipped: string }> {
  const db = env.DB;
  const lock = kvKey(m, 'lock');
  if (!(await acquireLock(db, now, CYCLE_MS, lock))) return { skipped: 'CICLO_EN_CURSO' };
  try {
    const mode = opts.mode ?? (await marketConfig(env))[m.id].mode;
    return await cycle(env, m, mode, now, { lead: opts.lead ?? m.id === DEFAULT_MARKET, trackDot: opts.trackDot ?? true });
  } finally {
    await releaseLock(db, lock);
  }
}

function pauseStatement(db: D1Database, reason: string, now: number): D1PreparedStatement {
  return putKv(db, 'control', { paused: true, reason, changedAt: now } satisfies Control, now);
}

const describe = (m: Market, side: string, amountIn: number, amountOut: number, approx = '') => (side === 'BUY'
  ? `Compra ${amountIn.toFixed(2)} USDC → ${approx}${amountOut.toPrecision(5)} ${m.id}`
  : `Venta ${amountIn.toPrecision(5)} ${m.id} → ${approx}${amountOut.toFixed(2)} USDC`);

async function settlePending(env: Env, s: Settings, m: Market, book: Portfolio, price: number, now: number, status: CycleStatus, alerts: Alert[]): Promise<{ book: Portfolio; block: string | null }> {
  const db = env.DB;
  const pending = await db
    .prepare("SELECT id, ts, side, amount_in, amount_out, status, tx_hash, approve_hash, reason FROM trades WHERE mode = 'LIVE' AND symbol = ? AND status IN ('ENVIANDO', 'PENDIENTE') ORDER BY ts LIMIT 1")
    .bind(m.id)
    .first<TradeRow>();
  if (!pending) return { book, block: null };

  const expired = now - pending.ts > PENDING_TIMEOUT_MS;
  if (!pending.tx_hash) {
    if (!expired) return { book, block: 'TX_PENDIENTE' };
    await db.batch([
      db.prepare("UPDATE trades SET status = 'DESCONOCIDA', error = 'sin hash tras el envío' WHERE id = ?").bind(pending.id),
      db.prepare("UPDATE orders SET status = 'REVISAR', updated_ts = ? WHERE trade_id = ?").bind(now, pending.id),
      pauseStatement(db, `Operación #${pending.id} sin confirmar: revisar en el explorador`, now),
    ]);
    status.settled = { id: pending.id, status: 'DESCONOCIDA' };
    alerts.push(alert('BOT PAUSADO', `La operación #${pending.id} no llegó a tener hash. Revisa la wallet en el explorador de ${VENUES[m.venue].name} y reanuda desde el panel.`, 5, ['rotating_light']));
    return { book, block: 'TX_DESCONOCIDA' };
  }

  const r = await venueSettlement(m, s, pending.tx_hash, pending.approve_hash, async () => {
    if (m.native) return price;
    const row = await db.prepare("SELECT usd FROM prices WHERE symbol = 'POL' ORDER BY ts DESC LIMIT 1").first<{ usd: number }>();
    return row?.usd ?? 0;
  });
  if (r.status === 'PENDIENTE') {
    if (!expired) return { book, block: 'TX_PENDIENTE' };
    await db.batch([
      db.prepare("UPDATE trades SET status = 'DESCONOCIDA', error = 'sin recibo tras 20 min' WHERE id = ?").bind(pending.id),
      db.prepare("UPDATE orders SET status = 'REVISAR', updated_ts = ? WHERE trade_id = ?").bind(now, pending.id),
      pauseStatement(db, `Operación #${pending.id} sin recibo: revisar en el explorador`, now),
    ]);
    status.settled = { id: pending.id, status: 'DESCONOCIDA' };
    alerts.push(alert('BOT PAUSADO', `La operación #${pending.id} lleva 20 min sin recibo: ${scan(m, pending.tx_hash)}. Revísala y reanuda desde el panel.`, 5, ['rotating_light']));
    return { book, block: 'TX_DESCONOCIDA' };
  }

  const gasUsd = r.gasUsd;
  let next = { ...book, realizedPnlUsd: book.realizedPnlUsd - gasUsd };
  let realized: number | null = -gasUsd;
  if (r.status === 'CONFIRMADA') ({ next, realized } = applyFill(book, pending.side, { amountIn: pending.amount_in, amountOut: pending.amount_out, gasUsd }, pending.reason === 'STOP_LOSS'));
  await db.batch([
    db.prepare('UPDATE trades SET status = ?, gas_usd = ?, realized_pnl_usd = ?, settled_at = ? WHERE id = ?').bind(r.status, gasUsd, realized, now, pending.id),
    putKv(db, bookKey('live', m), next, now),
    db.prepare('UPDATE orders SET status = ?, updated_ts = ? WHERE trade_id = ?').bind(r.status === 'CONFIRMADA' ? 'EJECUTADA' : 'FALLIDA', now, pending.id),
  ]);
  status.settled = { id: pending.id, status: r.status };
  const what = describe(m, pending.side, pending.amount_in, pending.amount_out);
  alerts.push(r.status === 'CONFIRMADA'
    ? alert('Operación confirmada', `${what}${realized !== null && pending.side === 'SELL' ? ` · P/L ${realized.toFixed(3)} USD` : ''} · gas ${gasUsd.toFixed(4)} USD\n${scan(m, pending.tx_hash)}`, 3, ['white_check_mark'])
    : alert('Operación FALLIDA', `${what} revertida en cadena (gas perdido ${gasUsd.toFixed(4)} USD)\n${scan(m, pending.tx_hash)}`, 4, ['x']));
  return { book: next, block: null };
}

async function executeLive(env: Env, s: Settings, m: Market, c: Candidate, q: DexQuote, now: number, status: CycleStatus, alerts: Alert[]): Promise<boolean> {
  const db = env.DB;
  const price = c.side === 'BUY' ? q.amountIn / q.amountOut : q.amountOut / q.amountIn;
  const row = await db
    .prepare("INSERT INTO trades (ts, mode, side, symbol, amount_in, amount_out, price_usd, cost_pct, gas_usd, realized_pnl_usd, reason, status, order_id) VALUES (?, 'LIVE', ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'ENVIANDO', ?) RETURNING id")
    .bind(now, c.side, m.id, q.amountIn, q.amountOut, price, q.costPct, q.gasUsd, c.trigger === 'STOP_LOSS' ? 'STOP_LOSS' : c.reason, c.orderId)
    .first<{ id: number }>();
  if (!row) throw new Error('no se pudo registrar la operación antes de enviarla');
  status.trade = { side: c.side, amountIn: q.amountIn, amountOut: q.amountOut, costPct: q.costPct, status: 'ENVIANDO', txHash: null };
  try {
    const { hash, approveHash } = await venueSubmit(m, s, env.WALLET_PRIVATE_KEY, c.side, q);
    await db.batch([
      db.prepare("UPDATE trades SET status = 'PENDIENTE', tx_hash = ?, approve_hash = ? WHERE id = ?").bind(hash, approveHash, row.id),
      ...(c.orderId ? [db.prepare("UPDATE orders SET status = 'EJECUTANDO', trade_id = ?, updated_ts = ? WHERE id = ?").bind(row.id, now, c.orderId)] : []),
    ]);
    status.trade = { ...status.trade, status: 'PENDIENTE', txHash: hash };
    alerts.push(alert(c.trigger === 'STOP_LOSS' ? 'STOP-LOSS enviado' : 'Orden enviada', `${describe(m, c.side, q.amountIn, q.amountOut, '~')} · coste ${q.costPct.toFixed(2)}%\n${c.reason}\n${scan(m, hash)}`, c.trigger === 'STOP_LOSS' ? 4 : 3, [c.side === 'BUY' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend']));
    return true;
  } catch (error) {
    const e = error instanceof SubmitError ? error : new SubmitError((error as Error).message, 'prepare', null);
    const unknown = e.stage === 'send';
    const stmts = [db.prepare('UPDATE trades SET status = ?, approve_hash = ?, error = ? WHERE id = ?').bind(unknown ? 'DESCONOCIDA' : 'ERROR_ENVIO', e.approveHash, `${e.stage}: ${e.message}`, row.id)];
    if (c.orderId) stmts.push(db.prepare('UPDATE orders SET status = ?, note = ?, trade_id = ?, updated_ts = ? WHERE id = ?').bind(unknown ? 'REVISAR' : 'ACTIVA', `Envío falló (${e.stage}): ${e.message}`.slice(0, 200), row.id, now, c.orderId));
    if (unknown) {
      stmts.push(pauseStatement(db, `Envío de la operación #${row.id} incierto: revisar en el explorador`, now));
      alerts.push(alert('BOT PAUSADO', `No se sabe si la operación #${row.id} salió (${e.message}). Revisa la wallet en el explorador de ${VENUES[m.venue].name} y reanuda desde el panel.`, 5, ['rotating_light']));
    }
    await db.batch(stmts);
    status.trade = { ...status.trade, status: unknown ? 'DESCONOCIDA' : 'ERROR_ENVIO' };
    status.errors.push(`envío (${e.stage}): ${e.message}`);
    return false;
  }
}

async function activeOrders(db: D1Database, m: Market): Promise<Order[]> {
  return (await db.prepare("SELECT * FROM orders WHERE status = 'ACTIVA' AND symbol = ? ORDER BY created_ts").bind(m.id).all<Order>()).results;
}

async function superviseOrders(db: D1Database, m: Market, ai: AiDecision, s: Settings, ctx: { price: number; usdc: number; units: number; avgCostUsd: number | null; low6h?: number; high6h?: number }, now: number, summary: NonNullable<CycleStatus['orders']>): Promise<void> {
  const plan = desiredAiOrders(ai, { price: ctx.price, usdc: ctx.usdc, sellableUnits: ctx.units, avgCostUsd: ctx.avgCostUsd, low6h: ctx.low6h, high6h: ctx.high6h }, s);
  const r = reconcile(await activeOrders(db, m), plan);
  const expires = now + ORDER_TTL_MS;
  const stmts: D1PreparedStatement[] = [
    ...r.create.map(o => db.prepare("INSERT INTO orders (created_ts, updated_ts, side, trigger_price, size_usd, status, source, locked, reason, expires_ts, symbol) VALUES (?, ?, ?, ?, ?, 'ACTIVA', 'IA', 0, ?, ?, ?)").bind(now, now, o.side, o.trigger, o.sizeUsd, o.reason, expires, m.id)),
    ...r.update.map(o => db.prepare('UPDATE orders SET trigger_price = ?, size_usd = ?, reason = ?, updated_ts = ?, expires_ts = ? WHERE id = ?').bind(o.trigger, o.sizeUsd, o.reason, now, expires, o.id)),
    ...r.cancel.map(o => db.prepare("UPDATE orders SET status = 'CANCELADA', note = ?, updated_ts = ? WHERE id = ?").bind(o.note, now, o.id)),
    db.prepare("UPDATE orders SET expires_ts = ? WHERE source = 'IA' AND locked = 0 AND status = 'ACTIVA' AND symbol = ?").bind(expires, m.id),
  ];
  await db.batch(stmts);
  summary.created = r.create.length;
  summary.updated = r.update.length;
  summary.cancelled = r.cancel.length;
}

async function cycle(env: Env, m: Market, mode: MarketMode, now: number, opts: { lead: boolean; trackDot: boolean }): Promise<CycleStatus> {
  const db = env.DB;
  const s = marketSettings(applyLimits(settings(env), await storedLimits(env)), m, mode);
  const started = Date.now();
  const status: CycleStatus = { ts: now, market: m.id, mode: s.mode, ok: false, durationMs: 0, errors: [], warnings: [], prices: {}, features: null, onchain: null, onchainLast: null, decision: null, trade: null, settled: null, orders: null };
  const writes: D1PreparedStatement[] = [];
  const alerts: Alert[] = [];
  const finish = async () => {
    status.ok = status.errors.length === 0;
    try {
      await trackHealth(env, s, status, alerts, writes, now, m);
    } catch (error) {
      status.warnings.push(`salud: ${(error as Error).message}`);
    }
    status.warnings.push(...(await sendAlerts(env.NTFY_TOPIC, alerts, s.panelUrl)));
    status.durationMs = Date.now() - started;
    writes.push(putKv(db, kvKey(m, 'status'), status, now));
    await db.batch(writes);
    return status;
  };

  try {
    ({ prices: status.prices, warnings: status.warnings } = await venuePrices(m, s, opts.trackDot));
  } catch (error) {
    status.errors.push(`precios: ${(error as Error).message}`);
    status.decision = { technical: 'HOLD', ai: null, final: 'HOLD', blockedBy: 'SIN_PRECIO', trigger: null, orderId: null };
    writes.push(db
      .prepare("INSERT INTO decisions (ts, symbol, technical, final, blocked_by, ai_error, features) VALUES (?, ?, 'HOLD', 'HOLD', 'SIN_PRECIO', ?, '{}')")
      .bind(now, m.id, (error as Error).message));
    return finish();
  }
  await ensureReadIndexes(db);
  await db.batch([
    ...Object.entries(status.prices).map(([sym, q]) => db.prepare('INSERT OR IGNORE INTO prices (ts, symbol, usd) VALUES (?, ?, ?)').bind(now, sym, q.usd)),
    db.prepare('DELETE FROM prices WHERE ts < ?').bind(now - HISTORY_DAYS * 86_400_000),
  ]);

  const series = await priceSeries(db, m.id, SERIES_LIMIT);
  const f = features(series.map(p => p.usd), status.prices[m.id].change24h);
  status.features = f;

  try {
    status.onchain = { ...(await venueBalances(m, s)), ts: now };
    status.onchainLast = status.onchain;
    writes.push(putKv(db, kvKey(m, 'onchain_last'), status.onchain, now));
  } catch (error) {
    status.errors.push(`on-chain: ${(error as Error).message}`);
    status.onchainLast = await getKv<Balances & { ts: number }>(db, kvKey(m, 'onchain_last'));
  }

  const key = bookKey(s.mode, m);
  let book = await getKv<Portfolio>(db, key);
  if (!book) {
    if (!status.onchain) {
      status.errors.push('cartera sin inicializar: falta lectura on-chain');
      return finish();
    }
    const held = baseOf(status.onchain);
    // En simulación, un mercado nuevo sin fondos en su red practica con una cartera ficticia.
    const practice = s.mode === 'paper' && m.id !== DEFAULT_MARKET && status.onchain.USDC + held * f.price < PRACTICE_USDC;
    book = practice ? seed(PRACTICE_USDC, 0, f.price, now) : seed(status.onchain.USDC, held, f.price, now);
    writes.push(putKv(db, key, book, now));
  }

  let liveBlock: string | null = null;
  if (s.mode === 'live') {
    try {
      ({ book, block: liveBlock } = await settlePending(env, s, m, book, f.price, now, status, alerts));
    } catch (error) {
      liveBlock = 'TX_SIN_VERIFICAR';
      status.errors.push(`recibo: ${(error as Error).message}`);
    }
    if (!liveBlock && !env.WALLET_PRIVATE_KEY) liveBlock = 'SIN_CLAVE';
    if (!liveBlock && !status.onchain) liveBlock = 'SIN_LECTURA_ONCHAIN';
    if (!liveBlock && gasShort(m, s, status.onchain!)) liveBlock = 'SIN_GAS';
  }

  const control = (await getKv<Control>(db, 'control')) ?? { paused: false, reason: '', changedAt: 0 };
  const technical = technicalSignal(f);
  const upnl = unrealizedPct(book, f.price);
  const usdc = s.mode === 'live' ? status.onchain?.USDC ?? 0 : book.usdc;
  const units = s.mode === 'live' ? Math.max(0, baseOf(status.onchain) - s.gasReservePol) : book.units;
  // El POL de reserva de gas no se vende: el suelo usa el coste de lo comprado por el bot.
  const avgCost = costBasis(book);
  const floor = sellFloor(avgCost, s);
  const summary: NonNullable<CycleStatus['orders']> = { active: 0, created: 0, updated: 0, cancelled: 0, expired: 0, sellFloor: floor };
  status.orders = summary;

  const expired = await db.prepare("UPDATE orders SET status = 'EXPIRADA', updated_ts = ? WHERE status = 'ACTIVA' AND symbol = ? AND expires_ts IS NOT NULL AND expires_ts < ?").bind(now, m.id, now).run();
  summary.expired = expired.meta.changes;

  let ai: AiDecision | null = null;
  let aiError: string | null = null;
  const lastAi = await getKv<{ decision: AiDecision; ts: number; price: number }>(db, kvKey(m, 'ai_last'));
  const aiCfg = await loadAi(env);
  let macro = await getKv<Macro>(db, 'macro');
  let due = false;
  if (!aiCfg.models.length) aiError = 'sin modelos de IA configurados';
  else if (!control.paused && !liveBlock) {
    const open = await activeOrders(db, m);
    const moved = lastAi ? Math.abs(f.price / lastAi.price - 1) * 100 : Infinity;
    // Replanificar cuesta tokens: solo cada aiEveryMs, si el precio se movió o si no queda ninguna orden.
    due = !lastAi || now - lastAi.ts >= s.aiEveryMs - 30_000 || moved > 0.8 || open.length === 0;
    if (due) {
      const blocked = (await getKv<Record<string, number>>(db, 'ai_cooldown')) ?? {};
      // Consenso: varias IAs votan a la vez y se combinan; si está apagado, la primera que responda.
      const ask = aiCfg.consensus.enabled
        ? (ctx: Parameters<typeof decide>[2]) => consensus(aiCfg.keys, aiCfg.models, ctx, aiCfg.consensus.size, blocked, now)
        : (ctx: Parameters<typeof decide>[2]) => decide(aiCfg.keys, aiCfg.models, ctx, blocked, now);
      try {
        const { cooldowns, ...decision } = await ask({
          symbol: `${m.id}/USDC`, venue: VENUES[m.venue].name, price: f.price, features: f, technical,
          position: { units, avgCostUsd: avgCost, unrealizedPct: upnl, botUnits: book.botUnits ?? 0, botAvgCostUsd: book.botAvgCostUsd || null },
          usdcAvailable: usdc, sellFloor: floor,
          rules: { maxTradeUsdc: s.maxTradeUsdc, minProfitPct: s.minProfitPct, maxBuyDiscountPct: MAX_BUY_DISCOUNT_PCT, estimatedCostPct: EST_COST_PCT },
          activeOrders: open.map(o => ({ id: o.id, side: o.side, trigger: o.trigger_price, sizeUsd: o.size_usd, source: o.source })),
          global: brief(macro, now),
        });
        ai = decision;
        if (Object.keys(cooldowns).length) writes.push(putKv(db, 'ai_cooldown', { ...blocked, ...cooldowns }, now));
        writes.push(putKv(db, kvKey(m, 'ai_last'), { decision, ts: now, price: f.price }, now));
      } catch (error) {
        aiError = (error as Error).message;
        if (error instanceof AiError && Object.keys(error.cooldowns).length) writes.push(putKv(db, 'ai_cooldown', { ...blocked, ...error.cooldowns }, now));
        status.errors.push(`IA: ${aiError}`);
      }
    }
  }
  // El contexto global se refresca cada hora en un ciclo sin consulta de trading (límite de subpeticiones).
  if (opts.lead && !due && (!macro || now - macro.ts >= MACRO_TTL_MS)) {
    try {
      macro = await fetchMacro(aiCfg.keys, aiCfg.models, (await getKv<Record<string, number>>(db, 'ai_cooldown')) ?? {}, now);
      writes.push(putKv(db, 'macro', macro, now));
      if (macro.errors.length) status.warnings.push(`contexto global: ${macro.errors.slice(0, 3).join(' · ')}`);
    } catch (error) {
      status.warnings.push(`contexto global: ${(error as Error).message}`);
    }
  }
  status.aiPlan = ai ? { decision: ai, ts: now, reused: false } : lastAi ? { decision: lastAi.decision, ts: lastAi.ts, reused: true } : null;
  if (ai) {
    try {
      await superviseOrders(db, m, ai, s, { price: f.price, usdc, units, avgCostUsd: avgCost, low6h: f.low6h, high6h: f.high6h }, now, summary);
    } catch (error) {
      status.errors.push(`órdenes: ${(error as Error).message}`);
    }
  }
  const orders = await activeOrders(db, m);
  summary.active = orders.length;

  const stats = await tradeStats(db, utcDayStart(now), s.mode === 'live' ? 'LIVE' : 'PAPER', m.id);
  const dataAgeMs = series.length ? now - series[series.length - 1].ts : Infinity;
  let blockedBy: string | null = control.paused ? 'PAUSADO' : liveBlock ?? gate({ now, paused: false, dataAgeMs, staleMs: STALE_MS, tradesToday: stats.today, lastTradeTs: stats.lastTs }, s);
  let final: Action = 'HOLD';
  let candidate: Candidate | null = null;

  if (!blockedBy) {
    const stop = stopLossSize(f.price, units, book.botUnits ?? 0, botUnrealizedPct(book, f.price), s);
    if (stop) candidate = { side: 'SELL', sizeUsd: stop, orderId: null, trigger: 'STOP_LOSS', reason: `Stop-loss −${s.stopLossPct}% sobre lo comprado por el bot` };
    else {
      const o = pickTriggered(orders, f.price);
      if (o && stats.lastTs !== null && now - stats.lastTs < s.cooldownMs) blockedBy = 'ENFRIAMIENTO';
      else if (o) {
        const guard = o.side === 'BUY' && o.source === 'IA'
          ? buyGuard({ risk: macro?.digest.risk ?? null, riskAgeMs: macro ? now - macro.ts : Infinity, change1h: f.change1h, price: f.price, last30m: series.slice(-7).map(p => p.usd) })
          : null;
        const sized = orderSize(o.side, o.size_usd, usdc, units, f.price, s);
        if (guard) {
          blockedBy = guard;
          const note = guard === 'RIESGO_GLOBAL' ? 'Disparada, esperando: el panorama global marca aversión al riesgo' : `Disparada, esperando a que ${m.id} deje de caer`;
          if (o.note !== note) writes.push(db.prepare('UPDATE orders SET note = ?, updated_ts = ? WHERE id = ?').bind(note, now, o.id));
        } else if ('blocked' in sized) blockedBy = sized.blocked;
        else candidate = { side: o.side, sizeUsd: sized.size, orderId: o.id, trigger: 'ORDEN', reason: `Orden #${o.id} (${o.source}) a ${o.trigger_price.toFixed(5)} · ${o.reason}`.slice(0, 280) };
      }
    }
  }

  if (candidate) {
    try {
      const amountIn = candidate.side === 'BUY' ? candidate.sizeUsd : candidate.sizeUsd / f.price;
      const q = await venueQuote(m, candidate.side, amountIn, s, f.price);
      const fillPrice = candidate.side === 'BUY' ? q.amountIn / q.amountOut : q.amountOut / q.amountIn;
      blockedBy = checkExecution(candidate.side, { costPct: q.costPct, gasPct: (q.gasUsd / q.srcUsd) * 100, fillPrice }, avgCost, s, candidate.trigger === 'STOP_LOSS');
      if (blockedBy) {
        if (candidate.orderId) writes.push(db.prepare('UPDATE orders SET note = ?, updated_ts = ? WHERE id = ?').bind(`Disparada pero bloqueada: ${blockedBy} (precio efectivo ${fillPrice.toFixed(5)})`, now, candidate.orderId));
      } else if (s.mode === 'live') {
        if (await executeLive(env, s, m, candidate, q, now, status, alerts)) final = candidate.side;
        else blockedBy = status.trade?.status ?? 'ERROR_ENVIO';
      } else {
        const { next, realized } = applyTrade(book, candidate.side, q, candidate.trigger === 'STOP_LOSS');
        writes.push(db
          .prepare("INSERT INTO trades (ts, mode, side, symbol, amount_in, amount_out, price_usd, cost_pct, gas_usd, realized_pnl_usd, reason, status, order_id) VALUES (?, 'PAPER', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SIMULADA', ?)")
          .bind(now, candidate.side, m.id, q.amountIn, q.amountOut, fillPrice, q.costPct, q.gasUsd, realized, candidate.trigger === 'STOP_LOSS' ? 'STOP_LOSS' : candidate.reason, candidate.orderId));
        if (candidate.orderId) writes.push(db.prepare("UPDATE orders SET status = 'EJECUTADA', trade_id = last_insert_rowid(), updated_ts = ? WHERE id = ?").bind(now, candidate.orderId));
        writes.push(putKv(db, key, next, now));
        status.trade = { side: candidate.side, amountIn: q.amountIn, amountOut: q.amountOut, costPct: q.costPct, status: 'SIMULADA', txHash: null };
        final = candidate.side;
      }
    } catch (error) {
      blockedBy = 'COTIZACION_FALLIDA';
      status.errors.push(`DEX: ${(error as Error).message}`);
    }
  }

  status.decision = { technical, ai, final, blockedBy, trigger: final === 'HOLD' ? null : candidate?.trigger ?? null, orderId: final === 'HOLD' ? null : candidate?.orderId ?? null };
  writes.push(db
    .prepare('INSERT INTO decisions (ts, symbol, technical, ai_action, ai_confidence, ai_model, ai_reason, ai_error, final, blocked_by, features) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(now, m.id, technical, ai?.action ?? null, ai?.confidence ?? null, ai?.model ?? null, ai?.reason ?? null, aiError, final, blockedBy, JSON.stringify({ ...f, buyTrigger: ai?.buyTrigger ?? null, sellTrigger: ai?.sellTrigger ?? null })));
  return finish();
}

export async function trackHealth(env: Env, s: Settings, status: CycleStatus, alerts: Alert[], writes: D1PreparedStatement[], now: number, m: Market = MARKETS[DEFAULT_MARKET]): Promise<void> {
  const db = env.DB;
  const day = new Date(now).toISOString().slice(0, 10);
  const prev = (await getKv<Health>(db, kvKey(m, 'health'))) ?? { failStreak: 0, lastOkTs: 0, alerted: false, lastDaily: day };
  const health: Health = { ...prev };
  if (status.ok) {
    if (prev.alerted) alerts.push(alert(`${m.id} · Recuperado`, `Los ciclos vuelven a funcionar tras ${prev.failStreak} fallos seguidos.`, 3, ['white_check_mark']));
    Object.assign(health, { failStreak: 0, alerted: false, lastOkTs: now });
  } else {
    health.failStreak = prev.failStreak + 1;
    if (health.failStreak >= FAIL_ALERT_STREAK && !prev.alerted) {
      alerts.push(alert(`${m.id} · Fallos seguidos`, `${health.failStreak} ciclos seguidos con errores. Último: ${status.errors.join(' | ').slice(0, 300)}`, 4, ['warning']));
      health.alerted = true;
    }
  }

  if (prev.lastDaily !== day) {
    health.lastDaily = day;
    const since = now - 86_400_000;
    const [book, trades] = await Promise.all([
      getKv<Portfolio>(db, bookKey(s.mode, m)),
      db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(realized_pnl_usd), 0) AS pnl FROM trades WHERE mode = ? AND symbol = ? AND ts >= ? AND status IN ('CONFIRMADA', 'SIMULADA')").bind(s.mode === 'live' ? 'LIVE' : 'PAPER', m.id, since).first<{ n: number; pnl: number }>(),
    ]);
    const price = status.prices[m.id]?.usd;
    const holdings = s.mode === 'live' ? status.onchain && { usdc: status.onchain.USDC, units: baseOf(status.onchain) } : book;
    const value = holdings && price ? holdings.usdc + holdings.units * price : null;
    const pnl = value !== null && book ? value - book.seedValueUsd : null;
    alerts.push(alert(`Resumen diario · ${m.id}`, [
      `Modo ${s.mode.toUpperCase()} · valor ${value?.toFixed(2) ?? '—'} USD${pnl !== null ? ` (${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} desde el inicio)` : ''}`,
      `Últimas 24 h: ${trades?.n ?? 0} operaciones · P/L realizado ${(trades?.pnl ?? 0).toFixed(3)} USD`,
      `${m.id} ${price?.toPrecision(5) ?? '—'} USD · ciclos ${status.ok ? 'OK' : 'con errores'}`,
    ].join('\n'), 2, ['bar_chart']));
    writes.push(db.prepare('DELETE FROM decisions WHERE ts < ?').bind(now - DECISIONS_RETENTION_DAYS * 86_400_000));
  }
  writes.push(putKv(db, kvKey(m, 'health'), health, now));
}
