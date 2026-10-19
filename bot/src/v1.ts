import { aiExplain, applyFix, diagnose, doctorLog, FIXES, record, type FixId } from './doctor';
import { type Env, type Settings } from './config';
import { type Control, type CycleStatus } from './engine';
import { loadMarket, type MarketCtx } from './context';
import { applyLimits, LIMIT_RANGES, limitsEditable, saveLimits } from './limits';
import { DEFAULT_MARKET, enabledMarkets, market, marketConfig, MARKETS, MAX_ENABLED, updateMarket, VENUES, type Market } from './markets';
import { baseOf, venueQuote } from './venues';
import { getKv, putKv } from './db';
import { isAdmin, login, loginChallenge, logout } from './auth';
import { loadAi, publicAiConfig, testModels, updateAiConfig, type AiConfigUpdate } from './aiConfig';
import { chat } from './chat';
import { fetchMacro, type Macro } from './macro';
import { modelLabel } from './providers';
import { buyGuard } from './strategy';
import { chainStatusV1, readAddressV1 } from './chain';
import type { Portfolio } from './paper';
import { cancelOrder, createUserOrder, editOrder, listOrders } from './orderApi';
import type { Order } from './orders';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};
const HEADERS = { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const CYCLE_SECONDS = 300;
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function clean<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/[&<>"'`]/g, c => ESC[c]) as T;
  if (Array.isArray(value)) return value.map(clean) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)])) as T;
  return value;
}

const reply = (data: unknown, status = 200) => new Response(JSON.stringify(clean(data)), { status, headers: HEADERS });
export const fail = (error: string, status = 400) => reply({ error }, status);

export const corsPreflight = () => new Response(null, { status: 204, headers: CORS });

interface Ctx {
  env: Env;
  m: Market;
  s: Settings;
  cycle: CycleStatus | null;
  control: Control;
  book: Portfolio | null;
  enabled: boolean;
}

const READONLY_TTL_MS = 60_000;
const HUB_TTL_MS = 5 * 60_000;
const memo = new Map<string, { until: number; value: Promise<unknown> }>();

function cached<T>(key: string, ttl: number, compute: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && hit.until > Date.now()) return hit.value as Promise<T>;
  const value = compute().catch(error => {
    memo.delete(key);
    throw error;
  });
  memo.set(key, { until: Date.now() + ttl, value });
  if (memo.size > 200) memo.delete(memo.keys().next().value as string);
  return value;
}

async function chainStatus(c: Ctx) {
  const fresh = c.cycle?.onchain;
  const last = c.cycle?.onchainLast;
  const polygon = fresh
    ? { name: 'Polygon PoS', status: 'ONLINE' }
    : { name: 'Polygon PoS', status: 'ERROR', error: last ? `sin lectura en el último ciclo; último saldo hace ${Math.round((Date.now() - last.ts) / 60_000)} min` : 'sin lectura' };
  const hub = await cached('hub-status', HUB_TTL_MS, async () => (await chainStatusV1([])).chains[1]).catch(() => ({ name: 'Polkadot Hub', status: 'ERROR' }));
  return { chains: [polygon, hub] };
}

const NO_CONTROL: Control = { paused: false, reason: '', changedAt: 0 };

async function load(env: Env, m: Market): Promise<Ctx> {
  const [mc, control] = await Promise.all([loadMarket(env, m), getKv<Control>(env.DB, 'control')]);
  return { env, m, s: mc.s, cycle: mc.cycle, control: control ?? NO_CONTROL, book: mc.book, enabled: mc.enabled };
}

type Held = Pick<MarketCtx, 'm' | 's' | 'cycle' | 'book'>;

/** `pol` es la cantidad de la moneda del mercado (el nombre viene de cuando solo existía POL). */
function holdings(c: Held) {
  const price = c.cycle?.prices?.[c.m.id]?.usd ?? 0;
  const live = c.s.mode === 'live';
  const chain = c.cycle?.onchain ?? c.cycle?.onchainLast ?? null;
  const usdc = live ? chain?.USDC ?? 0 : c.book?.usdc ?? 0;
  const pol = live ? baseOf(chain) : c.book?.units ?? 0;
  return { price, usdc, pol, value: usdc + pol * price };
}

