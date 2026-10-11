import { verifyMessage, type Hex } from 'viem';
import type { Env } from './config';
import { getKv, putKv } from './db';

/**
 * Dos formas de ser administrador:
 * - el ADMIN_TOKEN del servidor (secreto de Cloudflare);
 * - una sesión creada desde la app: el teléfono firma un reto con la wallet del bot (tras huella o PIN)
 *   y el servidor le entrega un token de sesión. Solo se guarda su hash, nunca el token.
 */
const SESSION_TTL_MS = 90 * 86_400_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_SESSIONS = 5;
const MAX_CHALLENGES = 20;
const PREFIX = 'DEX Pilot · iniciar sesión en la app';

type Sessions = Record<string, { createdAt: number; expiresAt: number }>;
type Challenges = Record<string, number>;

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

function bearer(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

async function same(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0 && given.length > 0;
}

export async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const given = bearer(request);
  if (!given) return false;
  if (env.ADMIN_TOKEN && (await same(given, env.ADMIN_TOKEN))) return true;
  const session = ((await getKv<Sessions>(env.DB, 'sessions')) ?? {})[hex(await digest(given))];
  return Boolean(session && session.expiresAt > Date.now());
}

/** Reto de un solo uso que el teléfono firma con la wallet del bot. */
export async function loginChallenge(env: Env, now = Date.now()): Promise<{ message: string; wallet: string; expiresInSeconds: number }> {
  const nonce = crypto.randomUUID();
  const live = Object.entries((await getKv<Challenges>(env.DB, 'auth_challenges')) ?? {}).filter(([, until]) => until > now).slice(-(MAX_CHALLENGES - 1));
  await putKv(env.DB, 'auth_challenges', Object.fromEntries([...live, [nonce, now + CHALLENGE_TTL_MS]]), now).run();
  const wallet = env.WALLET_ADDRESS.toLowerCase();
  return { message: `${PREFIX} · ${wallet} · ${new Date(now).toISOString()} · ${nonce}`, wallet, expiresInSeconds: CHALLENGE_TTL_MS / 1000 };
}

export async function login(env: Env, body: { message?: unknown; signature?: unknown }, now = Date.now()): Promise<{ error: string; status: number } | { token: string; expiresAt: string }> {
  const message = String(body.message ?? '');
  const signature = String(body.signature ?? '');
  const parts = message.split(' · ');
  if (parts.length !== 5 || `${parts[0]} · ${parts[1]}` !== PREFIX || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return { error: 'Inicio de sesión con formato inválido', status: 400 };
  const wallet = env.WALLET_ADDRESS.toLowerCase();
  if (parts[2] !== wallet) return { error: 'El reto no corresponde a la wallet de este bot', status: 400 };
  const challenges = (await getKv<Challenges>(env.DB, 'auth_challenges')) ?? {};
  const until = challenges[parts[4]];
  if (!until || until <= now) return { error: 'El reto caducó: inténtalo de nuevo', status: 401 };
  let valid = false;
  try {
    valid = await verifyMessage({ address: wallet as Hex, message, signature: signature as Hex });
  } catch {
    valid = false;
  }
  if (!valid) return { error: `La wallet de este teléfono no es la del bot (${env.WALLET_ADDRESS}). Importa esa wallet en la app o usa el token de administrador`, status: 401 };
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  delete challenges[parts[4]];
  const sessions = Object.entries((await getKv<Sessions>(env.DB, 'sessions')) ?? {})
    .filter(([, s]) => s.expiresAt > now)
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .slice(-(MAX_SESSIONS - 1));
  const expiresAt = now + SESSION_TTL_MS;
  await env.DB.batch([
    putKv(env.DB, 'auth_challenges', challenges, now),
    putKv(env.DB, 'sessions', Object.fromEntries([...sessions, [hex(await digest(token)), { createdAt: now, expiresAt }]]), now),
  ]);
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

/** Cierra la sesión del token presentado (el ADMIN_TOKEN no se puede cerrar: se rota en Cloudflare). */
export async function logout(request: Request, env: Env, now = Date.now()): Promise<boolean> {
  const sessions = (await getKv<Sessions>(env.DB, 'sessions')) ?? {};
  const key = hex(await digest(bearer(request)));
  if (!sessions[key]) return false;
  delete sessions[key];
  await putKv(env.DB, 'sessions', sessions, now).run();
  return true;
}
