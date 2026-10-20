/**
 * Cardón Comunidad: servicio central opcional.
 * - Registro voluntario: solo el correo. Quien se registra recibe una llave de borrado que queda en su teléfono;
 *   aquí solo se guarda su SHA-256. La app funciona igual sin registro.
 * - Errores y arreglos: los agentes que lo activan mandan reportes anónimos (código de error, arreglo de la lista
 *   cerrada, si funcionó). Nada de wallet, montos, hashes ni claves. Un arreglo se «recomienda» solo cuando
 *   lo confirman varios agentes distintos.
 * No guarda IPs: el cupo diario usa su SHA-256 con el día y se borra al día siguiente.
 */
export interface Env { DB: D1Database }

const DAY = 86_400_000;
const EMAIL = /^[^\s@"<>()[\]\\,;:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const CODE = /^[a-z_]{2,24}$/;
const AGENT = /^[a-f0-9]{32}$/;
export const MIN_AGENTES = 3;
const KEEP_MS = 180 * DAY;
const CUPO = { registro: 10, borrar: 20, reporte: 200 };

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function json(body: unknown, status = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, ...CORS } });
}
const fail = (error: string, status = 400) => json({ ok: false, error }, status);

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Cuenta un uso por día; false cuando se pasa del cupo. */
async function cupo(env: Env, tipo: keyof typeof CUPO, quien: string, now: number): Promise<boolean> {
  const dia = Math.floor(now / DAY);
  const clave = await sha256(`${tipo}|${quien}|${dia}`);
  const r = await env.DB.prepare('INSERT INTO cupos (clave, n, dia) VALUES (?, 1, ?) ON CONFLICT(clave) DO UPDATE SET n = n + 1 RETURNING n')
    .bind(clave, dia).first<{ n: number }>();
  return (r?.n ?? 1) <= CUPO[tipo];
}