/** Saldos de todos los mercados activos. El USDC se muestra por red (Polygon y Hydration son carteras distintas). */
async function assets(c: Ctx) {
  const all = await Promise.all((await enabledMarkets(c.env)).map(m => (m.id === c.m.id ? c : loadMarket(c.env, m))));
  const out: Record<string, unknown> = {};
  const usdcByVenue = new Map<string, number>();
  for (const x of all) {
    const h = holdings(x);
    usdcByVenue.set(x.s.mode === 'live' ? x.m.venue : `${x.m.id} (simulación)`, h.usdc);
    out[x.m.id] = { symbol: x.m.id, venue: VENUES[x.m.venue].name, mode: x.s.mode, available: h.pol, total: h.pol, avgCost: x.book?.avgCostUsd ?? 0, valueUsd: h.pol * h.price };
  }
  const own = holdings(c);
  out.USDC = { symbol: 'USDC', available: own.usdc, total: own.usdc, avgCost: 0, valueUsd: own.usdc };
  if (!out.POL) out.POL = { symbol: 'POL', available: 0, total: 0, avgCost: 0, valueUsd: 0 };
  if (!out.DOT) out.DOT = { symbol: 'DOT', available: 0, total: 0, avgCost: 0, valueUsd: 0 };
  return out;
}

/** Cambio 24 h: CoinGecko suele dar 429 desde Cloudflare, así que se usa el calculado con nuestras muestras. */
function change24h(c: Held): number {
  return c.cycle?.prices?.[c.m.id]?.change24h ?? c.cycle?.features?.change24h ?? 0;
}

/** Plan de IA vigente y su estado: LIVE (consultada ahora), VIGENTE (plan reciente reutilizado) o SIN RESPUESTA. */
function aiState(c: Held) {
  const plan = c.cycle?.aiPlan ?? (c.cycle?.decision?.ai ? { decision: c.cycle.decision.ai, ts: c.cycle.ts, reused: false } : null);
  const ageMin = plan ? Math.round((Date.now() - plan.ts) / 60_000) : null;
  const fresh = plan !== null && ageMin! <= 45;
  const label = !plan || !fresh ? 'SIN RESPUESTA' : plan.reused ? `PLAN VIGENTE · hace ${ageMin} min` : 'LIVE';
  return { ai: fresh ? plan!.decision : null, label, ageMin };
}

function botPnl(b: Portfolio | null, price: number): number {
  return b ? b.realizedPnlUsd + (b.units > 0 && b.avgCostUsd > 0 && price > 0 ? b.units * (price - b.avgCostUsd) : 0) : 0;
}

/**
 * Vista global: todo lo que hay en la wallet entre todas las redes y el resultado del bot sumado.
 * El USDC se cuenta una vez por red (varios mercados de Polygon comparten el mismo). La simulación va aparte:
 * su dinero es ficticio y no se mezcla con el total real.
 */
