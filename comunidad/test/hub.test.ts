import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createD1 } from './d1-shim';
import { handle, MIN_AGENTES, normEmail, sha256, type Env } from '../src/hub';

const NOW = 1_800_000_000_000;
let env: Env & { DB: ReturnType<typeof createD1> };

function call(method: string, path: string, body?: unknown, ip = '1.2.3.4', now = NOW) {
  const req = new Request(`https://x.pages.dev${path}`, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: body ? JSON.stringify(body) : undefined });
  return handle(req, env, now).then(async r => ({ status: r.status, headers: r.headers, data: r.status === 204 ? null : await r.json() as Record<string, any> }));
}
const agent = (n: number) => n.toString(16).padStart(32, '0');

beforeEach(() => {
  const db = createD1(':memory:');
  db.raw.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  env = { DB: db } as never;
});

describe('registro', () => {
  it('normaliza y valida el correo', () => {
    expect(normEmail('  Ana@Ejemplo.COM ')).toBe('ana@ejemplo.com');
    expect(normEmail('ana@ejemplo')).toBeNull();
    expect(normEmail('<script>@x.com')).toBeNull();
    expect(normEmail('')).toBeNull();
  });

  it('registra, guarda solo el hash de la llave y permite borrar', async () => {
    const r = await call('POST', '/v1/registro', { email: 'Ana@ejemplo.com', edicion: 'publica' });
    expect(r.data.ok).toBe(true);
    expect(r.data.llave).toMatch(/^[a-f0-9]{48}$/);
    const row = env.DB.raw.prepare('SELECT * FROM usuarios').get() as Record<string, unknown>;
    expect(row.email).toBe('ana@ejemplo.com');
    expect(row.llave).toBe(await sha256(r.data.llave));
    expect((await call('GET', '/v1/estado')).data.usuarios).toBe(1);
    expect((await call('POST', '/v1/registro/borrar', { llave: 'f'.repeat(48) })).status).toBe(404);
    expect((await call('POST', '/v1/registro/borrar', { llave: r.data.llave })).data.borrado).toBe(true);
    expect((await call('GET', '/v1/estado')).data.usuarios).toBe(0);
  });

  it('un correo ya registrado no recibe otra llave', async () => {
    await call('POST', '/v1/registro', { email: 'ana@ejemplo.com' });
    const r = await call('POST', '/v1/registro', { email: 'ANA@ejemplo.com' });
    expect(r.data).toEqual({ ok: true, existente: true });
  });

  it('rechaza correos malos y limita intentos por IP', async () => {
    expect((await call('POST', '/v1/registro', { email: 'nada' })).status).toBe(400);
    for (let i = 0; i < 10; i++) expect((await call('POST', '/v1/registro', { email: `u${i}@ejemplo.com` })).status).toBe(200);
    expect((await call('POST', '/v1/registro', { email: 'otra@ejemplo.com' })).status).toBe(429);
    expect((await call('POST', '/v1/registro', { email: 'otra@ejemplo.com' }, '5.6.7.8')).status).toBe(200);
    expect(JSON.stringify(env.DB.raw.prepare('SELECT * FROM cupos').all())).not.toContain('1.2.3.4');
  });

  it('CORS para la app', async () => {
    const r = await call('OPTIONS', '/v1/registro');
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('errores y arreglos', () => {
  it('guarda solo campos válidos', async () => {
    expect((await call('POST', '/v1/reportes', { agente: 'x', items: [{ codigo: 'ia', arreglo: 'ia_todos' }] })).status).toBe(400);
    const r = await call('POST', '/v1/reportes', { agente: agent(1), version: '1.0.7', items: [{ codigo: 'ia', arreglo: 'ia_todos', ok: true, resuelto: true, wallet: '0xabc' }, { codigo: 'DROP TABLE', arreglo: 'x' }] });
    expect(r.data.guardados).toBe(1);
    expect(JSON.stringify(env.DB.raw.prepare('SELECT * FROM reportes').all())).not.toContain('0xabc');
  });

  it(`recomienda un arreglo solo con ${MIN_AGENTES} agentes distintos que lo confirmen`, async () => {
    const send = (n: number, resuelto: boolean, arreglo = 'ia_todos') => call('POST', '/v1/reportes', { agente: agent(n), items: [{ codigo: 'ia', arreglo, ok: true, resuelto }] });
    for (let i = 0; i < 5; i++) await send(1, true); // un solo agente repitiendo no cuenta
    await send(2, true);
    let s = (await call('GET', '/v1/arreglos?codigos=ia,precio')).data.arreglos;
    expect(s.ia[0]).toMatchObject({ arreglo: 'ia_todos', agentes: 2, agentesResueltos: 2, recomendado: false });
    expect(s.precio).toBeUndefined();
    await send(3, true);
    await send(4, false, 'ciclo');
    s = (await call('GET', '/v1/arreglos?codigos=ia')).data.arreglos;
    expect(s.ia[0]).toMatchObject({ arreglo: 'ia_todos', agentesResueltos: 3, recomendado: true });
    expect(s.ia[1]).toMatchObject({ arreglo: 'ciclo', recomendado: false });
    expect((await call('GET', '/v1/estado')).data.agentes30d).toBe(4);
  });

  it('borra reportes viejos', async () => {
    await call('POST', '/v1/reportes', { agente: agent(1), items: [{ codigo: 'ia', arreglo: 'ia_todos', resuelto: true }] }, '1.1.1.1', NOW - 200 * 86_400_000);
    await call('POST', '/v1/reportes', { agente: agent(2), items: [{ codigo: 'ia', arreglo: 'ia_todos', resuelto: true }] });
    expect((env.DB.raw.prepare('SELECT COUNT(*) AS n FROM reportes').get() as { n: number }).n).toBe(1);
  });
});
