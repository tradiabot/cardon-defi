import { callModel, extractJson, type AiKeys } from './providers';

/**
 * Contexto global para la IA: economía, mercados, política y cripto, con fuentes gratuitas sin clave.
 * Se refresca como mucho cada hora (kv `macro`) en un ciclo en el que no toca consultar a la IA de
 * trading, para no pasar del límite de 50 subpeticiones por invocación del plan gratis.
 */
export const MACRO_TTL_MS = 60 * 60_000;

export interface Indicator { id: string; label: string; value: number | null; change: number | null; unit: string; source: string }
export interface Headline { title: string; source: string; link: string; ts: number | null }
export type Risk = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF';

export interface MacroDigest {
  risk: Risk;
  score: number;
  cryptoBias: 'ALCISTA' | 'NEUTRAL' | 'BAJISTA';
  summary: string;
  points: string[];
  model: string;
}

export interface Macro {
  ts: number;
  indicators: Indicator[];
  news: { economia: Headline[]; politica: Headline[]; cripto: Headline[] };
  digest: MacroDigest;
  errors: string[];
}

/** Versión compacta que recibe la IA de trading en cada consulta (~150 tokens). */
export interface GlobalBrief {
  ageMin: number;
  risk: Risk;
  score: number;
  cryptoBias: string;
  summary: string;
  numbers: Record<string, string>;
}

const UA = { 'user-agent': 'Mozilla/5.0 (compatible; dex-pilot/1.0)' };

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const YAHOO: [string, string, string][] = [
  ['spx', 'S&P 500', '^GSPC'], ['ndx', 'Nasdaq', '^IXIC'], ['dxy', 'Dólar (DXY)', 'DX-Y.NYB'],
  ['vix', 'VIX (miedo bolsa)', '^VIX'], ['us10y', 'Bono EE. UU. 10a', '^TNX'], ['gold', 'Oro', 'GC=F'], ['oil', 'Petróleo WTI', 'CL=F'],
];

