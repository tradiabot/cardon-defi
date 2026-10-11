import { createPublicClient, createWalletClient, defineChain, fallback, http, type Hex } from 'viem';
import { fromUnits, rpc } from './chain';
import { toUnits, type DexQuote } from './dex';
import { liveAccount, SubmitError, type Stage } from './live';
import type { Market } from './markets';

/**
 * Hydration: el DEX de Polkadot. Tiene RPC de Ethereum (chainId 222222), así que la misma wallet 0x
 * firma allí. Un swap es una transacción EVM al contrato «dispatch», cuyo data es la llamada
 * Router.sell codificada en SCALE; la ruta la elige la propia cadena (ruta vacía).
 */
export const HYDRATION_RPCS = ['https://rpc.hydradx.cloud', 'https://hydration-rpc.n.dwellir.com'];
export const HYDRATION_CHAIN_ID = 222_222;
export const HYDRA_USDC = { assetId: 22, decimals: 6 };
const WETH = { assetId: 20, decimals: 18 };
export const DISPATCH = '0x0000000000000000000000000000000000000401';
/** Índices del runtime (specVersion 447): pallet y llamada. */
const ROUTER_SELL = [67, 0];
const UTILITY_BATCH_ALL = [13, 2];
const UTILITY_DISPATCH_AS = [13, 3];
const CURRENCIES_UPDATE_BALANCE = [79, 2];
const ORIGIN_ROOT = [1, 0];
const ORIGIN_SIGNED = [1, 1];
const XCM_VERSION = 4;
/** Comisión de red típica de un swap; el valor real se lee del recibo. */
export const EST_GAS_USD = 0.01;

const hydration = defineChain({
  id: HYDRATION_CHAIN_ID, name: 'Hydration',
  nativeCurrency: { name: 'Wrapped Ether', symbol: 'WETH', decimals: 18 },
  rpcUrls: { default: { http: HYDRATION_RPCS } },
});

const hex = (bytes: number[] | Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const le = (value: bigint, bytes: number): number[] => Array.from({ length: bytes }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn));
const u32 = (n: number) => le(BigInt(n), 4);
const u128 = (n: bigint) => le(n, 16);

/** Cuenta de 32 bytes de una dirección 0x en Hydration: «ETH\0» + dirección + 8 ceros. */
export function account32(evm: string): number[] {
  const h = evm.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{40}$/.test(h)) throw new Error('dirección EVM inválida');
  return [0x45, 0x54, 0x48, 0x00, ...Array.from({ length: 20 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16)), ...new Array(8).fill(0)];
}

/** Contrato ERC-20 de un activo de Hydration (precompile). */
export const assetContract = (assetId: number) => `0x${'00'.repeat(15)}01${assetId.toString(16).padStart(8, '0')}`;

/** Router.sell(asset_in, asset_out, amount_in, min_amount_out, ruta vacía = la decide la cadena). */
export function sellCall(assetIn: number, assetOut: number, amountIn: bigint, minOut: bigint): number[] {
  return [...ROUTER_SELL, ...u32(assetIn), ...u32(assetOut), ...u128(amountIn), ...u128(minOut), 0];
}

/** Busca el evento Router.Executed del swap y devuelve lo recibido. */
export function executedAmount(resultHex: string, assetIn: number, assetOut: number, amountIn: bigint): bigint | null {
  const needle = hex([...u32(assetIn), ...u32(assetOut), ...u128(amountIn)]);
  const body = resultHex.replace(/^0x/, '');
  const at = body.lastIndexOf(needle);
  if (at < 0 || at % 2) return null;
  const out = body.slice(at + needle.length, at + needle.length + 32);
  if (out.length < 32) return null;
  return BigInt('0x' + (out.match(/../g) as string[]).reverse().join(''));
}

/**
 * Cotización exacta sin tocar fondos: se simula (DryRunApi) con origen raíz un lote que abona el
 * activo de entrada a la cuenta y ejecuta el swap. Nada de esto se envía a la cadena.
 */
async function simulate(wallet: string, assetIn: number, assetOut: number, amountIn: bigint): Promise<bigint> {
  const who = account32(wallet);
  const mint = [...CURRENCIES_UPDATE_BALANCE, ...who, ...u32(assetIn), ...u128(amountIn * 2n)];
  const swap = [...UTILITY_DISPATCH_AS, ...ORIGIN_SIGNED, ...who, ...sellCall(assetIn, assetOut, amountIn, 0n)];
  const call = [...UTILITY_BATCH_ALL, 2 << 2, ...mint, ...swap];
  const result = await rpc(HYDRATION_RPCS, 'state_call', ['DryRunApi_dry_run_call', '0x' + hex([...ORIGIN_ROOT, ...call, ...u32(XCM_VERSION)])]);
  const out = executedAmount(result, assetIn, assetOut, amountIn);
  if (out === null || out <= 0n) throw new Error('Hydration: simulación sin swap (sin liquidez o runtime cambiado)');
  return out;
}

const assetOf = (m: Market) => {
  if (m.assetId === undefined) throw new Error(`${m.id} no es un activo de Hydration`);
  return { assetId: m.assetId, decimals: m.decimals };
};
const num = (raw: bigint, decimals: number) => fromUnits('0x' + raw.toString(16), decimals);