async function portfolio(env: Env, control: Control) {
  const all = await Promise.all((await enabledMarkets(env)).map(m => loadMarket(env, m)));
  const usdcByVenue = new Map<string, number>();
  const real = { coinsUsd: 0, pnlUsd: 0, realizedUsd: 0 };
  const sim = { valueUsd: 0, pnlUsd: 0, markets: 0 };
  const now = Date.now();
  const rows = all.map(x => {
    const h = holdings(x);
    const live = x.s.mode === 'live';
    const pnl = botPnl(x.book, h.price);
    if (live) {
      usdcByVenue.set(x.m.venue, h.usdc);
      real.coinsUsd += h.pol * h.price;
      real.pnlUsd += pnl;
      real.realizedUsd += x.book?.realizedPnlUsd ?? 0;
    } else {
      sim.valueUsd += h.value;
      sim.pnlUsd += pnl;
      sim.markets++;
    }
    const ageMin = x.cycle ? Math.round((now - x.cycle.ts) / 60_000) : null;
    return {
      id: x.m.id, name: x.m.name, venue: x.m.venue, venueName: VENUES[x.m.venue].name, mode: x.s.mode, price: h.price, balance: h.pol,
      valueUsd: Number((h.pol * h.price).toFixed(2)), pnlUsd: Number(pnl.toFixed(2)), activeOrders: x.cycle?.orders?.active ?? 0,
      lastCycleMinutes: ageMin, state: !x.cycle ? 'ESPERANDO' : ageMin! > 15 ? 'DETENIDO' : x.cycle.errors.length ? 'CON ERRORES' : 'OK',
      action: x.cycle?.decision?.final ?? 'HOLD', blockedBy: x.cycle?.decision?.blockedBy ?? null,
    };
  });
  const usdc = [...usdcByVenue].map(([venue, amount]) => ({ venue, venueName: VENUES[venue as keyof typeof VENUES].name, amount: Number(amount.toFixed(2)) }));
  const usdcTotal = usdc.reduce((sum, u) => sum + u.amount, 0);
  const value = usdcTotal + real.coinsUsd;
  const base = value - real.pnlUsd;
  return {
    paused: control.paused,
    real: {
      valueUsd: Number(value.toFixed(2)), usdcUsd: Number(usdcTotal.toFixed(2)), coinsUsd: Number(real.coinsUsd.toFixed(2)), usdc,
      pnlUsd: Number(real.pnlUsd.toFixed(2)), pnlPct: base > 0 ? Number(((real.pnlUsd / base) * 100).toFixed(2)) : 0, realizedUsd: Number(real.realizedUsd.toFixed(2)),
      markets: rows.filter(x => x.mode === 'live').length,
    },
    simulation: { valueUsd: Number(sim.valueUsd.toFixed(2)), pnlUsd: Number(sim.pnlUsd.toFixed(2)), markets: sim.markets },
    markets: rows,
  };
}

function status(c: Ctx) {
  const h = holdings(c);
  const change = change24h(c);
  const polValue = h.pol * h.price;
  const pnl1d = change ? polValue - polValue / (1 + change / 100) : 0;
  const seed = c.book?.seedValueUsd ?? 0;
  // Resultado del bot en este mercado: lo ya cerrado en ventas más lo que vale de más (o de menos) lo que tiene comprado.
  // No depende del saldo total, así que un depósito o lo que gasten otros mercados no lo altera.
  const pnlTotal = botPnl(c.book, h.price);
  const { ai, label } = aiState(c);
  const age = c.cycle ? (Date.now() - c.cycle.ts) / 1000 : Infinity;
  const live = c.s.mode === 'live';
  return {
    online: true,
    source: 'dex-pilot-cloudflare',
    market: c.m.id,
    market_venue: VENUES[c.m.venue].name,
    market_enabled: c.enabled,
    market_mode: c.s.mode,
    mode: 'auto',
    runner: c.control.paused ? 'PAUSED' : age > 900 ? 'STALLED' : 'RUNNING',
    emergency_stop: c.control.paused,
    pause_reason: c.control.reason,
    heartbeat: c.cycle?.ok ? 'ok' : c.cycle ? 'errores' : 'sin ciclos',
    ai_status: ai ? 'live' : 'fallback',
    ai: { status: label, mode: ai?.model?.startsWith('consenso:') ? 'consenso' : 'una IA', model: ai?.model ? (ai.model.startsWith('consenso:') ? `Consenso · ${ai.votes?.filter(v => v.ok).length ?? 0}/${ai.votes?.length ?? 0} IAs` : modelLabel(ai.model)) : '--', latencyMs: c.cycle?.durationMs ?? null },
    active_policy: 'dex_pilot_confluence',
    portfolio_value_usd: Number(h.value.toFixed(2)),
    pnl_1d_usd: Number(pnl1d.toFixed(2)),
    pnl_1d_pct: h.value ? Number(((pnl1d / h.value) * 100).toFixed(2)) : 0,
    // Resultado desde que arrancó el bot (valor actual − valor al empezar) y ganancia/pérdida ya cerrada en ventas.
    pnl_total_usd: Number(pnlTotal.toFixed(2)),
    pnl_total_pct: seed > 0 ? Number(((pnlTotal / seed) * 100).toFixed(2)) : 0,
    pnl_realized_usd: Number((c.book?.realizedPnlUsd ?? 0).toFixed(2)),
    pnl_since: c.book?.seededAt ? new Date(c.book.seededAt).toISOString() : null,
    cycle_seconds: CYCLE_SECONDS,
    next_cycle_seconds: c.cycle ? Math.max(0, Math.round(CYCLE_SECONDS - age)) : CYCLE_SECONDS,
    real_readonly: true,
    real_execution: live && Boolean(c.env.WALLET_PRIVATE_KEY),
    execution_status: live ? 'REAL · CLOUDFLARE' : 'PAPER · CLOUDFLARE',
    last_errors: c.cycle?.errors ?? [],
    balances_age_minutes: (() => { const t = (c.cycle?.onchain ?? c.cycle?.onchainLast)?.ts; return t ? Math.round((Date.now() - t) / 60_000) : null; })(),
    cycle_sell_floor: c.cycle?.orders?.sellFloor ?? null,
    active_orders: c.cycle?.orders?.active ?? 0,
  };
}