async function yahoo([id, label, symbol]: [string, string, string]): Promise<Indicator> {
  const d = JSON.parse(await getText(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`));
  const r = d.chart?.result?.[0];
  const closes: number[] = (r?.indicators?.quote?.[0]?.close ?? []).filter((x: number | null) => typeof x === 'number');
  const value = r?.meta?.regularMarketPrice ?? closes[closes.length - 1] ?? null;
  const prev = closes.length >= 2 ? closes[closes.length - 2] : null;
  return { id, label, value, change: value && prev ? (value / prev - 1) * 100 : null, unit: id === 'us10y' ? '%' : id === 'vix' ? '' : 'USD', source: 'Yahoo' };
}

async function kraken(): Promise<Indicator[]> {
  const d = JSON.parse(await getText('https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD'));
  const out: Indicator[] = [];
  for (const [key, id, label] of [['XXBTZUSD', 'btc', 'Bitcoin'], ['XETHZUSD', 'eth', 'Ethereum']]) {
    const t = d.result?.[key];
    if (!t) continue;
    const last = Number(t.c[0]);
    const open = Number(t.o);
    out.push({ id, label, value: last, change: open ? (last / open - 1) * 100 : null, unit: 'USD', source: 'Kraken (hoy UTC)' });
  }
  return out;
}

async function cryptoGlobal(): Promise<Indicator[]> {
  const d = JSON.parse(await getText('https://api.coinpaprika.com/v1/global'));
  return [
    { id: 'mcap', label: 'Cripto total', value: d.market_cap_usd ?? null, change: d.market_cap_change_24h ?? null, unit: 'USD', source: 'Coinpaprika' },
    { id: 'btcdom', label: 'Dominancia BTC', value: d.bitcoin_dominance_percentage ?? null, change: null, unit: '%', source: 'Coinpaprika' },
  ];
}

async function fearGreed(): Promise<Indicator> {
  const d = JSON.parse(await getText('https://api.alternative.me/fng/?limit=2'));
  const [now, prev] = d.data ?? [];
  return { id: 'fng', label: `Miedo/Codicia · ${now?.value_classification ?? '?'}`, value: Number(now?.value), change: prev ? Number(now.value) - Number(prev.value) : null, unit: '/100', source: 'alternative.me' };
}

function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseRss(xml: string, limit: number, fallbackSource: string): Headline[] {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit * 2);
  const out: Headline[] = [];
  for (const [, item] of items) {
    const tag = (name: string) => decode(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(item)?.[1] ?? '');
    let title = tag('title');
    let source = tag('source') || fallbackSource;
    const dash = title.lastIndexOf(' - ');
    if (fallbackSource === 'Google News' && dash > 20) { source = title.slice(dash + 3); title = title.slice(0, dash); }
    const link = tag('link');
    if (!title || !/^https:\/\//.test(link)) continue;
    const ts = Date.parse(tag('pubDate'));
    out.push({ title: title.slice(0, 200), source: source.slice(0, 60), link, ts: Number.isFinite(ts) ? ts : null });
    if (out.length >= limit) break;
  }
  return out;
}

const gnews = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
const NEWS = {
  economia: gnews('(Federal Reserve OR inflation OR "interest rates" OR recession OR "jobs report" OR ECB OR "stock market") when:1d'),
  politica: gnews('(tariffs OR sanctions OR election OR war OR geopolitical OR "White House" OR "crypto regulation" OR SEC) -football -sports -NFL when:1d'),
  cripto: 'https://cointelegraph.com/rss',
};

/** Lectura de riesgo por reglas, sin IA: respaldo cuando ningún modelo responde. */
export function ruleDigest(ind: Indicator[]): MacroDigest {
  const get = (id: string) => ind.find(i => i.id === id);
  let score = 0;
  const points: string[] = [];
  const spx = get('spx')?.change;
  if (spx != null) { score += spx > 0.5 ? 1 : spx < -0.5 ? -1 : 0; points.push(`S&P 500 ${spx >= 0 ? '+' : ''}${spx.toFixed(2)} %`); }
  const vix = get('vix')?.value;
  if (vix != null) { score += vix > 25 ? -1 : vix < 15 ? 0.5 : 0; points.push(`VIX ${vix.toFixed(1)}${vix > 25 ? ' (miedo alto)' : ''}`); }
  const btc = get('btc')?.change;
  if (btc != null) { score += btc > 2 ? 1 : btc < -2 ? -1 : 0; points.push(`BTC ${btc >= 0 ? '+' : ''}${btc.toFixed(2)} % hoy`); }
  const fng = get('fng')?.value;
  if (fng != null && Number.isFinite(fng)) { score += fng > 60 ? 0.5 : fng < 30 ? -0.5 : 0; points.push(`Miedo/Codicia ${fng}`); }
  const dxy = get('dxy')?.change;
  if (dxy != null) score += dxy > 0.5 ? -0.5 : dxy < -0.5 ? 0.5 : 0;
  score = Math.max(-2, Math.min(2, Math.round(score * 2) / 2));
  const risk: Risk = score >= 1 ? 'RISK_ON' : score <= -1 ? 'RISK_OFF' : 'NEUTRAL';
  return {
    risk, score, cryptoBias: btc == null ? 'NEUTRAL' : btc > 2 ? 'ALCISTA' : btc < -2 ? 'BAJISTA' : 'NEUTRAL',
    summary: `Lectura por reglas (sin IA): ${points.join(' · ') || 'sin datos'}.`, points, model: 'reglas',
  };
}

const DIGEST_SYSTEM = `Eres analista macro de un bot cripto (POL/USDC). Recibes indicadores de mercado y titulares de las últimas 24 h (economía, política, cripto).
Resume el entorno de riesgo para cripto en las próximas horas. No inventes datos ni noticias que no estén en la entrada.
Responde SOLO JSON: {"risk":"RISK_ON"|"NEUTRAL"|"RISK_OFF","score":-2..2,"crypto_bias":"ALCISTA"|"NEUTRAL"|"BAJISTA","summary":"máx 280 caracteres en español","points":["máx 5 puntos clave en español, ≤120 caracteres cada uno"]}`;

async function aiDigest(keys: AiKeys, models: string[], indicators: Indicator[], news: Macro['news'], blocked: Record<string, number>, now: number): Promise<MacroDigest | null> {
  const input = {
    indicadores: indicators.map(i => ({ [i.label]: i.value, cambio_pct: i.change == null ? null : Number(i.change.toFixed(2)) })),
    economia: news.economia.map(h => h.title), politica: news.politica.map(h => h.title), cripto: news.cripto.map(h => h.title),
  };
  for (const m of models.filter(m => (blocked[m] ?? 0) <= now).slice(0, 3)) {
    try {
      const d = extractJson<Record<string, unknown>>(await callModel(m, keys, [{ role: 'system', content: DIGEST_SYSTEM }, { role: 'user', content: JSON.stringify(input) }], { budget: 900, now }));
      const risk = ['RISK_ON', 'NEUTRAL', 'RISK_OFF'].includes(String(d.risk)) ? (d.risk as Risk) : 'NEUTRAL';
      const bias = ['ALCISTA', 'NEUTRAL', 'BAJISTA'].includes(String(d.crypto_bias)) ? (d.crypto_bias as MacroDigest['cryptoBias']) : 'NEUTRAL';
      const score = Math.max(-2, Math.min(2, Number(d.score) || 0));
      return {
        risk, score, cryptoBias: bias, model: m,
        summary: String(d.summary ?? '').slice(0, 300),
        points: (Array.isArray(d.points) ? d.points : []).slice(0, 5).map(p => String(p).slice(0, 140)),
      };
    } catch {
      // siguiente modelo
    }
  }
  return null;
}

export async function fetchMacro(keys: AiKeys, models: string[], blocked: Record<string, number> = {}, now = Date.now()): Promise<Macro> {
  const errors: string[] = [];
  const settle = async <T>(label: string, p: Promise<T>, fallback: T): Promise<T> => {
    try { return await p; } catch (e) { errors.push(`${label}: ${(e as Error).message}`); return fallback; }
  };
  const [fng, kr, glob, ...rest] = await Promise.all([
    settle('miedo/codicia', fearGreed(), null),
    settle('Kraken', kraken(), [] as Indicator[]),
    settle('Coinpaprika', cryptoGlobal(), [] as Indicator[]),
    ...YAHOO.map(y => settle(`Yahoo ${y[2]}`, yahoo(y), null)),
    settle('noticias economía', getText(NEWS.economia).then(x => parseRss(x, 6, 'Google News')), [] as Headline[]),
    settle('noticias política', getText(NEWS.politica).then(x => parseRss(x, 6, 'Google News')), [] as Headline[]),
    settle('noticias cripto', getText(NEWS.cripto).then(x => parseRss(x, 6, 'Cointelegraph')), [] as Headline[]),
  ]);
  const yahooOut = rest.slice(0, YAHOO.length) as (Indicator | null)[];
  const [economia, politica, cripto] = rest.slice(YAHOO.length) as Headline[][];
  const indicators = [...(kr as Indicator[]), ...(glob as Indicator[]), ...(fng ? [fng as Indicator] : []), ...yahooOut.filter((x): x is Indicator => x !== null)];
  const news = { economia, politica, cripto };
  const digest = (await aiDigest(keys, models, indicators, news, blocked, now)) ?? ruleDigest(indicators);
  return { ts: now, indicators, news, digest, errors };
}

function fmt(i: Indicator): string {
  const v = i.value == null ? '?' : i.value >= 1e9 ? `${(i.value / 1e12).toFixed(2)}T` : i.value >= 1000 ? Math.round(i.value).toString() : i.value.toFixed(2);
  return i.change == null ? v : `${v} (${i.change >= 0 ? '+' : ''}${i.change.toFixed(2)}%)`;
}

export function brief(m: Macro | null, now = Date.now()): GlobalBrief | null {
  if (!m) return null;
  const numbers = Object.fromEntries(m.indicators.map(i => [i.id, fmt(i)]));
  return { ageMin: Math.round((now - m.ts) / 60_000), risk: m.digest.risk, score: m.digest.score, cryptoBias: m.digest.cryptoBias, summary: m.digest.summary, numbers };
}
