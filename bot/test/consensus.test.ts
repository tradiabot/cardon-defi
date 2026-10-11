import { describe, expect, it, vi } from 'vitest';
import { combineVotes, consensus, type Vote } from '../src/ai';
import { parseRss, ruleDigest, type Indicator } from '../src/macro';
import { modelLabel, parseModel } from '../src/providers';

const v = (model: string, action: Vote['action'], confidence: number, buyTrigger: number | null = null, sellTrigger: number | null = null): Vote =>
  ({ model, ok: true, ms: 1, action, confidence, buyTrigger, sellTrigger, reason: `${model} dice ${action}` });

describe('consenso de IAs', () => {
  it('3/3 de acuerdo conserva la confianza y usa la mediana de los disparos', () => {
    const d = combineVotes([v('groq:a', 'BUY', 70, 0.100), v('kilo:b', 'BUY', 80, 0.102), v('groq:c', 'BUY', 60, 0.101)])!;
    expect(d).toMatchObject({ action: 'BUY', confidence: 70, buyTrigger: 0.101 });
    expect(d.model).toBe('consenso:groq:a+kilo:b+groq:c');
    expect(d.reason).toMatch(/^Consenso 3\/3/);
  });
  it('2 de 3 gana la mayoría pero recorta la confianza; el voto SELL no aporta compra', () => {
    const d = combineVotes([v('a', 'HOLD', 60, 0.1), v('b', 'HOLD', 70, 0.102), v('c', 'SELL', 90, 0.09, 0.12)])!;
    expect(d.action).toBe('HOLD');
    expect(d.confidence).toBe(Math.round(65 * (0.5 + 0.5 * 2 / 3)));
    expect(d.buyTrigger).toBeCloseTo(0.101);
    expect(d.sellTrigger).toBeNull(); // solo 1 de 3 propone venta
  });
  it('empate de puntos → HOLD; ningún voto válido → null', () => {
    expect(combineVotes([v('a', 'BUY', 70), v('b', 'SELL', 70)])!.action).toBe('HOLD');
    expect(combineVotes([{ model: 'a', ok: false, ms: 1, error: 'x' }])).toBeNull();
  });
  it('consulta en paralelo, salta modelos en pausa y completa si falla la mitad', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const model = JSON.parse(String(init.body)).model;
      calls.push(model);
      if (model === 'm2') return new Response('{"error":{"message":"caído"}}', { status: 503 });
      if (model === 'm3') return new Response('{"error":{"message":"Too Many Requests"}}', { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: `{"action":"BUY","confidence":70,"buy_trigger":0.1,"sell_trigger":null,"reason":"${model}"}` } }] }));
    });
    const d = await consensus({}, ['kilo:m1', 'kilo:m2', 'kilo:m3', 'kilo:m4', 'kilo:m5'], {} as never, 3, { 'kilo:m5': 9e15 }, 1000);
    vi.unstubAllGlobals();
    expect(calls.sort()).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(d.votes!.filter(x => x.ok).map(x => x.model)).toEqual(['kilo:m1', 'kilo:m4']);
    expect(d.cooldowns['kilo:m3']).toBe(1000 + 600_000);
    expect(d.action).toBe('BUY');
  });
});

describe('proveedores', () => {
  it('prefijos de todos los proveedores; sin prefijo es Groq', () => {
    expect(parseModel('google:gemini-3.7-flash')).toEqual({ provider: 'google', model: 'gemini-3.7-flash' });
    expect(parseModel('openrouter:openrouter/free')).toEqual({ provider: 'openrouter', model: 'openrouter/free' });
    expect(parseModel('qwen/qwen3.8-27b')).toEqual({ provider: 'groq', model: 'qwen/qwen3.8-27b' });
    expect(modelLabel('kilo:nvidia/nemotron-3-super-120b-a12b:free')).toBe('nemotron-3-super-120b-a12b · Kilo');
  });
});

describe('contexto global', () => {
  it('lee RSS de Google News separando la fuente y descarta enlaces no https', () => {
    const xml = `<rss><channel><item><title>Fed holds rates steady as inflation cools down - Reuters</title><link>https://news.google.com/a</link><pubDate>Wed, 07 Oct 2026 12:00:00 GMT</pubDate><source url="x">Reuters</source></item>
      <item><title><![CDATA[Tariffs &amp; trade talks stall]]></title><link>javascript:alert(1)</link></item></channel></rss>`;
    const h = parseRss(xml, 5, 'Google News');
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ title: 'Fed holds rates steady as inflation cools down', source: 'Reuters', link: 'https://news.google.com/a' });
  });
  it('lectura por reglas: bolsa y BTC cayendo con VIX alto → RISK_OFF', () => {
    const ind: Indicator[] = [
      { id: 'spx', label: '', value: 5000, change: -1.2, unit: '', source: '' },
      { id: 'vix', label: '', value: 28, change: null, unit: '', source: '' },
      { id: 'btc', label: '', value: 60000, change: -3, unit: '', source: '' },
    ];
    expect(ruleDigest(ind)).toMatchObject({ risk: 'RISK_OFF', cryptoBias: 'BAJISTA', model: 'reglas' });
  });
});