async function trend(env: Env, symbol: string, days: number, price: number): Promise<string> {
  const row = await env.DB.prepare('SELECT usd FROM prices WHERE symbol = ? AND ts >= ? ORDER BY ts LIMIT 1').bind(symbol, Date.now() - days * 86_400_000).first<{ usd: number }>();
  if (!row || !price) return 'N/D';
  const pct = ((price - row.usd) / row.usd) * 100;
  return pct > 0.5 ? 'UP' : pct < -0.5 ? 'DOWN' : 'FLAT';
}

const RANGES: Record<string, number> = { live: 2, '1h': 1, '1d': 24, '1w': 168, '1m': 168 };
const MAX_POINTS = 300;

async function history(env: Env, url: URL) {
  const symbol = market(url.searchParams.get('symbol'))?.id ?? DEFAULT_MARKET;
  const hours = RANGES[url.searchParams.get('range') ?? 'live'] ?? 2;
  const { results } = await env.DB.prepare('SELECT ts, usd FROM prices WHERE symbol = ? AND ts >= ? ORDER BY ts').bind(symbol, Date.now() - hours * 3_600_000).all<{ ts: number; usd: number }>();
  const step = Math.max(1, Math.ceil(results.length / MAX_POINTS));
  const points = results.filter((_, i) => i % step === 0 || i === results.length - 1).map(p => ({ timestamp: new Date(p.ts).toISOString(), price: p.usd }));
  return { symbol, range: url.searchParams.get('range'), points, source: 'DEX Pilot · muestras cada 5 min' };
}

const BRAKES: Record<string, string> = {
  RIESGO_GLOBAL: 'freno de compras: el panorama global marca aversión al riesgo',
  CAIDA_ACTIVA: 'freno de compras: esperando a que el precio deje de caer',
};

function signal(c: Held) {
  const d = c.cycle?.decision;
  const { ai, label } = aiState(c);
  return {
      symbol: c.m.id, source: ai?.model ?? 'técnico', action: d?.final ?? 'HOLD', confidence: Math.round(ai?.confidence ?? 0), risk: 'controlado',
      reason: d ? `${ai ? `${ai.reason} (IA ${label.toLowerCase()})` : 'IA sin respuesta'}${d.blockedBy ? ` · ${BRAKES[d.blockedBy] ?? `bloqueo: ${d.blockedBy}`}` : ''} · técnico ${d.technical}` : 'Sin ciclos todavía',
  };
}

async function signals(c: Ctx) {
  const all = await Promise.all((await enabledMarkets(c.env)).map(m => (m.id === c.m.id ? c : loadMarket(c.env, m))));
  const out = all.map(signal);
  if (!all.some(x => x.m.id === 'DOT')) out.push({ symbol: 'DOT', source: 'seguimiento', action: 'HOLD', confidence: 0, risk: 'n/a', reason: 'DOT está apagado: actívalo en Mercados para operarlo en Hydration' });
  return out;
}

