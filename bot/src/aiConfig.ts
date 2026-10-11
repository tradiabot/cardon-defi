import type { Env } from './config';
import { settings } from './config';
import { getKv, putKv } from './db';
import { decide } from './ai';
import type { CycleStatus } from './engine';
import type { Action } from './indicators';
import { EST_COST_PCT, MAX_BUY_DISCOUNT_PCT } from './orders';
import { kvKey, MARKETS, type Market } from './markets';
import { modelLabel, parseModel, PROVIDER_IDS, PROVIDERS, type AiKeys, type ProviderId } from './providers';

/**
 * Configuración de IA editable desde la app (sin redeploy):
 * - kv `ai_config`: lista de modelos en orden y consenso;
 * - kv `ai_keys`: claves de los proveedores cifradas con AES-GCM (llave derivada de ADMIN_TOKEN).
 *   Nunca se devuelven: la app solo ve si hay clave y sus 4 últimos caracteres.
 * Si no hay nada guardado se usa wrangler.toml (GROQ_MODELS) y el secreto GROQ_API_KEY.
 */
export interface AiSettings {
  models: string[];
  consensus: { enabled: boolean; size: number };
}

interface StoredKeys { iv: string; data: string }

export const MAX_MODELS = 8;
export const DEFAULT_CONSENSUS = { enabled: true, size: 3 };

