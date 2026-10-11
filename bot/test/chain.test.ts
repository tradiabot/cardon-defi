import { afterEach, describe, expect, it, vi } from 'vitest';
import { rpc } from '../src/chain';

afterEach(() => vi.unstubAllGlobals());

describe('rpc con rotación y penalización', () => {
  it('un nodo con 429 se aparta y las siguientes consultas van primero a los sanos', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      if (url.includes('malo')) return new Response('Too Many Requests', { status: 429 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
    });
    const urls = ['https://malo.example', 'https://bueno.example'];
    for (let i = 0; i < 6; i++) expect(await rpc(urls, 'eth_blockNumber', [])).toBe('0x1');
    expect(calls.filter(u => u.includes('malo')).length).toBeLessThanOrEqual(1);
  });

  it('respuesta no JSON da un error legible y prueba el siguiente nodo', async () => {
    vi.stubGlobal('fetch', async (url: string) => (url.includes('raro') ? new Response('Terminated') : new Response(JSON.stringify({ result: '0x2' }))));
    expect(await rpc(['https://raro2.example'].concat(['https://ok.example']), 'eth_chainId', [])).toBe('0x2');
    await expect(rpc(['https://raro.example'], 'eth_chainId', [])).rejects.toThrow('respuesta no JSON: Terminated');
  });
});
