import { autoDoctor } from './doctor';
import type { Env } from './config';
import { putKv } from './db';
import { runCycle } from './engine';
import { DEFAULT_MARKET, enabledMarkets, kvKey, type Market } from './markets';

const SUB_CYCLE_TIMEOUT_MS = 120_000;
export const TICK_MS = 5 * 60_000;
export const SUB_CYCLE_CONCURRENCY = 4;

/** Ejecuta `run` sobre cada elemento con como mucho `width` a la vez. */
export async function pool<T>(items: T[], width: number, run: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await run(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, width), items.length) }, worker));
}

/** Unos segundos después del múltiplo de 5 min, como hacía el cron. */
const TICK_OFFSET_MS = 20_000;
/** Un mercado no repite ciclo antes de este tiempo: el reloj y el cron pueden coincidir o llegar duplicados. */
export const MIN_GAP_MS = 4 * 60_000;

/** Próximo instante de ciclo, al menos a 30 s de distancia. */
export function nextTick(now: number): number {
  let t = Math.floor(now / TICK_MS) * TICK_MS + TICK_OFFSET_MS;
  while (t < now + 30_000) t += TICK_MS;
  return t;
}

/**
 * El reloj propio (Durable Object con alarma) marca los ciclos; el cron de Cloudflare queda de respaldo.
 * El 10-10-2026 el cron de toda la cuenta empezó a dispararse cada ~14 min y en ráfagas: no basta por sí solo.
 */
export async function armClock(env: Env): Promise<string> {
  if (!env.CLOCK) return 'sin reloj';
  try {
    const res = await env.CLOCK.get(env.CLOCK.idFromName('main')).fetch('https://clock/arm');
    return await res.text();
  } catch (error) {
    console.error('reloj', error);
    return `reloj: ${(error as Error).message}`;
  }
}

/**
 * Un ciclo por mercado activo que lo tenga pendiente. El primero corre aquí; los demás, cada uno en su
 * propia invocación (vía el binding SELF) para no compartir el límite de subpeticiones del plan gratuito.
 */
export async function runAll(env: Env, now = Date.now(), source = 'manual'): Promise<void> {
  const enabled = await enabledMarkets(env);
  if (!enabled.length) return;
  const { results } = await env.DB.prepare("SELECT key, updated_at FROM kv WHERE key = 'status' OR key LIKE 'status:%'").all<{ key: string; updated_at: number }>();
  const last = new Map(results.map(r => [r.key, r.updated_at]));
  const markets = enabled.filter(m => now - (last.get(kvKey(m, 'status')) ?? 0) >= MIN_GAP_MS);
  const timings: Record<string, unknown> = {};
  for (const m of enabled) if (!markets.includes(m)) timings[m.id] = { skipped: 'reciente' };
  const started = Date.now();
  if (markets.length) {
    const lead = markets.find(m => m.id === DEFAULT_MARKET) ?? markets[0];
    const trackDot = !enabled.some(m => m.id === 'DOT');
    const log = (m: Market, r: Awaited<ReturnType<typeof runCycle>> | { error: string }) => console.log('ciclo', m.id, JSON.stringify('skipped' in r || 'error' in r ? r : { ok: r.ok, errors: r.errors, final: r.decision?.final }));
    // Un Worker gratuito tiene 6 conexiones abiertas a la vez: con muchos mercados, los subciclos por SELF las ocupaban
    // y el ciclo principal esperaba. El principal corre aquí y los demás van de SUB_CYCLE_CONCURRENCY en SUB_CYCLE_CONCURRENCY.
    const one = async (m: Market) => {
      const t = Date.now();
      try {
        if (m.id === lead.id || !env.SELF || !env.ADMIN_TOKEN) {
          const r = await runCycle(env, now, m, { lead: m.id === DEFAULT_MARKET || (m.id === lead.id && !enabled.some(x => x.id === DEFAULT_MARKET)), trackDot });
          log(m, r);
          timings[m.id] = { ms: Date.now() - t, how: 'aquí', ...('skipped' in r ? { skipped: r.skipped } : {}) };
          return;
        }
        const res = await env.SELF.fetch(`https://dex-pilot.internal/api/admin/run?market=${m.id}&dot=${trackDot ? 1 : 0}`, { method: 'POST', headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` }, signal: AbortSignal.timeout(SUB_CYCLE_TIMEOUT_MS) });
        console.log('ciclo', m.id, res.status, (await res.text()).slice(0, 200));
        timings[m.id] = { ms: Date.now() - t, how: 'SELF', status: res.status };
      } catch (error) {
        log(m, { error: (error as Error).message });
        timings[m.id] = { ms: Date.now() - t, error: (error as Error).message.slice(0, 120) };
      }
    };
    await Promise.all([one(lead), pool(markets.filter(m => m.id !== lead.id), SUB_CYCLE_CONCURRENCY, one)]);
  }
  // Registro del último reparto, para diagnosticar ciclos lentos o saltados.
  await putKv(env.DB, source === 'cron' ? 'cron_log' : 'tick_log', { at: new Date(now).toISOString(), source, totalMs: Date.now() - started, timings }, now).run();
  try {
    await autoDoctor(env, now);
  } catch (error) {
    console.log('médico', (error as Error).message);
  }
}
