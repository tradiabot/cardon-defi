import { type Env } from './config';
import { getKv, putKv } from './db';

/**
 * Cardón Comunidad (opcional, apagado por defecto): el agente comparte qué arreglo probó para qué error y si
 * se resolvió, con un id aleatorio propio. Nunca wallet, saldos, montos, transacciones ni claves. A cambio
 * consulta qué arreglos funcionaron en otros agentes.
 */
export const HUB = 'https://cardon-comunidad.pages.dev';
export const AGENT_VERSION = '1.0.7';
const SETTLE_MS = 10 * 60_000;
const DROP_MS = 86_400_000;
const PEND_KEEP = 20;

export interface Comunidad { on: boolean; agente: string }
export interface Pending { fix: string; market: string | null; codes: string[]; ok: boolean; ts: number }
export interface ArregloStats { arreglo: string; agentes: number; intentos: number; resueltos: number; agentesResueltos: number; recomendado: boolean }
type Finding = { market: string | null; code: string; fixes: string[] };

const hub = (env: Env) => (env.COMUNIDAD_URL || HUB).replace(/\/+$/, '');

export async function getComunidad(env: Env): Promise<Comunidad> {
  return (await getKv<Comunidad>(env.DB, 'comunidad')) ?? { on: false, agente: '' };
}

export async function setComunidad(env: Env, on: boolean, now: number): Promise<Comunidad> {
  const cur = await getComunidad(env);
  const agente = cur.agente || [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  const next = { on, agente };
  await env.DB.batch([putKv(env.DB, 'comunidad', next, now), ...(on ? [] : [putKv(env.DB, 'comunidad_pend', [], now)])]);
  return next;
}

/** Anota un arreglo aplicado; se reporta cuando el siguiente diagnóstico dice si el error se fue. */
export async function notePending(env: Env, fix: string, market: string | null, before: Finding[], ok: boolean, now: number): Promise<void> {
  const c = await getComunidad(env);
  if (!c.on) return;
  const codes = before.filter(f => f.market === market && f.fixes.includes(fix)).map(f => f.code);
  if (!codes.length) return;
  const pend = (await getKv<Pending[]>(env.DB, 'comunidad_pend')) ?? [];
  await putKv(env.DB, 'comunidad_pend', [{ fix, market, codes, ok, ts: now }, ...pend].slice(0, PEND_KEEP), now).run();
}

/** Lo que nunca sale del agente: solo códigos y arreglos de la lista cerrada. Pura, para probarla. */
export function settle(pend: Pending[], findings: Finding[], now: number): { items: { codigo: string; arreglo: string; ok: boolean; resuelto: boolean }[]; keep: Pending[] } {
  const items: { codigo: string; arreglo: string; ok: boolean; resuelto: boolean }[] = [];
  const keep: Pending[] = [];
  for (const p of pend) {
    if (now - p.ts < SETTLE_MS) { keep.push(p); continue; }
    for (const code of p.codes) items.push({ codigo: code, arreglo: p.fix, ok: p.ok, resuelto: p.ok && !findings.some(f => f.market === p.market && f.code === code) });
  }
  return { items, keep };
}

export async function flushPending(env: Env, findings: Finding[], now: number, fetcher: typeof fetch = fetch): Promise<number> {
  const c = await getComunidad(env);
  const pend = (await getKv<Pending[]>(env.DB, 'comunidad_pend')) ?? [];
  if (!c.on || !pend.length) return 0;
  const { items, keep } = settle(pend, findings, now);
  if (!items.length) return 0;
  let sent = false;
  try {
    const r = await fetcher(`${hub(env)}/v1/reportes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agente: c.agente, version: AGENT_VERSION, items: items.slice(0, 20) }),
      signal: AbortSignal.timeout(5000),
    });
    sent = r.ok;
  } catch { /* sin red: se reintenta en la próxima revisión */ }
  const rest = sent ? keep : pend.filter(p => now - p.ts < DROP_MS);
  await putKv(env.DB, 'comunidad_pend', rest, now).run();
  return sent ? items.length : 0;
}

/** Qué arreglos funcionaron en otros agentes para estos errores (solo si la comunidad está activa). */
export async function communityStats(env: Env, codes: string[], fetcher: typeof fetch = fetch): Promise<Record<string, ArregloStats[]> | null> {
  const list = [...new Set(codes)].filter(c => /^[a-z_]{2,24}$/.test(c));
  if (!list.length) return {};
  try {
    const r = await fetcher(`${hub(env)}/v1/arreglos?codigos=${list.join(',')}`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    return ((await r.json()) as { arreglos?: Record<string, ArregloStats[]> }).arreglos ?? {};
  } catch {
    return null;
  }
}
