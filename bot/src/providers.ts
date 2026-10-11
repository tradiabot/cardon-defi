/**
 * Proveedores de IA gratuitos compatibles con el formato de OpenAI (el mismo catálogo que Kumo Bot).
 * Un modelo se escribe «<proveedor>:<id>», p. ej. «kilo:nvidia/nemotron-3-super-120b-a12b:free»;
 * sin prefijo es Groq, para no romper la configuración anterior.
 */
export const PROVIDERS = {
  kilo: {
    name: 'Kilo', url: 'https://api.kilo.ai/api/gateway', needsKey: false, signup: null,
    models: ['nvidia/nemotron-3-super-120b-a12b:free', 'nvidia/nemotron-3-ultra-550b-a55b:free'],
    note: 'Gratis, sin cuenta ni clave. Unas 200 consultas por hora; tarda 4-30 s porque razona antes de responder.',
  },
  groq: {
    name: 'Groq', url: 'https://api.groq.com/openai/v1', needsKey: true, signup: 'https://console.groq.com/keys',
    models: ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile'],
    note: 'Cuenta gratis → «Create API Key» (empieza por gsk_). Muy rápida; ~200k tokens al día por modelo.',
  },
  google: {
    name: 'Google AI Studio (Gemini)', url: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, signup: 'https://aistudio.google.com/app/apikey',
    models: ['gemini-3.7-flash'],
    note: 'Con tu cuenta de Google → «Create API key». ~1.500 consultas al día; en el plan gratis Google puede usar lo que envías (solo precios e indicadores).',
  },
  openrouter: {
    name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', needsKey: true, signup: 'https://openrouter.ai/workspaces/default/keys',
    models: ['openrouter/free'],
    note: 'Cuenta con correo → crea una clave (sk-or-…). Gratis: ~50 consultas al día.',
  },
  mistral: {
    name: 'Mistral', url: 'https://api.mistral.ai/v1', needsKey: true, signup: 'https://console.mistral.ai/api-keys',
    models: ['mistral-small-latest'],
    note: 'Cuenta con correo, plan gratis «Experiment» → crea una API key.',
  },
  cerebras: {
    name: 'Cerebras', url: 'https://api.cerebras.ai/v1', needsKey: true, signup: 'https://cloud.cerebras.ai',
    models: ['gpt-oss-120b', 'qwen-3-235b-a22b-instruct-2507'],
    note: 'Cuenta gratis → API Keys. Muy rápida; ~1M tokens al día.',
  },
} as const;

export type ProviderId = keyof typeof PROVIDERS;
export type AiKeys = Partial<Record<ProviderId, string>>;
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function parseModel(entry: string): { provider: ProviderId; model: string } {
  const i = entry.indexOf(':');
  const prefix = i > 0 ? entry.slice(0, i) : '';
  return prefix in PROVIDERS ? { provider: prefix as ProviderId, model: entry.slice(i + 1) } : { provider: 'groq', model: entry };
}

/** Nombre corto para la app: «nemotron-3-super-120b · Kilo». */
export function modelLabel(entry: string): string {
  const { provider, model } = parseModel(entry);
  return `${model.split('/').pop()!.replace(/:free$/, '')} · ${PROVIDERS[provider].name.split(' ')[0]}`;
}

/** Espera que pide Groq al agotar el límite ("try again in 1m2.5s" / "in 44.4s"), en ms. */
export function retryAfterMs(message: string): number | null {
  const m = /try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(message);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
}

export class CallError extends Error {
  constructor(message: string, readonly cooldownUntil: number | null = null) { super(message); }
}

/** Ajustes por familia: los modelos que razonan (gpt-oss, nemotron) necesitan margen o el JSON llega cortado o vacío. */
function modelParams(provider: ProviderId, model: string, budget: number): Record<string, unknown> {
  if (provider === 'kilo') return { max_completion_tokens: Math.max(3000, budget) };
  if (/gpt-oss/.test(model)) return { reasoning_effort: 'low', max_completion_tokens: Math.max(1500, budget) };
  return { max_tokens: budget };
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * Una llamada a un modelo. Lanza CallError (con pausa sugerida si es 429) en cualquier fallo,
 * incluido «sin clave», para que quien llama pase al siguiente modelo.
 */
export async function callModel(entry: string, keys: AiKeys, messages: ChatMessage[], opts: { json?: boolean; budget?: number; now?: number } = {}): Promise<string> {
  const { provider, model } = parseModel(entry);
  const p = PROVIDERS[provider];
  const key = keys[provider];
  if (p.needsKey && !key) throw new CallError(`sin clave de ${p.name}`);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'dex-pilot/1.0' };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${p.url}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model, temperature: 0.2, messages,
      ...modelParams(provider, model, opts.budget ?? 800),
      ...(opts.json === false ? {} : { response_format: { type: 'json_object' } }),
    }),
    signal: AbortSignal.timeout(provider === 'kilo' ? 45_000 : 25_000),
  });
  const text = await res.text();
  let body: { choices?: { message?: { content?: string } }[]; error?: { message?: string } | string; message?: string } = {};
  try { body = JSON.parse(text); } catch { if (res.ok) throw new CallError(`respuesta no JSON: ${text.slice(0, 80)}`); }
  if (!res.ok) {
    const message = (typeof body.error === 'string' ? body.error : body.error?.message) || body.message || `HTTP ${res.status}`;
    if (res.status === 429) {
      // Groq dice cuánto esperar; los demás solo responden 429: se descansa 10 min.
      const wait = Math.max(60_000, retryAfterMs(message) ?? 600_000);
      throw new CallError(`límite de ${p.name} (${message.match(/\(T[PR][DM]\)/)?.[0] ?? '429'})`, (opts.now ?? Date.now()) + wait);
    }
    throw new CallError(`${p.name} HTTP ${res.status}: ${message.slice(0, 160)}`);
  }
  const content = body.choices?.[0]?.message?.content?.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!content) throw new CallError('respuesta vacía');
  return content;
}

export function extractJson<T = Record<string, unknown>>(raw: string): T {
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('la respuesta no trae JSON');
  return JSON.parse(raw.slice(a, b + 1)) as T;
}
