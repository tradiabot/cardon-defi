import { QUICKSWAP_V2_ROUTER, TOKENS, WPOL } from './config';

async function call(url: string, method: string, params: unknown[]): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'dex-pilot/1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let body: { result?: string; error?: { message: string } };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`respuesta no JSON: ${text.slice(0, 40)}`);
  }
  if (body.error) throw new Error(body.error.message);
  if (typeof body.result !== 'string') throw new Error('respuesta vacía');
  return body.result;
}

const PENALTY_MS = 5 * 60_000;
const penalized = new Map<string, number>();

function order(urls: string[], now: number): string[] {
  const start = Math.floor(Math.random() * urls.length);
  const rotated = [...urls.slice(start), ...urls.slice(0, start)];
  const healthy = rotated.filter(u => (penalized.get(u) ?? 0) <= now);
  const resting = rotated.filter(u => (penalized.get(u) ?? 0) > now);
  return [...healthy, ...resting];
}

export async function rpc(urls: string[], method: string, params: unknown[]): Promise<string> {
  const errors: string[] = [];
  for (const url of order(urls, Date.now())) {
    try {
      return await call(url, method, params);
    } catch (error) {
      const message = (error as Error).message;
      if (/429|limit|rate|quota|exceeded/i.test(message)) penalized.set(url, Date.now() + PENALTY_MS);
      errors.push(`${new URL(url).host}: ${message.slice(0, 80)}`);
    }
  }
  throw new Error(`RPC ${method} falló en todos los nodos (${errors.join(' | ')})`);
}

export function fromUnits(hex: string, decimals: number): number {
  const raw = BigInt(hex === '0x' ? '0x0' : hex);
  const base = 10n ** BigInt(decimals);
  return Number(raw / base) + Number(raw % base) / Number(base);
}

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

export interface OnChainBalances {
  POL: number;
  USDC: number;
}

/** Saldos en Polygon de un token ERC-20, USDC y POL (gas). */
export async function readTokenBalances(urls: string[], wallet: string, token: string, decimals: number): Promise<{ base: number; USDC: number; gas: number }> {
  const [pol, usdc, base] = await Promise.all([
    rpc(urls, 'eth_getBalance', [wallet, 'latest']),
    rpc(urls, 'eth_call', [{ to: TOKENS.USDC.address, data: '0x70a08231' + word(wallet) }, 'latest']),
    rpc(urls, 'eth_call', [{ to: token, data: '0x70a08231' + word(wallet) }, 'latest']),
  ]);
  return { base: fromUnits(base, decimals), USDC: fromUnits(usdc, TOKENS.USDC.decimals), gas: fromUnits(pol, TOKENS.POL.decimals) };
}

export async function readBalances(urls: string[], wallet: string): Promise<OnChainBalances> {
  const [pol, usdc] = await Promise.all([
    rpc(urls, 'eth_getBalance', [wallet, 'latest']),
    rpc(urls, 'eth_call', [{ to: TOKENS.USDC.address, data: '0x70a08231' + word(wallet) }, 'latest']),
  ]);
  return { POL: fromUnits(pol, TOKENS.POL.decimals), USDC: fromUnits(usdc, TOKENS.USDC.decimals) };
}

export async function quickswapPolPrice(urls: string[]): Promise<number> {
  const amountIn = 10n ** 19n;
  const data = '0xd06ca61f' + word(amountIn.toString(16)) + word('40') + word('2') + word(WPOL) + word(TOKENS.USDC.address);
  const result = await rpc(urls, 'eth_call', [{ to: QUICKSWAP_V2_ROUTER, data }, 'latest']);
  const out = BigInt('0x' + result.slice(2 + 64 * 3, 2 + 64 * 4));
  const price = Number(out) / 1e6 / 10;
  if (!(price > 0)) throw new Error('QuickSwap sin liquidez');
  return price;
}

export const POLKADOT_HUB_RPC = 'https://eth-rpc.polkadot.io';

const CHAINS = {
  polygon: {
    name: 'Polygon PoS', native: 'POL',
    assets: [
      { symbol: 'USDC', contract: TOKENS.USDC.address, decimals: 6 },
      { symbol: 'USDT', contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
    ],
  },
  polkadotHub: {
    name: 'Polkadot Hub', native: 'DOT',
    assets: [
      { symbol: 'USDC', contract: '0x0000053900000000000000000000000001200000', decimals: 6 },
      { symbol: 'USDt', contract: '0x000007C000000000000000000000000001200000', decimals: 6 },
    ],
  },
} as const;

export async function readAddressV1(polygonRpcs: string[], address: string) {
  const urls = { polygon: polygonRpcs, polkadotHub: [POLKADOT_HUB_RPC] };
  const chains: Record<string, unknown> = {};
  await Promise.all(Object.entries(CHAINS).map(async ([key, c]) => {
    const rpcs = urls[key as keyof typeof urls];
    try {
      const native = await rpc(rpcs, 'eth_getBalance', [address, 'latest']);
      const assets = await Promise.all(c.assets.map(async a => {
        try {
          const raw = await rpc(rpcs, 'eth_call', [{ to: a.contract, data: '0x70a08231' + word(address) }, 'latest']);
          return { symbol: a.symbol, configured: true, status: 'ONLINE', contract: a.contract, balance: String(fromUnits(raw, a.decimals)), decimals: a.decimals };
        } catch (error) {
          return { symbol: a.symbol, configured: true, status: 'ERROR', error: (error as Error).message, decimals: a.decimals };
        }
      }));
      chains[key] = { name: c.name, status: 'ONLINE', native: c.native, native_balance: String(fromUnits(native, 18)), assets };
    } catch (error) {
      chains[key] = { name: c.name, status: 'ERROR', native: c.native, error: (error as Error).message, assets: c.assets.map(a => ({ symbol: a.symbol, configured: true, status: 'UNAVAILABLE' })) };
    }
  }));
  return { address, read_only: true, signing: false, chains };
}

export async function chainStatusV1(polygonRpcs: string[]) {
  const probe = async (name: string, rpcs: string[]) => {
    try {
      return { name, status: 'ONLINE', block_number: parseInt(await rpc(rpcs, 'eth_blockNumber', []), 16) };
    } catch (error) {
      return { name, status: 'ERROR', error: (error as Error).message };
    }
  };
  return { chains: await Promise.all([probe('Polygon PoS', polygonRpcs), probe('Polkadot Hub', [POLKADOT_HUB_RPC])]) };
}
