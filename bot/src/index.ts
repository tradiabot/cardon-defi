import { healthIssues } from './doctor';
import { settings, type Env } from './config';
import { runCycle, type Control, type Health } from './engine';
import { loadMarket } from './context';
import { DEFAULT_MARKET, kvKey, market, type Market } from './markets';
import { baseOf } from './venues';
import { getKv, putKv } from './db';
import { isAdmin } from './auth';
import { corsPreflight, fail, handleV1 } from './v1';
import { cancelOrder, createUserOrder, editOrder, listOrders } from './orderApi';
import { loadAi, testModels } from './aiConfig';
import { armClock, runAll } from './scheduler';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function limitParam(url: URL, fallback: number, max: number): number {
  const n = Number(url.searchParams.get('limit') ?? fallback);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

async function status(env: Env, m: Market): Promise<Response> {
  const [{ s, cycle, book: portfolio, price: lastPrice }, control] = await Promise.all([loadMarket(env, m), getKv<Control>(env.DB, 'control')]);
  const price = lastPrice || null;
  const onchain = cycle?.onchain ?? cycle?.onchainLast;
  const holdings = s.mode === 'live' ? (onchain ? { usdc: onchain.USDC, units: baseOf(onchain) } : null) : portfolio;
  const value = holdings && price ? holdings.usdc + holdings.units * price : null;
  const paper = portfolio ? { ...portfolio, valueUsd: value, pnlUsd: value === null ? null : value - portfolio.seedValueUsd } : null;
  const pending = s.mode === 'live'
    ? await env.DB.prepare("SELECT id, side, status, tx_hash FROM trades WHERE mode = 'LIVE' AND symbol = ? AND status IN ('ENVIANDO', 'PENDIENTE') LIMIT 1").bind(m.id).first()
    : null;
  return json({
    market: m.id,
    mode: s.mode.toUpperCase(),
    signing: s.mode === 'live' && Boolean(env.WALLET_PRIVATE_KEY),
    pending,
    gasReservePol: s.gasReservePol,
    slippageBps: s.slippageBps,
    now: Date.now(),
    control: control ?? { paused: false, reason: '', changedAt: 0 },
    cycle,
    paper,
    ai: await (async () => { const a = await loadAi(env); return { configured: a.models.length > 0, models: a.models, consensus: a.consensus }; })(),
    admin: { configured: Boolean(env.ADMIN_TOKEN) },
    limits: {
      maxTradeUsdc: s.maxTradeUsdc, maxTradesPerDay: s.maxTradesPerDay, minConfidence: s.minConfidence,
      minReserveUsdc: s.minReserveUsdc, minProfitPct: s.minProfitPct, stopLossPct: s.stopLossPct,
      cooldownMinutes: s.cooldownMs / 60_000, maxCostPct: s.maxCostPct,
    },
    wallet: s.wallet,
  });
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case 'GET /api/status': {
      const m = market(url.searchParams.get('market'));
      return m ? status(env, m) : json({ error: 'MERCADO_DESCONOCIDO' }, 400);
    }
    case 'GET /api/clock': {
      const [tick, cron] = await Promise.all([getKv(env.DB, 'tick_log'), getKv(env.DB, 'cron_log')]);
      return json({ clock: await armClock(env), lastClockRun: tick, lastCronRun: cron });
    }
    case 'GET /api/health': {
      const [health, control] = await Promise.all([getKv<Health>(env.DB, 'health'), getKv<Control>(env.DB, 'control')]);
      const ageMin = health?.lastOkTs ? Math.round((Date.now() - health.lastOkTs) / 60_000) : null;
      const problems = [
        ageMin === null || ageMin > 15 ? `sin ciclo correcto hace ${ageMin ?? '∞'} min` : null,
        control?.paused ? `pausado: ${control.reason || 'manual'}` : null,
        (health?.failStreak ?? 0) >= 3 ? `${health!.failStreak} ciclos seguidos con errores` : null,
      ].filter(Boolean);
      // issues: hallazgos por mercado del «médico»; la app avisa con una notificación si un rojo dura más de un ciclo.
      const issues = await healthIssues(env).catch(() => []);
      return json({ ok: problems.length === 0, problems, issues, lastOkMinutesAgo: ageMin, failStreak: health?.failStreak ?? 0, mode: settings(env).mode }, problems.length ? 503 : 200);
    }
    case 'GET /api/orders':
      return json({ orders: await listOrders(env, limitParam(url, 40, 200)) });
    case 'GET /api/decisions': {
      const { results } = await env.DB.prepare('SELECT * FROM decisions ORDER BY ts DESC LIMIT ?').bind(limitParam(url, 30, 200)).all();
      return json({ decisions: results });
    }
    case 'GET /api/trades': {
      const { results } = await env.DB.prepare('SELECT * FROM trades ORDER BY ts DESC LIMIT ?').bind(limitParam(url, 50, 500)).all();
      return json({ trades: results });
    }
    case 'GET /api/prices': {
      const symbol = market(url.searchParams.get('symbol'))?.id ?? DEFAULT_MARKET;
      const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 24, 1), 168);
      const { results } = await env.DB.prepare('SELECT ts, usd FROM prices WHERE symbol = ? AND ts >= ? ORDER BY ts').bind(symbol, Date.now() - hours * 3_600_000).all();
      return json({ symbol, prices: results });
    }
  }

  if (request.method !== 'POST' || !url.pathname.startsWith('/api/admin/')) return json({ error: 'NO_ENCONTRADO' }, 404);
  if (!env.ADMIN_TOKEN) return json({ error: 'ADMIN_TOKEN_NO_CONFIGURADO' }, 503);
  if (!(await isAdmin(request, env))) return json({ error: 'NO_AUTORIZADO' }, 401);

  const now = Date.now();
  switch (url.pathname) {
    case '/api/admin/pause':
    case '/api/admin/resume': {
      const body = await request.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
      const control: Control = { paused: url.pathname.endsWith('pause'), reason: String(body.reason ?? '').slice(0, 120), changedAt: now };
      await putKv(env.DB, 'control', control, now).run();
      return json({ control });
    }
    case '/api/admin/run': {
      const m = market(url.searchParams.get('market'));
      if (!m) return json({ error: 'MERCADO_DESCONOCIDO' }, 400);
      return json(await runCycle(env, now, m, { lead: url.searchParams.get('lead') === '1' || m.id === DEFAULT_MARKET, trackDot: url.searchParams.get('dot') !== '0' }));
    }
    case '/api/admin/ai-test': {
      const r = await testModels(env);
      return 'error' in r ? json(r, 409) : json(r);
    }
    case '/api/admin/orders': {
      const r = await createUserOrder(env, await request.json<Record<string, unknown>>().catch(() => ({})));
      return 'error' in r ? json({ error: r.error }, r.status) : json(r);
    }
    case '/api/admin/reset-paper':
    {
      const m = market(url.searchParams.get('market'));
      if (!m) return json({ error: 'MERCADO_DESCONOCIDO' }, 400);
      if ((await loadMarket(env, m)).mode !== 'paper') return json({ error: 'SOLO_EN_MODO_PAPER' }, 409);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM kv WHERE key = ?').bind(kvKey(m, 'portfolio')),
        env.DB.prepare("DELETE FROM trades WHERE mode = 'PAPER' AND symbol = ?").bind(m.id),
        env.DB.prepare("UPDATE orders SET status = 'CANCELADA', note = 'Cartera de simulación reiniciada', updated_ts = ? WHERE symbol = ? AND status = 'ACTIVA'").bind(now, m.id),
      ]);
      return json({ reset: true, note: 'La cartera paper se reinicia con los saldos on-chain en el próximo ciclo' });
    }
  }
  const m = url.pathname.match(/^\/api\/admin\/orders\/(\d+)\/(edit|cancel)$/);
  if (m) {
    const id = Number(m[1]);
    const r = m[2] === 'cancel' ? await cancelOrder(env, id) : await editOrder(env, id, await request.json<Record<string, unknown>>().catch(() => ({})));
    return 'error' in r ? json({ error: r.error }, r.status) : json(r);
  }
  return json({ error: 'NO_ENCONTRADO' }, 404);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/v1/')) {
      if (request.method === 'OPTIONS') return corsPreflight();
      try {
        return await handleV1(request, env, url.pathname.slice('/api/v1'.length), url);
      } catch (error) {
        console.error('v1', error);
        return fail((error as Error).message, 500);
      }
    }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, url);
    } catch (error) {
      console.error('api', error);
      return json({ error: (error as Error).message }, 500);
    }
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    // El cron es el respaldo: se asegura de que el reloj propio siga armado y corre lo que esté pendiente.
    ctx.waitUntil(Promise.all([armClock(env), runAll(env, Date.now(), 'cron')]));
  },
} satisfies ExportedHandler<Env>;