function v1Order(o: Order, trades: Map<number, Record<string, any>>) {
  const t = o.trade_id ? trades.get(o.trade_id) : undefined;
  return {
    id: o.id, side: o.side, symbol: o.symbol ?? DEFAULT_MARKET, triggerPrice: o.trigger_price, amountUsdc: o.size_usd, status: o.status,
    source: o.source, locked: Boolean(o.locked), reason: o.reason, note: o.note,
    updatedAt: new Date(o.updated_ts).toISOString(), expiresAt: o.expires_ts ? new Date(o.expires_ts).toISOString() : null,
    tradeId: o.trade_id, txHash: t?.tx_hash ?? null, editable: o.status === 'ACTIVA',
  };
}

/** Sin `m`: órdenes y operaciones de todos los mercados. */
async function orders(env: Env, m?: Market) {
  const [list, { results: trades }] = await Promise.all([
    listOrders(env, 40, m),
    (m ? env.DB.prepare('SELECT * FROM trades WHERE symbol = ? ORDER BY ts DESC LIMIT 30').bind(m.id) : env.DB.prepare('SELECT * FROM trades ORDER BY ts DESC LIMIT 30')).all<Record<string, any>>(),
  ]);
  const byId = new Map(trades.map(t => [t.id as number, t]));
  return {
    orders: list.map(o => v1Order(o, byId)),
    trades: trades.map(t => ({
      id: t.id, symbol: t.symbol, side: t.side, status: t.status, mode: t.mode, amountIn: t.amount_in, amountOut: t.amount_out,
      price: t.price_usd, pnl: t.realized_pnl_usd, gasUsd: t.gas_usd, costPct: t.cost_pct, txHash: t.tx_hash,
      orderId: t.order_id ?? null, reason: t.reason, error: t.error, at: new Date(t.ts).toISOString(),
    })),
  };
}

async function logs(env: Env) {
  const { results } = await env.DB.prepare('SELECT ts, symbol, technical, ai_action, ai_confidence, ai_model, ai_reason, ai_error, final, blocked_by FROM decisions ORDER BY ts DESC LIMIT 60').all<Record<string, any>>();
  return results.map(d => ({
    timestamp: new Date(d.ts).toLocaleString('es', { timeZone: 'UTC' }) + ' UTC',
    symbol: d.symbol,
    action: d.final + (d.blocked_by ? ` · ${d.blocked_by}` : ''),
    reason: `${d.ai_reason ?? d.ai_error ?? 'sin IA'} · IA ${d.ai_action ?? '—'} ${d.ai_confidence ?? ''}${d.ai_confidence != null ? '%' : ''} · técnico ${d.technical}`,
  }));
}

function config(s: Settings, env: Env) {
  const editable = limitsEditable(env);
  return {
    mode: 'auto', minConfidence: s.minConfidence, minReserveUsdc: s.minReserveUsdc, minNetProfitUsdc: s.minProfitPct,
    targetUsdc: 50, targetPol: 50, targetDot: 0, maxTradeUsdc: s.maxTradeUsdc, maxTradesPerDay: s.maxTradesPerDay,
    editable, ranges: editable ? LIMIT_RANGES : undefined,
    note: editable ? 'Tus límites se aplican en tu nube desde el siguiente ciclo' : 'Los límites del bot se cambian en wrangler.toml',
  };
}

async function setControl(env: Env, paused: boolean, reason: string) {
  const now = Date.now();
  const control: Control = { paused, reason, changedAt: now };
  await putKv(env.DB, 'control', control, now).run();
  return control;
}

const ADMIN = new Set(['/orders', '/markets', '/control/activate', '/control/pause', '/emergency-stop', '/execution/authorize', '/execution/auto-session/create', '/execution/auto-session/close', '/policies/activate', '/config']);

