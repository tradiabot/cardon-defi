import { type Env } from './config';
import { getKv, putKv } from './db';
import { DEFAULT_MARKET, enabledMarkets, kvKey, market, marketConfig, MARKETS, updateMarket, VENUES, type Market, type Venue } from './markets';
import { baseOf } from './venues';
import { loadAi, testModels, updateAiConfig } from './aiConfig';
import { callModel, extractJson, modelLabel } from './providers';
import { runCycle, type Control, type CycleStatus } from './engine';
import { flushPending, notePending, type ArregloStats } from './comunidad';

/**
 * «Médico» del bot: revisa cada mercado activo, clasifica sus errores y aplica arreglos de una lista cerrada.
 * La IA solo explica y elige entre esos arreglos; nunca ejecuta otra cosa. Los arreglos «seguros» no cambian
 * dinero ni modos (repetir un ciclo, reordenar modelos de IA); los demás piden confirmación en la app.
 */
export type Level = 'rojo' | 'amarillo';
export type FixId = 'ciclo' | 'ia_todos' | 'simulacion' | 'reanudar';
export interface Finding { market: string | null; level: Level; code: string; detail: string; fixes: FixId[] }
export interface DoctorEntry { ts: number; auto: boolean; fix: FixId; market: string | null; ok: boolean; result: string }

export const FIXES: Record<FixId, { text: string; safe: boolean }> = {
  ciclo: { text: 'Repetir el ciclo del mercado ahora', safe: true },
  ia_todos: { text: 'Probar todos los modelos de IA y poner primero a los que respondan', safe: true },
  simulacion: { text: 'Pasar el mercado a simulación', safe: false },
  reanudar: { text: 'Reanudar el bot', safe: false },
};

const STALE_MS = 15 * 60_000;
const AUTO_EVERY_MS = 30 * 60_000;
const LOG_KEEP = 20;
const GONE = /HTTP 404|does not exist|not found|decommissioned|no longer supported/i;
const GAS: Record<Venue, string> = { polygon: 'POL', hub: 'DOT', hydration: 'HDX' };

/** Errores de un ciclo → hallazgos. Pura, para poder probarla. */
export function classify(m: Market, cycle: CycleStatus | null, live: boolean, now: number, minUsd = 1): Finding[] {
  const out: Finding[] = [];
  const add = (level: Level, code: string, detail: string, fixes: FixId[]) => {
    if (!out.some(f => f.code === code)) out.push({ market: m.id, level, code, detail, fixes });
  };
  if (!cycle) {
    add('amarillo', 'sin_ciclos', 'Todavía no ha corrido ningún ciclo', ['ciclo']);
    return out;
  }
  if (now - cycle.ts > STALE_MS) add('rojo', 'atrasado', `Sin ciclos hace ${Math.round((now - cycle.ts) / 60_000)} min`, ['ciclo']);
  for (const e of cycle.errors) {
    if (/^precios:/.test(e)) add('rojo', 'precio', `No pudo leer el precio (${short(e)})`, ['ciclo']);
    else if (/^on-chain:|^cartera sin inicializar/.test(e)) add('rojo', 'onchain', `No pudo leer los saldos de la wallet (${short(e)})`, ['ciclo']);
    else if (/^IA:/.test(e)) add('amarillo', 'ia', `La IA falló (${short(e)})`, ['ia_todos']);
    else if (/^envío|^DEX:|^recibo:/.test(e)) add('rojo', 'dex', `Falló un intercambio en el DEX (${short(e)})`, live ? ['simulacion'] : []);
    else if (/^órdenes:/.test(e)) add('rojo', 'ordenes', `Falló la revisión de órdenes (${short(e)})`, ['ciclo']);
    else add('rojo', 'error', short(e), ['ciclo']);
  }
  const block = cycle.decision?.blockedBy;
  if (block === 'SIN_PRECIO') add('rojo', 'precio', 'Sin precio: la red no respondió', ['ciclo']);
  if (live && block === 'SIN_GAS') add('amarillo', 'gas', `Sin ${GAS[m.venue]} para pagar las comisiones en ${VENUES[m.venue].name}`, ['simulacion']);
  if (live && block === 'SIN_CLAVE') add('rojo', 'clave', 'Dinero real sin clave de firma en la nube', ['simulacion']);
  const b = cycle.onchain ?? cycle.onchainLast;
  const price = cycle.prices[m.id]?.usd ?? 0;
  if (live && b && price && b.USDC < minUsd && baseOf(b) * price < minUsd) {
    add('amarillo', 'sin_fondos', `En dinero real pero sin saldo: ${b.USDC.toFixed(2)} USDC y ${(baseOf(b) * price).toFixed(2)} USD en ${m.id} (${VENUES[m.venue].name})`, ['simulacion']);
  }
  return out;
}