export function normEmail(raw: unknown): string | null {
  const e = String(raw ?? '').trim().toLowerCase();
  return e.length <= 254 && EMAIL.test(e) ? e : null;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get('content-length') ?? 0) > 8192) return {};
  try {
    const b = await req.json();
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface ArregloStats { arreglo: string; agentes: number; intentos: number; resueltos: number; agentesResueltos: number; recomendado: boolean }

export async function stats(env: Env, codigos: string[], now: number): Promise<Record<string, ArregloStats[]>> {
  const out: Record<string, ArregloStats[]> = {};
  const list = [...new Set(codigos.filter(c => CODE.test(c)))].slice(0, 20);
  if (!list.length) return out;
  const rows = (await env.DB.prepare(
    `SELECT codigo, arreglo, COUNT(DISTINCT agente) AS agentes, COUNT(*) AS intentos, SUM(resuelto) AS resueltos,
            COUNT(DISTINCT CASE WHEN resuelto = 1 THEN agente END) AS agentesResueltos
       FROM reportes WHERE ts > ? AND codigo IN (${list.map(() => '?').join(',')})
      GROUP BY codigo, arreglo ORDER BY codigo, agentesResueltos DESC, resueltos DESC`,
  ).bind(now - KEEP_MS, ...list).all<Omit<ArregloStats, 'recomendado'> & { codigo: string }>()).results;
  for (const { codigo, ...r } of rows) {
    const s = { ...r, resueltos: Number(r.resueltos ?? 0), recomendado: r.agentesResueltos >= MIN_AGENTES && r.resueltos * 2 >= r.intentos };
    (out[codigo] ??= []).push(s);
  }
  return out;
}

export async function handle(req: Request, env: Env, now = Date.now()): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const ip = req.headers.get('cf-connecting-ip') ?? 'local';
  try {
    switch (`${req.method} ${path}`) {
      case 'GET /v1/estado': {
        const [u, a] = await Promise.all([
          env.DB.prepare('SELECT COUNT(*) AS n FROM usuarios').first<{ n: number }>(),
          env.DB.prepare('SELECT COUNT(DISTINCT agente) AS agentes, COUNT(*) AS reportes FROM reportes WHERE ts > ?').bind(now - 30 * DAY).first<{ agentes: number; reportes: number }>(),
        ]);
        return json({ ok: true, usuarios: u?.n ?? 0, agentes30d: a?.agentes ?? 0, reportes30d: a?.reportes ?? 0, minAgentes: MIN_AGENTES }, 200, 'public, max-age=300');
      }
      case 'POST /v1/registro': {
        const b = await body(req);
        const email = normEmail(b.email);
        if (!email) return fail('Correo no válido');
        const edicion = b.edicion === 'personal' ? 'personal' : 'publica';
        if (!(await cupo(env, 'registro', ip, now))) return fail('Demasiados intentos hoy; prueba mañana', 429);
        const llave = randomHex(24);
        const r = await env.DB.prepare('INSERT INTO usuarios (email, llave, edicion, creado) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
          .bind(email, await sha256(llave), edicion, now).run();
        // Si ya estaba, no se entrega otra llave (así nadie puede borrar el registro de otra persona).
        return r.meta.changes ? json({ ok: true, llave }) : json({ ok: true, existente: true });
      }
      case 'POST /v1/registro/borrar': {
        const b = await body(req);
        const llave = String(b.llave ?? '');
        if (!/^[a-f0-9]{48}$/.test(llave)) return fail('Llave no válida');
        if (!(await cupo(env, 'borrar', ip, now))) return fail('Demasiados intentos hoy; prueba mañana', 429);
        const r = await env.DB.prepare('DELETE FROM usuarios WHERE llave = ?').bind(await sha256(llave)).run();
        return r.meta.changes ? json({ ok: true, borrado: true }) : fail('No hay ningún registro con esa llave', 404);
      }
      case 'POST /v1/reportes': {
        const b = await body(req);
        const agente = String(b.agente ?? '');
        if (!AGENT.test(agente)) return fail('Agente no válido');
        const version = String(b.version ?? '').replace(/[^\w.+-]/g, '').slice(0, 24) || '?';
        const items = (Array.isArray(b.items) ? b.items : []).slice(0, 20).flatMap(raw => {
          const x = (raw ?? {}) as Record<string, unknown>;
          const codigo = String(x.codigo ?? ''), arreglo = String(x.arreglo ?? '');
          return CODE.test(codigo) && CODE.test(arreglo) ? [{ codigo, arreglo, ok: x.ok ? 1 : 0, resuelto: x.resuelto ? 1 : 0 }] : [];
        });
        if (!items.length) return fail('Sin reportes válidos');
        if (!(await cupo(env, 'reporte', agente, now)) || !(await cupo(env, 'reporte', ip, now))) return fail('Cupo diario agotado', 429);
        const insert = env.DB.prepare('INSERT INTO reportes (agente, codigo, arreglo, ok, resuelto, version, ts) VALUES (?, ?, ?, ?, ?, ?, ?)');
        await env.DB.batch([
          ...items.map(i => insert.bind(agente, i.codigo, i.arreglo, i.ok, i.resuelto, version, now)),
          env.DB.prepare('DELETE FROM reportes WHERE ts < ?').bind(now - KEEP_MS),
          env.DB.prepare('DELETE FROM cupos WHERE dia < ?').bind(Math.floor(now / DAY) - 1),
        ]);
        return json({ ok: true, guardados: items.length });
      }
      case 'GET /v1/arreglos': {
        const codigos = (url.searchParams.get('codigos') ?? '').split(',').map(s => s.trim());
        return json({ ok: true, minAgentes: MIN_AGENTES, arreglos: await stats(env, codigos, now) }, 200, 'public, max-age=300');
      }
    }
    return fail('Ruta no encontrada', 404);
  } catch (error) {
    return fail(`Error interno: ${(error as Error).message.slice(0, 120)}`, 500);
  }
}
