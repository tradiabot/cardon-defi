import { beforeEach, describe, expect, it } from 'vitest';
import { communityStats, flushPending, getComunidad, notePending, setComunidad, settle } from '../src/comunidad';
import type { Env } from '../src/config';

const NOW = 1_800_000_000_000;
let env: Env;
let sent: { url: string; body: any }[];
const fetcher = (async (url: string, init?: RequestInit) => {
  sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
  return new Response(JSON.stringify({ ok: true, arreglos: { ia: [{ arreglo: 'ia_todos', agentesResueltos: 4 }] } }));
}) as typeof fetch;
const ia = { market: 'POL', code: 'ia', fixes: ['ia_todos'] };

/** D1 mínima: solo la tabla kv que usa la comunidad. */
function kvDb() {
  const rows = new Map<string, string>();
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (rows.has(String(args[0])) ? { value: rows.get(String(args[0])) } : null),
    run: async () => { if (/^INSERT INTO kv/.test(sql)) rows.set(String(args[0]), String(args[1])); return { meta: { changes: 1 } }; },
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (list: { run(): Promise<unknown> }[]) => Promise.all(list.map(s => s.run())) };
}

beforeEach(() => {
  env = { DB: kvDb() } as never;
  sent = [];
});

describe('comunidad', () => {
  it('apagada por defecto: no anota ni envía nada', async () => {
    expect((await getComunidad(env)).on).toBe(false);
    await notePending(env, 'ia_todos', 'POL', [ia], true, NOW);
    expect(await flushPending(env, [], NOW + 3_600_000, fetcher)).toBe(0);
    expect(sent).toEqual([]);
  });

  it('activa: reporta solo código, arreglo y resultado, con un id aleatorio', async () => {
    const c = await setComunidad(env, true, NOW);
    expect(c.agente).toMatch(/^[a-f0-9]{32}$/);
    expect((await setComunidad(env, true, NOW)).agente).toBe(c.agente);
    await notePending(env, 'ia_todos', 'POL', [ia, { market: 'DOT', code: 'precio', fixes: ['ciclo'] }], true, NOW);
    expect(await flushPending(env, [], NOW + 60_000, fetcher)).toBe(0); // aún no se sabe si se resolvió
    expect(await flushPending(env, [], NOW + 11 * 60_000, fetcher)).toBe(1);
    expect(sent[0].url).toBe('https://cardon-comunidad.pages.dev/v1/reportes');
    expect(sent[0].body).toEqual({ agente: c.agente, version: expect.any(String), items: [{ codigo: 'ia', arreglo: 'ia_todos', ok: true, resuelto: true }] });
    expect(JSON.stringify(sent)).not.toMatch(/POL|wallet|0x/);
    expect(await flushPending(env, [], NOW + 12 * 60_000, fetcher)).toBe(0);
  });

  it('no resuelto si el error sigue en ese mercado', () => {
    const { items } = settle([{ fix: 'ciclo', market: 'DOT', codes: ['precio'], ok: true, ts: NOW }], [{ market: 'DOT', code: 'precio', fixes: ['ciclo'] }], NOW + 11 * 60_000);
    expect(items).toEqual([{ codigo: 'precio', arreglo: 'ciclo', ok: true, resuelto: false }]);
  });

  it('sin red guarda para reintentar; al apagar se borra lo pendiente', async () => {
    await setComunidad(env, true, NOW);
    await notePending(env, 'ia_todos', 'POL', [ia], true, NOW);
    const down = (async () => { throw new Error('offline'); }) as typeof fetch;
    expect(await flushPending(env, [], NOW + 11 * 60_000, down)).toBe(0);
    expect(await flushPending(env, [], NOW + 12 * 60_000, fetcher)).toBe(1);
    await notePending(env, 'ia_todos', 'POL', [ia], true, NOW);
    await setComunidad(env, false, NOW);
    expect(await flushPending(env, [], NOW + 3_600_000, fetcher)).toBe(0);
  });

  it('consulta estadísticas y tolera fallos', async () => {
    expect((await communityStats(env, ['ia', 'ia', 'x y'], fetcher))!.ia[0].agentesResueltos).toBe(4);
    expect(sent[0].url).toBe('https://cardon-comunidad.pages.dev/v1/arreglos?codigos=ia');
    expect(await communityStats(env, ['ia'], (async () => { throw new Error('x'); }) as typeof fetch)).toBeNull();
  });
});
