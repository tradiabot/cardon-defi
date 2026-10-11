import { AUGUSTUS_V6, TOKENS } from './config';
import { MARKETS, type Market } from './markets';

export interface DexQuote {
  amountIn: number;
  amountOut: number;
  srcUsd: number;
  destUsd: number;
  gasUsd: number;
  costPct: number;
  srcAmountRaw: string;
  route: Record<string, unknown>;
}

export interface SwapTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
}

type Side = 'BUY' | 'SELL';

const API = 'https://api.paraswap.io';
/** ParaSwap responde 403 vacío a peticiones sin user-agent desde algunos centros de datos de Cloudflare (los del cron). */
const HEADERS = { accept: 'application/json', 'user-agent': 'dex-pilot/1.0' };
function tokensFor(m: Market, side: Side) {
  if (m.venue !== 'polygon' || !m.address) throw new Error(`${m.id} no se opera en Polygon`);
  const base = { address: m.address, decimals: m.decimals };
  return side === 'BUY' ? { src: TOKENS.USDC, dest: base } : { src: base, dest: TOKENS.USDC };
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`ParaSwap HTTP ${res.status}: respuesta no JSON (${text.slice(0, 40) || 'vacía'})`);
  }
}

export function toUnits(amount: number, decimals: number): string {
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`cantidad inválida: ${amount}`);
  const [int, frac = ''] = amount.toFixed(Math.min(decimals, 9)).split('.');
  return (BigInt(int) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')).toString();
}

export async function quote(side: Side, amountIn: number, wallet: string, m: Market = MARKETS.POL): Promise<DexQuote> {
  const { src, dest } = tokensFor(m, side);
  const srcAmountRaw = toUnits(amountIn, src.decimals);
  const params = new URLSearchParams({
    srcToken: src.address, srcDecimals: String(src.decimals),
    destToken: dest.address, destDecimals: String(dest.decimals),
    amount: srcAmountRaw, side: 'SELL', network: '137', version: '6.2', userAddress: wallet,
  });
  const res = await fetch(`${API}/prices?${params}`, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
  const body = await parseJson<{ priceRoute?: Record<string, string>; error?: string }>(res);
  if (!res.ok || !body.priceRoute) throw new Error(`ParaSwap: ${body.error || `HTTP ${res.status}`}`);
  const r = body.priceRoute;
  const srcUsd = Number(r.srcUSD);
  const destUsd = Number(r.destUSD);
  const gasUsd = Number(r.gasCostUSD) || 0;
  const amountOut = Number(BigInt(r.destAmount)) / 10 ** dest.decimals;
  if (!(srcUsd > 0) || !(amountOut > 0)) throw new Error('ParaSwap: cotización sin liquidez');
  const costPct = ((srcUsd - destUsd + gasUsd) / srcUsd) * 100;
  return { amountIn, amountOut, srcUsd, destUsd, gasUsd, costPct, srcAmountRaw, route: r };
}

export async function buildSwapTx(side: Side, q: DexQuote, wallet: string, slippageBps: number, m: Market = MARKETS.POL): Promise<SwapTx> {
  const { src, dest } = tokensFor(m, side);
  const res = await fetch(`${API}/transactions/137?ignoreChecks=true`, {
    method: 'POST',
    headers: { ...HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({
      srcToken: src.address, destToken: dest.address, srcAmount: q.srcAmountRaw,
      srcDecimals: src.decimals, destDecimals: dest.decimals, slippage: slippageBps,
      priceRoute: q.route, userAddress: wallet,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const tx = await parseJson<{ to?: string; data?: string; value?: string; from?: string; chainId?: number; error?: string }>(res);
  if (!res.ok || !tx.to || !tx.data) throw new Error(`ParaSwap tx: ${tx.error || `HTTP ${res.status}`}`);
  return validateSwapTx(side, tx, q, wallet, m);
}

export function validateSwapTx(side: Side, tx: { to?: string; data?: string; value?: string; from?: string; chainId?: number }, q: DexQuote, wallet: string, m: Market = MARKETS.POL): SwapTx {
  if (tx.to?.toLowerCase() !== AUGUSTUS_V6) throw new Error(`ParaSwap tx: destino inesperado ${tx.to}`);
  if (tx.from?.toLowerCase() !== wallet.toLowerCase()) throw new Error('ParaSwap tx: remitente distinto a la wallet');
  if (tx.chainId !== 137) throw new Error(`ParaSwap tx: chainId ${tx.chainId}`);
  if (!/^0x[0-9a-fA-F]+$/.test(tx.data ?? '')) throw new Error('ParaSwap tx: data inválida');
  const value = BigInt(tx.value ?? '0');
  // Solo la moneda nativa (POL) viaja como value; los tokens ERC-20 se cobran por allowance.
  const expected = side === 'SELL' && m.native ? BigInt(q.srcAmountRaw) : 0n;
  if (value !== expected) throw new Error(`ParaSwap tx: value ${value} ≠ esperado ${expected}`);
  return { to: AUGUSTUS_V6, data: tx.data as `0x${string}`, value };
}