/** Precio medio: media geométrica de vender y comprar una cantidad pequeña. */
export async function hydraPrice(m: Market, wallet: string): Promise<number> {
  const base = assetOf(m);
  const units = BigInt(toUnits(m.probe, base.decimals));
  const usdc = await simulate(wallet, base.assetId, HYDRA_USDC.assetId, units);
  const sell = num(usdc, HYDRA_USDC.decimals) / m.probe;
  const back = await simulate(wallet, HYDRA_USDC.assetId, base.assetId, usdc);
  const buy = num(usdc, HYDRA_USDC.decimals) / num(back, base.decimals);
  if (!(sell > 0) || !(buy > 0)) throw new Error('Hydration: precio inválido');
  return Math.sqrt(sell * buy);
}

export async function hydraBalances(m: Market, wallet: string): Promise<{ base: number; USDC: number; gas: number }> {
  const base = assetOf(m);
  const word = wallet.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const read = (assetId: number) => rpc(HYDRATION_RPCS, 'eth_call', [{ to: assetContract(assetId), data: '0x70a08231' + word }, 'latest']);
  const [b, u] = await Promise.all([read(base.assetId), read(HYDRA_USDC.assetId)]);
  const usdc = fromUnits(u, HYDRA_USDC.decimals);
  // En Hydration la comisión se cobra en la moneda de comisiones de la cuenta; se toma el USDC como referencia.
  return { base: fromUnits(b, base.decimals), USDC: usdc, gas: usdc };
}

/** `refPrice`: precio medio del mercado, para medir el coste (spread + comisión) de la operación. */
export async function hydraQuote(m: Market, side: 'BUY' | 'SELL', amountIn: number, wallet: string, refPrice: number): Promise<DexQuote> {
  const base = assetOf(m);
  const [src, dest] = side === 'BUY' ? [HYDRA_USDC, base] : [base, HYDRA_USDC];
  const srcAmountRaw = toUnits(amountIn, src.decimals);
  const out = await simulate(wallet, src.assetId, dest.assetId, BigInt(srcAmountRaw));
  const amountOut = num(out, dest.decimals);
  const srcUsd = side === 'BUY' ? amountIn : amountIn * refPrice;
  const destUsd = side === 'BUY' ? amountOut * refPrice : amountOut;
  if (!(srcUsd > 0) || !(amountOut > 0)) throw new Error('Hydration: cotización sin liquidez');
  return {
    amountIn, amountOut, srcUsd, destUsd, gasUsd: EST_GAS_USD, costPct: ((srcUsd - destUsd + EST_GAS_USD) / srcUsd) * 100, srcAmountRaw,
    route: { venue: 'hydration', assetIn: src.assetId, assetOut: dest.assetId, destAmountRaw: out.toString() },
  };
}

function clients(privateKey?: string, wallet?: string) {
  const transport = fallback(HYDRATION_RPCS.map(url => http(url, { timeout: 15_000, retryCount: 0 })));
  const pub = createPublicClient({ chain: hydration, transport });
  if (!privateKey || !wallet) return { pub, wallet: null, account: null };
  const account = liveAccount(privateKey, wallet);
  return { pub, wallet: createWalletClient({ account, chain: hydration, transport }), account };
}

/** Datos de la transacción: Router.sell con el mínimo a recibir según el deslizamiento permitido. */
export function swapData(q: DexQuote, slippageBps: number): Hex {
  const r = q.route as { venue?: string; assetIn?: number; assetOut?: number; destAmountRaw?: string };
  if (r.venue !== 'hydration' || r.assetIn === undefined || r.assetOut === undefined || !r.destAmountRaw) throw new Error('cotización de Hydration inválida');
  const minOut = (BigInt(r.destAmountRaw) * BigInt(10_000 - slippageBps)) / 10_000n;
  if (minOut <= 0n) throw new Error('mínimo a recibir inválido');
  return `0x${hex(sellCall(r.assetIn, r.assetOut, BigInt(q.srcAmountRaw), minOut))}`;
}

export async function hydraSubmit(walletAddress: string, privateKey: string | undefined, q: DexQuote, slippageBps: number): Promise<Hex> {
  let stage: Stage = 'prepare';
  try {
    const { pub, wallet, account } = clients(privateKey, walletAddress);
    if (!wallet || !account) throw new Error('sin cuenta de firma');
    stage = 'build';
    const data = swapData(q, slippageBps);
    // Si la simulación falla (sin fondos, sin moneda de comisiones…), estimateGas lanza y no se envía nada.
    const gas = ((await pub.estimateGas({ account: account.address, to: DISPATCH, data })) * 13n) / 10n;
    const nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
    stage = 'send';
    return await wallet.sendTransaction({ to: DISPATCH, data, nonce, gas });
  } catch (error) {
    throw new SubmitError((error as Error).message.split('\n')[0].slice(0, 300), stage, null);
  }
}

export async function hydraSettlement(hash: Hex): Promise<{ status: 'PENDIENTE' | 'CONFIRMADA' | 'FALLIDA'; gasNative: number }> {
  const { pub } = clients();
  try {
    const r = await pub.getTransactionReceipt({ hash });
    return { status: r.status === 'success' ? 'CONFIRMADA' : 'FALLIDA', gasNative: Number(r.gasUsed * r.effectiveGasPrice) / 1e18 };
  } catch (error) {
    if ((error as Error).name === 'TransactionReceiptNotFoundError') return { status: 'PENDIENTE', gasNative: 0 };
    throw error;
  }
}

/** El gas del recibo viene expresado en WETH: su precio en USDC, para convertirlo. */
export async function hydraGasTokenUsd(wallet: string): Promise<number> {
  const probe = 10n ** 15n;
  return num(await simulate(wallet, WETH.assetId, HYDRA_USDC.assetId, probe), HYDRA_USDC.decimals) * 1000;
}
