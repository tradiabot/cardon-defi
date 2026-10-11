import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { liveAccount } from '../src/live';
import { toUnits, validateSwapTx, type DexQuote } from '../src/dex';
import { AUGUSTUS_V6 } from '../src/config';

const KEY = '0x' + '11'.repeat(32);
const ADDRESS = privateKeyToAccount(KEY as `0x${string}`).address;
const q = { srcAmountRaw: '5000000000000000000' } as DexQuote;

describe('liveAccount', () => {
  it('acepta la clave que corresponde a WALLET_ADDRESS, con o sin 0x', () => {
    expect(liveAccount(KEY, ADDRESS.toLowerCase()).address).toBe(ADDRESS);
    expect(liveAccount(KEY.slice(2), ADDRESS).address).toBe(ADDRESS);
  });
  it('rechaza clave ausente, mal formada o de otra wallet', () => {
    expect(() => liveAccount(undefined, ADDRESS)).toThrow('no configurada');
    expect(() => liveAccount('0x1234', ADDRESS)).toThrow('formato');
    expect(() => liveAccount(KEY, '0x' + '2'.repeat(40))).toThrow('no corresponde');
  });
});

describe('validateSwapTx', () => {
  const ok = { to: AUGUSTUS_V6, from: ADDRESS, chainId: 137, data: '0xabcdef', value: q.srcAmountRaw };
  it('acepta una venta POL→USDC bien formada', () => {
    expect(validateSwapTx('SELL', ok, q, ADDRESS)).toEqual({ to: AUGUSTUS_V6, data: '0xabcdef', value: 5_000_000_000_000_000_000n });
  });
  it('compra USDC→POL no debe enviar POL', () => {
    expect(validateSwapTx('BUY', { ...ok, value: '0' }, q, ADDRESS).value).toBe(0n);
    expect(() => validateSwapTx('BUY', ok, q, ADDRESS)).toThrow('value');
  });
  it('rechaza destino, remitente, red o importe manipulados', () => {
    expect(() => validateSwapTx('SELL', { ...ok, to: '0x' + '3'.repeat(40) }, q, ADDRESS)).toThrow('destino');
    expect(() => validateSwapTx('SELL', { ...ok, from: '0x' + '4'.repeat(40) }, q, ADDRESS)).toThrow('remitente');
    expect(() => validateSwapTx('SELL', { ...ok, chainId: 1 }, q, ADDRESS)).toThrow('chainId');
    expect(() => validateSwapTx('SELL', { ...ok, value: '6000000000000000000' }, q, ADDRESS)).toThrow('value');
    expect(() => validateSwapTx('SELL', { ...ok, data: 'nope' }, q, ADDRESS)).toThrow('data');
  });
});

describe('toUnits', () => {
  it('convierte sin errores de coma flotante', () => {
    expect(toUnits(2, 6)).toBe('2000000');
    expect(toUnits(17.5680725504993, 18)).toBe('17568072550000000000');
    expect(() => toUnits(-1, 6)).toThrow();
    expect(toUnits(0.1, 18)).toBe('100000000000000000');
  });
});

import { retryAfterMs } from '../src/ai';

describe('retryAfterMs', () => {
  it('lee la espera que pide Groq', () => {
    expect(retryAfterMs('Please try again in 44.496s. Need more tokens?')).toBeCloseTo(44_496);
    expect(retryAfterMs('try again in 12m3.5s')).toBeCloseTo(723_500);
    expect(retryAfterMs('try again in 1h2m')).toBe(3_720_000);
    expect(retryAfterMs('otro error')).toBeNull();
  });
});

import { decide, parseModel } from '../src/ai';
import { vi } from 'vitest';

describe('proveedores de IA', () => {
  it('«kilo:» va a Kilo y sin prefijo a Groq (los ids de Kilo llevan «:free»)', () => {
    expect(parseModel('kilo:nvidia/nemotron-3-super-120b-a12b:free')).toEqual({ provider: 'kilo', model: 'nvidia/nemotron-3-super-120b-a12b:free' });
    expect(parseModel('qwen/qwen3.8-27b')).toEqual({ provider: 'groq', model: 'qwen/qwen3.8-27b' });
  });
  it('sin clave de Groq salta a Kilo sin mandar Authorization; 429 deja el modelo en pausa', async () => {
    const calls: { url: string; auth: string | null; model: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      const model = JSON.parse(String(init.body)).model;
      calls.push({ url, auth: h.authorization ?? null, model });
      if (model === 'a:free') return new Response(JSON.stringify({ error: { message: 'Too Many Requests' } }), { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '<think>x</think>{"action":"HOLD","confidence":70,"buy_trigger":0.1,"sell_trigger":null,"reason":"ok"}' } }] }));
    });
    const ctx = {} as Parameters<typeof decide>[2];
    const d = await decide({}, ['qwen/qwen3.8-27b', 'kilo:a:free', 'kilo:b:free'], ctx, {}, 1000);
    vi.unstubAllGlobals();
    expect(d.model).toBe('kilo:b:free');
    expect(d.buyTrigger).toBe(0.1);
    expect(calls.map(c => c.model)).toEqual(['a:free', 'b:free']);
    expect(calls.every(c => c.url.startsWith('https://api.kilo.ai/') && c.auth === null)).toBe(true);
    expect(d.cooldowns['kilo:a:free']).toBe(1000 + 600_000);
  });
});