async function cryptoKey(env: Env): Promise<CryptoKey> {
  if (!env.ADMIN_TOKEN) throw new Error('ADMIN_TOKEN no configurado: no se pueden cifrar claves');
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`dex-pilot:ai-keys:${env.ADMIN_TOKEN}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));

async function readKeys(env: Env): Promise<AiKeys> {
  const stored = await getKv<StoredKeys>(env.DB, 'ai_keys');
  if (!stored) return {};
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(stored.iv) }, await cryptoKey(env), unb64(stored.data));
    return JSON.parse(new TextDecoder().decode(plain)) as AiKeys;
  } catch {
    return {}; // ADMIN_TOKEN cambió: las claves guardadas ya no se pueden leer y hay que volver a ponerlas
  }
}

async function writeKeys(env: Env, keys: AiKeys, now: number): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(env), new TextEncoder().encode(JSON.stringify(keys)));
  await putKv(env.DB, 'ai_keys', { iv: b64(iv), data: b64(new Uint8Array(data)) }, now).run();
}

/** «qwen/qwen3.8-27b» (formato viejo) → «groq:qwen/qwen3.8-27b». */
export function normalizeModel(entry: string): string {
  const { provider, model } = parseModel(entry);
  return `${provider}:${model}`;
}

export async function loadAi(env: Env): Promise<AiSettings & { keys: AiKeys }> {
  const [stored, keys] = await Promise.all([getKv<AiSettings>(env.DB, 'ai_config'), readKeys(env)]);
  const models = stored?.models?.length ? stored.models : settings(env).models;
  return {
    models: models.map(normalizeModel),
    consensus: stored?.consensus ?? DEFAULT_CONSENSUS,
    keys: { ...keys, groq: keys.groq || env.GROQ_API_KEY },
  };
}

/** Vista para la app: catálogo, qué proveedores tienen clave y la configuración vigente. */
export async function publicAiConfig(env: Env) {
  const ai = await loadAi(env);
  const stored = await readKeys(env);
  const cooldowns = (await getKv<Record<string, number>>(env.DB, 'ai_cooldown')) ?? {};
  const now = Date.now();
  return {
    providers: PROVIDER_IDS.map(id => {
      const p = PROVIDERS[id];
      const key = stored[id] || (id === 'groq' ? env.GROQ_API_KEY : undefined);
      return {
        id, name: p.name, needsKey: p.needsKey, signup: p.signup, note: p.note,
        models: p.models.map(m => `${id}:${m}`),
        hasKey: !p.needsKey || Boolean(key),
        keyHint: key ? `…${key.slice(-4)}` : null,
        keySource: stored[id] ? 'app' : key ? 'servidor' : null,
      };
    }),
    models: ai.models,
    consensus: ai.consensus,
    paused: Object.fromEntries(Object.entries(cooldowns).filter(([, until]) => until > now)),
  };
}

export interface AiConfigUpdate {
  keys?: Partial<Record<string, string | null>>;
  models?: unknown;
  consensus?: { enabled?: unknown; size?: unknown };
}

export async function updateAiConfig(env: Env, body: AiConfigUpdate, now = Date.now()): Promise<{ error: string } | { ok: true }> {
  if (body.keys) {
    const keys = await readKeys(env);
    for (const [id, value] of Object.entries(body.keys)) {
      if (!(id in PROVIDERS)) return { error: `Proveedor desconocido: ${id}` };
      if (value === null || value === '') delete keys[id as ProviderId];
      else {
        const key = String(value).trim();
        if (key.length < 12 || key.length > 300 || /\s/.test(key)) return { error: `Clave de ${PROVIDERS[id as ProviderId].name} con formato inválido` };
        keys[id as ProviderId] = key;
      }
    }
    await writeKeys(env, keys, now);
  }
  if (body.models !== undefined || body.consensus !== undefined) {
    const current = await loadAi(env);
    let models = current.models;
    if (body.models !== undefined) {
      if (!Array.isArray(body.models)) return { error: 'models debe ser una lista' };
      models = [...new Set(body.models.map(m => String(m).trim()).filter(Boolean))];
      if (!models.length) return { error: 'Deja al menos un modelo' };
      if (models.length > MAX_MODELS) return { error: `Máximo ${MAX_MODELS} modelos` };
      for (const m of models) {
        if (!/^[\w.:/-]{3,120}$/.test(m)) return { error: `Modelo inválido: ${m}` };
        const i = m.indexOf(':');
        if (i <= 0 || !(m.slice(0, i) in PROVIDERS)) return { error: `Escribe el modelo como proveedor:modelo (${PROVIDER_IDS.join(', ')})` };
      }
    }
    const size = Number(body.consensus?.size ?? current.consensus.size);
    if (!Number.isInteger(size) || size < 2 || size > 5) return { error: 'El consenso usa entre 2 y 5 IAs' };
    const enabled = body.consensus?.enabled === undefined ? current.consensus.enabled : Boolean(body.consensus.enabled);
    await putKv(env.DB, 'ai_config', { models, consensus: { enabled, size } } satisfies AiSettings, now).run();
  }
  return { ok: true };
}

/** Prueba cada modelo configurado con el último precio, sin tocar órdenes ni pausas. */
export async function testModels(env: Env, m: Market = MARKETS.POL): Promise<{ error: string } | { price: number; results: Record<string, unknown>[] }> {
  const s = settings(env);
  const ai = await loadAi(env);
  const cycle = await getKv<CycleStatus>(env.DB, kvKey(m, 'status'));
  const f = cycle?.features;
  if (!f) return { error: 'SIN_CICLOS' };
  const results = await Promise.all(ai.models.map(async model => {
    const t = Date.now();
    try {
      const { cooldowns: _, ...d } = await decide(ai.keys, [model], {
        symbol: `${m.id}/USDC`, price: f.price, features: f, technical: (cycle.decision?.technical ?? 'HOLD') as Action,
        position: { units: 0, avgCostUsd: null, unrealizedPct: null, botUnits: 0, botAvgCostUsd: null }, usdcAvailable: 0, sellFloor: cycle.orders?.sellFloor ?? null,
        rules: { maxTradeUsdc: s.maxTradeUsdc, minProfitPct: s.minProfitPct, maxBuyDiscountPct: MAX_BUY_DISCOUNT_PCT, estimatedCostPct: EST_COST_PCT }, activeOrders: [],
      });
      return { model, label: modelLabel(model), ok: true, ms: Date.now() - t, action: d.action, confidence: d.confidence, buyTrigger: d.buyTrigger, sellTrigger: d.sellTrigger };
    } catch (error) {
      return { model, label: modelLabel(model), ok: false, ms: Date.now() - t, error: (error as Error).message.replace(`${model}: `, '').slice(0, 200) };
    }
  }));
  return { price: f.price, results };
}