export async function handleV1(request: Request, env: Env, path: string, url: URL): Promise<Response> {
  const method = request.method;
  // Todo POST de IA o contexto gasta cupo de IA o cambia claves: solo con token de administrador.
  const needsAdmin = method === 'POST' && (ADMIN.has(path) || path.startsWith('/control/') || path.startsWith('/orders/') || path.startsWith('/ai/') || path.startsWith('/macro/') || path.startsWith('/doctor/'));
  if (needsAdmin) {
    if (!(await isAdmin(request, env))) return fail('Sesión no válida: inicia sesión en la pestaña Config', 401);
  }
  const body = method === 'POST' ? await request.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>)) : {};
  const asked = url.searchParams.get('market') ?? (typeof body.market === 'string' ? body.market : null);
  const m = market(asked);
  if (!m) return fail(`Mercado desconocido: ${asked}`);
  const c = await load(env, m);

  switch (`${method} ${path}`) {
    case 'GET /auth/challenge': return reply(await loginChallenge(env));
    case 'POST /auth/login': {
      const r = await login(env, body);
      return 'error' in r ? fail(r.error, r.status) : reply(r);
    }
    case 'GET /auth/session': return reply({ valid: await isAdmin(request, env), wallet: c.s.wallet });
    case 'POST /auth/logout': return reply({ closed: await logout(request, env) });
    case 'GET /status': return reply(status(c));
    case 'GET /portfolio': return reply(await portfolio(env, c.control));
    case 'GET /assets': return reply({ assets: await assets(c) });
    case 'GET /market': {
      const out: Record<string, unknown> = {};
      const all = await Promise.all((await enabledMarkets(env)).map(x => (x.id === m.id ? c : loadMarket(env, x))));
      const row = async (sym: string, p: { usd: number; change24h: number | null; source: string } | undefined, own: number | null | undefined) => {
        out[sym] = { price: p?.usd ?? 0, change24h: Number((p?.change24h ?? own ?? 0).toFixed(2)), trend1d: await trend(env, sym, 1, p?.usd ?? 0), trend7d: await trend(env, sym, 7, p?.usd ?? 0), source: p?.source ?? 'sin dato' };
      };
      for (const x of all) await row(x.m.id, x.cycle?.prices?.[x.m.id], x.cycle?.features?.change24h);
      // DOT apagado: se sigue su precio de referencia desde el ciclo de POL, como antes.
      for (const sym of ['POL', 'DOT']) if (!out[sym]) await row(sym, all.find(x => x.m.id === DEFAULT_MARKET)?.cycle?.prices?.[sym], null);
      return reply({ market: out });
    }
    case 'GET /market/history': return reply(await history(env, url));
    case 'GET /signals': return reply({ signals: await signals(c) });
    case 'GET /chain/status': return reply(await chainStatus(c));
    case 'GET /pilot/learning': return reply({ pending: [], outcomes: [] });
    case 'GET /orders': return reply(await orders(env, asked ? m : undefined));
    case 'GET /markets': {
      const cfg = await marketConfig(env);
      const all = await Promise.all(Object.values(MARKETS).map(x => (cfg[x.id].enabled ? (x.id === m.id ? c : loadMarket(env, x)) : null)));
      return reply({
        selected: m.id, maxEnabled: MAX_ENABLED, wallet: c.s.wallet, signingKey: Boolean(env.WALLET_PRIVATE_KEY),
        markets: Object.values(MARKETS).map((x, i) => {
          const mc = all[i];
          const h = mc ? holdings(mc) : null;
          return {
            id: x.id, name: x.name, pair: `${x.id}/USDC`, venue: x.venue, venueName: VENUES[x.venue].name, enabled: cfg[x.id].enabled, mode: cfg[x.id].mode,
            modeLocked: x.id === DEFAULT_MARKET && env.MODE !== 'app', price: h?.price ?? null, balance: h?.pol ?? null, usdc: h?.usdc ?? null,
            lastCycleMinutes: mc?.cycle ? Math.round((Date.now() - mc.cycle.ts) / 60_000) : null, errors: mc?.cycle?.errors ?? [],
            blockedBy: mc?.cycle?.decision?.blockedBy ?? null,
          };
        }),
      });
    }
    case 'POST /markets': {
      const r = await updateMarket(env, body);
      return 'error' in r ? fail(r.error) : reply(r);
    }
    case 'POST /orders': {
      const r = await createUserOrder(env, body, m);
      return 'error' in r ? fail(r.error, r.status) : reply(r);
    }
    case 'GET /policies': return reply({ policies: [{ id: 'dex_pilot_confluence', label: 'DEX Pilot · IA + técnico', active: true, risk: 'bajo', kind: c.s.mode.toUpperCase(), assets: `${m.id}/USDC`, requiresApproval: false }] });
    case 'POST /policies/activate': return body.policy === 'dex_pilot_confluence' ? reply({ ok: true }) : fail('Perfil no disponible en DEX Pilot');
    case 'GET /logs': return reply({ logs: await logs(env) });
    case 'GET /config': return reply({ config: config(c.s, env) });
    case 'POST /config': {
      if (limitsEditable(env) && Object.keys(body).some(k => k in LIMIT_RANGES || k === 'minNetProfitUsdc')) {
        const r = await saveLimits(env, { ...body, minProfitPct: body.minProfitPct ?? body.minNetProfitUsdc });
        if ('error' in r) return fail(r.error);
        return reply({ config: config(applyLimits(c.s, r.limits), env) });
      }
      const cur = config(c.s, env);
      if (Object.keys(body).every(k => k === 'mode' || k === 'minReserveUsdc')) return reply({ config: cur });
      const changed = Object.entries(body).filter(([k, v]) => k in cur && (cur as Record<string, unknown>)[k] !== v && !['targetUsdc', 'targetPol', 'targetDot'].includes(k));
      if (changed.length) return fail(`No se puede cambiar ${changed.map(([k]) => k).join(', ')} desde la app: se cambia en wrangler.toml de DEX Pilot`);
      return reply({ config: cur });
    }
    case 'GET /wallet/status': {
      const h = holdings(c);
      return reply({ wallet: { address: c.s.wallet, assets: {
        [m.id]: { label: `${m.id} · ${VENUES[m.venue].name}`, network: m.venue, balance: h.pol, decimals: m.decimals },
        USDC: { label: `USDC · ${VENUES[m.venue].name}`, network: m.venue, balance: h.usdc, decimals: 6 },
      } } });
    }
    case 'GET /wallet/readonly': {
      const address = (url.searchParams.get('address') ?? '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) return fail('Dirección EVM inválida');
      return reply(await cached(`readonly:${address}`, READONLY_TTL_MS, () => readAddressV1(c.s.rpcs, address)));
    }
    case 'POST /wallet/sync': {
      const address = String(body.address ?? '');
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return fail('Dirección EVM inválida');
      if (address.toLowerCase() !== c.s.wallet.toLowerCase()) return fail(`La wallet del teléfono no es la del bot (${c.s.wallet})`);
      return reply({ assets: await assets(c) });
    }
    case 'POST /wallet/transfer/preview':
    case 'POST /wallet/transfer':
      return fail('Las transferencias se firman en el teléfono con la wallet nativa del APK');
    case 'GET /dex/quote': {
      const side = url.searchParams.get('asset_in') === 'USDC' ? 'BUY' : 'SELL';
      const amount = Number(url.searchParams.get('amount_in'));
      const slippage = Number(url.searchParams.get('slippage_bps') || 50);
      if (!(amount > 0)) return fail('Monto inválido');
      const price = c.cycle?.prices?.[m.id]?.usd ?? 0;
      if (m.venue !== 'polygon' && !(price > 0)) return fail(`Aún no hay precio de ${m.id}: actívalo y espera al primer ciclo`, 409);
      const q = await venueQuote(m, side, amount, c.s, price);
      return reply({ amount_out_display: q.amountOut, minimum_out_display: q.amountOut * (1 - slippage / 10_000), cost_pct: q.costPct, source: m.venue === 'polygon' ? 'Uniswap V3' : VENUES[m.venue].name });
    }
    case 'GET /execution/challenge':
      return reply({ message: `DEX Pilot · activar piloto · ${new Date().toISOString()} · ${crypto.randomUUID()}` });
    case 'POST /execution/authorize': return reply({ authorized: true, note: 'Autorizado por token de administrador' });
    case 'POST /control/activate': return reply({ control: await setControl(env, false, ''), runner: 'RUNNING' });
    case 'POST /execution/auto-session/create': return reply({ session: { id: 'cloudflare', indefinite: true, maxSwapsPerDay: c.s.maxTradesPerDay, maxSwapAmountUsdc: c.s.maxTradeUsdc } });
    case 'POST /execution/auto-session/close': return reply({ closed: true });
    case 'POST /control/pause': return reply({ control: await setControl(env, true, 'Pausa desde la app Android'), runner: 'PAUSED' });
    case 'GET /ai/config': return reply(await publicAiConfig(env));
    case 'POST /ai/config': {
      const r = await updateAiConfig(env, body as AiConfigUpdate);
      return 'error' in r ? fail(r.error) : reply(await publicAiConfig(env));
    }
    case 'POST /ai/test': {
      const r = await testModels(env, m);
      return 'error' in r ? fail(r.error, 409) : reply(r);
    }
    case 'POST /ai/chat': {
      const r = await chat(env, body);
      return 'error' in r ? fail(r.error) : reply(r);
    }
    case 'GET /ai/votes': {
      const plan = c.cycle?.aiPlan;
      const m = await getKv<Macro>(env.DB, 'macro');
      const f = c.cycle?.features;
      const brakeNow = c.cycle?.decision?.blockedBy && BRAKES[c.cycle.decision.blockedBy] ? c.cycle.decision.blockedBy
        : f ? buyGuard({ risk: m?.digest.risk ?? null, riskAgeMs: m ? Date.now() - m.ts : Infinity, change1h: f.change1h, price: f.price, last30m: [] }) : null;
      const d = plan?.decision;
      return reply({
        ts: plan ? new Date(plan.ts).toISOString() : null, reused: plan?.reused ?? null,
        decision: d ? { action: d.action, confidence: d.confidence, buyTrigger: d.buyTrigger, sellTrigger: d.sellTrigger, reason: d.reason, model: d.model } : null,
        votes: (d?.votes ?? []).map(v => ({ ...v, label: modelLabel(v.model) })),
        brake: brakeNow ? BRAKES[brakeNow] : null,
      });
    }
    case 'GET /macro': {
      const m = await getKv<Macro>(env.DB, 'macro');
      return reply({ macro: m ? { ...m, updatedAt: new Date(m.ts).toISOString(), ageMinutes: Math.round((Date.now() - m.ts) / 60_000) } : null });
    }
    case 'POST /macro/refresh': {
      const ai = await loadAi(env);
      const m = await fetchMacro(ai.keys, ai.models, (await getKv<Record<string, number>>(env.DB, 'ai_cooldown')) ?? {});
      await putKv(env.DB, 'macro', m, m.ts).run();
      return reply({ macro: { ...m, updatedAt: new Date(m.ts).toISOString(), ageMinutes: 0 } });
    }
    case 'GET /doctor': {
      const [findings, log] = await Promise.all([diagnose(env), doctorLog(env)]);
      return reply({ checkedAt: new Date().toISOString(), findings, fixes: FIXES, log });
    }
    case 'POST /doctor/fix': {
      const fix = String(body.fix ?? '') as FixId;
      if (!(fix in FIXES)) return fail(`Arreglo desconocido: ${fix}`);
      const target = typeof body.market === 'string' ? body.market : null;
      const now = Date.now();
      const r = await applyFix(env, fix, target, now);
      await record(env, [{ ts: now, auto: false, fix, market: target, ...r }], now);
      return reply(r);
    }
    case 'POST /doctor/ai': {
      const r = await aiExplain(env, await diagnose(env));
      return 'error' in r ? fail(r.error, 409) : reply(r);
    }
    case 'POST /emergency-stop': {
      const control = await setControl(env, true, 'EMERGENCY STOP desde la app Android');
      return reply({ control, runner: 'PAUSED', receipt: { id: `stop_${control.changedAt}` } });
    }
  }
  if (method === 'POST' && path.startsWith('/control/')) {
    const action = path.slice('/control/'.length);
    if (['start', 'resume', 'run'].includes(action)) return reply({ control: await setControl(env, false, ''), runner: 'RUNNING' });
    if (['stop', 'pause'].includes(action)) return reply({ control: await setControl(env, true, 'Pausa desde la app Android'), runner: 'PAUSED' });
  }
  const om = path.match(/^\/orders\/(\d+)\/(cancel|edit)$/);
  if (method === 'POST' && om) {
    const r = om[2] === 'cancel' ? await cancelOrder(env, Number(om[1])) : await editOrder(env, Number(om[1]), body);
    return 'error' in r ? fail(r.error, r.status) : reply(r);
  }
  return fail('Ruta no disponible en DEX Pilot', 404);
}
