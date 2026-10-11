import { createPublicClient, createWalletClient, decodeFunctionResult, encodeFunctionData, erc20Abi, fallback, http, parseAbi, type Hex } from 'viem';
import { polygon } from 'viem/chains';
import { TOKENS, WPOL, type Settings } from './config';
import { fromUnits, rpc } from './chain';
import { toUnits, type DexQuote } from './dex';
import { liveAccount, SubmitError, type Stage } from './live';
import type { Market } from './markets';

/**
 * Polygon sin intermediarios: se cotiza y se opera directo contra Uniswap V3 por RPC.
 * Los agregadores (ParaSwap, Kyber…) rechazan con 403 las peticiones que salen de algunos centros
 * de datos de Cloudflare —los del cron—, así que el bot no puede depender de sus APIs.
 */
export const UNI_QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
export const UNI_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
/** En un multicall del router, «recipient = 2» deja lo recibido en el propio router (para desenvolverlo después). */
const ROUTER_ITSELF = '0x0000000000000000000000000000000000000002';
const DEADLINE_SECONDS = 600;
/** Comisión de red típica de un swap en Polygon; el valor real se lee del recibo. */
export const UNI_EST_GAS_USD = 0.003;

const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function refundETH() payable',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
]);

type Side = 'BUY' | 'SELL';

/** Token del pool para un mercado: POL nativo se opera como WPOL (el router envuelve y desenvuelve). */
function pool(m: Market) {
  if (m.venue !== 'polygon' || !m.address || !m.fee) throw new Error(`${m.id} no tiene pool de Uniswap configurado`);
  return { token: (m.native ? WPOL : m.address) as Hex, decimals: m.decimals, fee: m.fee };
}

async function quoteRaw(urls: string[], tokenIn: Hex, tokenOut: Hex, fee: number, amountIn: bigint): Promise<bigint> {
  const data = encodeFunctionData({ abi: QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }] });
  const result = await rpc(urls, 'eth_call', [{ to: UNI_QUOTER, data }, 'latest']);
  const [amountOut] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: 'quoteExactInputSingle', data: result as Hex });
  if (amountOut <= 0n) throw new Error('Uniswap: pool sin liquidez');
  return amountOut;
}

const num = (raw: bigint, decimals: number) => fromUnits('0x' + raw.toString(16), decimals);

/** Precio medio: media geométrica de vender y recomprar una cantidad pequeña. */
export async function uniPrice(m: Market, urls: string[]): Promise<number> {
  const p = pool(m);
  const usdc = await quoteRaw(urls, p.token, TOKENS.USDC.address, p.fee, BigInt(toUnits(m.probe, p.decimals)));
  const back = await quoteRaw(urls, TOKENS.USDC.address, p.token, p.fee, usdc);
  const sell = num(usdc, TOKENS.USDC.decimals) / m.probe;
  const buy = num(usdc, TOKENS.USDC.decimals) / num(back, p.decimals);
  if (!(sell > 0) || !(buy > 0)) throw new Error('Uniswap: precio inválido');
  return Math.sqrt(sell * buy);
}

/** `refPrice`: precio medio del mercado, para medir el coste (comisión del pool + impacto + gas). */
export async function uniQuote(m: Market, side: Side, amountIn: number, urls: string[], refPrice: number): Promise<DexQuote> {
  const p = pool(m);
  const usdc = { token: TOKENS.USDC.address as Hex, decimals: TOKENS.USDC.decimals };
  const [src, dest] = side === 'BUY' ? [usdc, p] : [p, usdc];
  const srcAmountRaw = toUnits(amountIn, src.decimals);
  const out = await quoteRaw(urls, src.token, dest.token, p.fee, BigInt(srcAmountRaw));
  const amountOut = num(out, dest.decimals);
  const srcUsd = side === 'BUY' ? amountIn : amountIn * refPrice;
  const destUsd = side === 'BUY' ? amountOut * refPrice : amountOut;
  if (!(srcUsd > 0) || !(amountOut > 0)) throw new Error('Uniswap: cotización sin liquidez');
  return {
    amountIn, amountOut, srcUsd, destUsd, gasUsd: UNI_EST_GAS_USD, costPct: ((srcUsd - destUsd + UNI_EST_GAS_USD) / srcUsd) * 100, srcAmountRaw,
    route: { venue: 'uniswap', market: m.id, side, fee: p.fee, destAmountRaw: out.toString() },
  };
}

export interface UniTx {
  to: Hex;
  data: Hex;
  value: bigint;
  /** ERC-20 que hay que aprobar al router antes del swap (null al vender POL nativo). */
  approve: { token: Hex; amount: bigint } | null;
}