const short = (e: string) => e.replace(/^[^:]+:\s*/, '').slice(0, 160);

export async function diagnose(env: Env, now = Date.now()): Promise<Finding[]> {
  const [markets, cfg, control] = await Promise.all([enabledMarkets(env), marketConfig(env), getKv<Control>(env.DB, 'control')]);
  const keys = markets.map(m => kvKey(m, 'status'));
  const rows = keys.length
    ? (await env.DB.prepare(`SELECT key, value FROM kv WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys).all<{ key: string; value: string }>()).results
    : [];
  const byKey = new Map(rows.map(r => [r.key, JSON.parse(r.value) as CycleStatus]));
  const out = markets.flatMap(m => classify(m, byKey.get(kvKey(m, 'status')) ?? null, cfg[m.id]?.mode === 'live', now));
  if (control?.paused) out.unshift({ market: null, level: 'amarillo', code: 'pausado', detail: `Bot en pausa: ${control.reason || 'manual'}`, fixes: ['reanudar'] });
  return out;
}

/** Ejecuta un arreglo de la lista cerrada. */
export async function applyFix(env: Env, fix: FixId, marketId: string | null, now = Date.now()): Promise<{ ok: boolean; result: string }> {
  const m = marketId ? market(marketId) : null;
  try {
    switch (fix) {
      case 'ciclo': {
        if (!m) return { ok: false, result: 'Falta el mercado' };
        const r = await runCycle(env, now, m, { lead: m.id === DEFAULT_MARKET });
        if ('skipped' in r) return { ok: true, result: `${m.id}: ya había un ciclo en curso` };
        return r.errors.length ? { ok: false, result: `${m.id}: el ciclo siguió con errores: ${r.errors.join(' | ').slice(0, 200)}` } : { ok: true, result: `${m.id}: ciclo repetido sin errores` };
      }
      case 'ia_todos': {
        const r = await testModels(env, m ?? MARKETS[DEFAULT_MARKET]);
        if ('error' in r) return { ok: false, result: `No se pudo probar la IA: ${r.error}` };
        const ok = r.results.filter(x => x.ok).sort((a, b) => Number(a.ms) - Number(b.ms)).map(x => String(x.model));
        // Un modelo que el proveedor ya no tiene (404 / «does not exist») no vuelve: se quita. Los que fallan por cupo o
        // lentitud quedan al final, porque el cupo se renueva.
        const gone = r.results.filter(x => !x.ok && GONE.test(String(x.error ?? ''))).map(x => String(x.model));
        const bad = r.results.filter(x => !x.ok && !gone.includes(String(x.model))).map(x => String(x.model));
        if (!ok.length) return { ok: false, result: `Ningún modelo respondió (${r.results.length} probados; suele ser cupo agotado, se renueva solo)` };
        const u = await updateAiConfig(env, { models: [...ok, ...bad] }, now);
        if ('error' in u) return { ok: false, result: u.error };
        return { ok: true, result: `${ok.length} de ${r.results.length} modelos responden; primero ${modelLabel(ok[0])}${gone.length ? `; quitados por no existir: ${gone.map(modelLabel).join(', ')}` : ''}` };
      }
      case 'simulacion': {
        if (!m) return { ok: false, result: 'Falta el mercado' };
        const u = await updateMarket(env, { market: m.id, mode: 'paper' }, now);
        return 'error' in u ? { ok: false, result: u.error } : { ok: true, result: `${m.id} pasa a simulación` };
      }
      case 'reanudar': {
        await putKv(env.DB, 'control', { paused: false, reason: '', changedAt: now } satisfies Control, now).run();
        return { ok: true, result: 'Bot reanudado' };
      }
    }
  } catch (error) {
    return { ok: false, result: (error as Error).message.slice(0, 200) };
  }
}

export async function doctorLog(env: Env): Promise<DoctorEntry[]> {
  return (await getKv<DoctorEntry[]>(env.DB, 'doctor_log')) ?? [];
}

export async function record(env: Env, entries: DoctorEntry[], now: number): Promise<void> {
  if (!entries.length) return;
  const log = [...entries, ...(await doctorLog(env))].slice(0, LOG_KEEP);
  await putKv(env.DB, 'doctor_log', log, now).run();
}

/**
 * Autocorrección desde el reloj, como mucho cada 30 min: solo el arreglo seguro que no se resuelve solo
 * con el siguiente ciclo (reordenar la IA). Los errores de red se repiten solos cada 5 min.
 */
export async function autoDoctor(env: Env, now = Date.now()): Promise<void> {
  const last = await getKv<{ ts: number }>(env.DB, 'doctor_auto');
  if (last && now - last.ts < AUTO_EVERY_MS) return;
  const findings = await diagnose(env, now);
  const ia = findings.find(f => f.code === 'ia');
  await putKv(env.DB, 'doctor_auto', { ts: now }, now).run();
  await flushPending(env, findings, now);
  if (!ia) return;
  const r = await applyFix(env, 'ia_todos', ia.market, now);
  await record(env, [{ ts: now, auto: true, fix: 'ia_todos', market: ia.market, ...r }], now);
  await notePending(env, 'ia_todos', ia.market, [ia], r.ok, now);
}

const AI_SYSTEM = `Eres el asistente técnico de un bot de trading en DEX (Polygon y Polkadot) que corre en Cloudflare.
Recibes los problemas detectados y la lista CERRADA de arreglos disponibles. Explica en español, claro y breve, qué pasa y qué hacer.
Responde SOLO JSON: {"resumen":"1-2 frases","pasos":["paso concreto", "..."],"arreglos":["id de la lista"]}.
En "arreglos" pon solo ids de la lista recibida que de verdad ayuden; si ninguno ayuda (por ejemplo, falta depositar fondos), deja la lista vacía y dilo en los pasos.
Si recibes "comunidad", es lo que funcionó en otros agentes para cada código de error (agentesResueltos = cuántos agentes distintos lo resolvieron así); úsalo para ordenar, sin inventar arreglos fuera de la lista.
Nunca propongas mover fondos ni cambiar límites.`;

/** La IA explica los hallazgos y elige arreglos de la lista; se filtra a la lista recibida. */
export async function aiExplain(env: Env, findings: Finding[], now = Date.now(), comunidad: Record<string, ArregloStats[]> | null = null): Promise<{ model: string; resumen: string; pasos: string[]; arreglos: { fix: FixId; market: string | null }[] } | { error: string }> {
  if (!findings.length) return { error: 'No hay problemas que explicar' };
  const offered = findings.flatMap(f => f.fixes.map(fix => ({ id: `${fix}${f.market ? `:${f.market}` : ''}`, texto: `${FIXES[fix].text}${f.market ? ` (${f.market})` : ''}` })));
  const input = {
    problemas: findings.map(f => ({ mercado: f.market, nivel: f.level, codigo: f.code, detalle: f.detail })),
    arreglos: offered,
    ...(comunidad && Object.keys(comunidad).length ? { comunidad: Object.fromEntries(Object.entries(comunidad).map(([k, v]) => [k, v.map(({ arreglo, agentesResueltos, intentos }) => ({ arreglo, agentesResueltos, intentos }))])) } : {}),
  };
  const ai = await loadAi(env);
  const errors: string[] = [];
  for (const model of ai.models.slice(0, 4)) {
    try {
      const d = extractJson<{ resumen?: unknown; pasos?: unknown; arreglos?: unknown }>(await callModel(model, ai.keys, [{ role: 'system', content: AI_SYSTEM }, { role: 'user', content: JSON.stringify(input) }], { budget: 700, now }));
      const ids = new Set(offered.map(o => o.id));
      const picked = (Array.isArray(d.arreglos) ? d.arreglos : []).map(String).filter(id => ids.has(id));
      return {
        model: modelLabel(model),
        resumen: String(d.resumen ?? '').slice(0, 400),
        pasos: (Array.isArray(d.pasos) ? d.pasos : []).map(p => String(p).slice(0, 240)).slice(0, 6),
        arreglos: [...new Set(picked)].map(id => { const [fix, mk] = id.split(':'); return { fix: fix as FixId, market: mk ?? null }; }),
      };
    } catch (error) {
      errors.push(`${modelLabel(model)}: ${(error as Error).message.slice(0, 80)}`);
    }
  }
  return { error: `Ninguna IA respondió (${errors.join(' · ') || 'sin modelos'})` };
}

/** Resumen corto para /api/health (lo lee el servicio de la app para avisar). */
export async function healthIssues(env: Env, now = Date.now()): Promise<{ market: string | null; level: Level; code: string; detail: string }[]> {
  return (await diagnose(env, now)).map(({ fixes: _, ...f }) => f);
}