/** Transacción del swap de una cotización, con mínimo a recibir y fecha límite. Nada externo la construye. */
export function uniSwapTx(m: Market, side: Side, q: DexQuote, wallet: string, slippageBps: number, nowSeconds: number): UniTx {
  const p = pool(m);
  const r = q.route as { venue?: string; market?: string; side?: string; fee?: number; destAmountRaw?: string };
  if (r.venue !== 'uniswap' || r.market !== m.id || r.side !== side || r.fee !== p.fee || !r.destAmountRaw) throw new Error('cotización de Uniswap inválida');
  const amountIn = BigInt(q.srcAmountRaw);
  const minOut = (BigInt(r.destAmountRaw) * BigInt(10_000 - slippageBps)) / 10_000n;
  if (amountIn <= 0n || minOut <= 0n) throw new Error('importes del swap inválidos');
  const usdc = TOKENS.USDC.address as Hex;
  const recipient = wallet as Hex;
  const single = (tokenIn: Hex, tokenOut: Hex, to: Hex) =>
    encodeFunctionData({ abi: ROUTER_ABI, functionName: 'exactInputSingle', args: [{ tokenIn, tokenOut, fee: p.fee, recipient: to, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] });
  let calls: Hex[];
  let value = 0n;
  let approve: UniTx['approve'];
  if (side === 'SELL') {
    calls = [single(p.token, usdc, recipient)];
    if (m.native) {
      // El router envuelve el POL enviado; refundETH devuelve cualquier resto.
      value = amountIn;
      approve = null;
      calls.push(encodeFunctionData({ abi: ROUTER_ABI, functionName: 'refundETH' }));
    } else approve = { token: p.token, amount: amountIn };
  } else {
    approve = { token: usdc, amount: amountIn };
    calls = m.native
      ? [single(usdc, p.token, ROUTER_ITSELF), encodeFunctionData({ abi: ROUTER_ABI, functionName: 'unwrapWETH9', args: [minOut, recipient] })]
      : [single(usdc, p.token, recipient)];
  }
  const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [BigInt(nowSeconds + DEADLINE_SECONDS), calls] });
  return { to: UNI_ROUTER, data, value, approve };
}

function clients(s: Settings, privateKey?: string) {
  const transport = fallback(s.rpcs.map(url => http(url, { timeout: 15_000, retryCount: 0 })));
  const pub = createPublicClient({ chain: polygon, transport });
  if (!privateKey) return { pub, wallet: null, account: null };
  const account = liveAccount(privateKey, s.wallet);
  return { pub, wallet: createWalletClient({ account, chain: polygon, transport }), account };
}

const APPROVE_GAS = 80_000n;
/** Gas del swap cuando no se puede estimar porque la aprobación aún no está minada. */
const SWAP_GAS_AFTER_APPROVE = 450_000n;

export async function uniSubmit(m: Market, s: Settings, privateKey: string | undefined, side: Side, q: DexQuote): Promise<{ hash: Hex; approveHash: Hex | null }> {
  let stage: Stage = 'prepare';
  let approveHash: Hex | null = null;
  try {
    const { pub, wallet, account } = clients(s, privateKey);
    if (!wallet || !account) throw new Error('sin cuenta de firma');
    stage = 'build';
    const tx = uniSwapTx(m, side, q, s.wallet, s.slippageBps, Math.floor(Date.now() / 1000));
    let nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
    let needsApprove = false;
    if (tx.approve) {
      const allowance = await pub.readContract({ address: tx.approve.token, abi: erc20Abi, functionName: 'allowance', args: [account.address, UNI_ROUTER] });
      needsApprove = allowance < tx.approve.amount;
    }
    // Sin aprobación pendiente, estimateGas simula el swap real: si fuera a fallar, lanza y no se envía nada.
    const gas = needsApprove ? SWAP_GAS_AFTER_APPROVE : ((await pub.estimateGas({ account: account.address, to: tx.to, data: tx.data, value: tx.value })) * 13n) / 10n;
    if (needsApprove && tx.approve) {
      stage = 'approve';
      approveHash = await wallet.sendTransaction({
        to: tx.approve.token, nonce: nonce++, gas: APPROVE_GAS,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [UNI_ROUTER, tx.approve.amount] }),
      });
    }
    stage = 'send';
    const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, nonce, gas });
    return { hash, approveHash };
  } catch (error) {
    throw new SubmitError((error as Error).message.split('\n')[0].slice(0, 300), stage, approveHash);
  }
}
