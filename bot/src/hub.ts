import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, fallback, http, type Hex } from 'viem';
import { fromUnits, rpc } from './chain';
import { toUnits, type DexQuote } from './dex';
import { liveAccount, SubmitError, type Stage } from './live';

/**
 * Polkadot Hub (Asset Hub): DOT/USDC en el pool nativo de la cadena (pallet asset-conversion, 0,3 %).
 * La wallet 0x opera allí sin puentes: una transacción EVM al precompile de XCM ejecuta un programa
 * local «retirar → intercambiar con mínimo → depositar en la misma cuenta». El gas se paga en DOT.
 */
export const HUB_EVM_RPCS = ['https://eth-rpc.polkadot.io'];
export const HUB_RPCS = ['https://polkadot-asset-hub-rpc.polkadot.io', 'https://asset-hub-polkadot-rpc.n.dwellir.com', 'https://rpc-asset-hub-polkadot.luckyfriday.io'];
export const HUB_CHAIN_ID = 420_420_419;
export const XCM_PRECOMPILE = '0x00000000000000000000000000000000000a0000';
const HUB_USDC_CONTRACT = '0x0000053900000000000000000000000001200000';
const DOT_DECIMALS = 10;
const USDC_DECIMALS = 6;
export const HUB_MIN_GAS_DOT = 0.05;
/** Comisión de red típica de un swap; el valor real se lee del recibo. */
export const HUB_EST_GAS_USD = 0.01;

/** Ubicaciones XCM: DOT = (padres 1, aquí); USDC = pallet 50 (assets), índice 1337. */
const LOC = { DOT: [1, 0], USDC: [0, 2, 4, 50, 5, 0xe5, 0x14] } as const;
type Asset = keyof typeof LOC;
/** El precompile solo acepta XCM v5; estas tres instrucciones se codifican igual que en v4. */
const XCM_V5 = 5;
const WITHDRAW_ASSET = 0x00;
const DEPOSIT_ASSET = 0x0d;
const EXCHANGE_ASSET = 0x0f;

const hub = defineChain({
  id: HUB_CHAIN_ID, name: 'Polkadot Hub',
  nativeCurrency: { name: 'Polkadot', symbol: 'DOT', decimals: 18 },
  rpcUrls: { default: { http: HUB_EVM_RPCS } },
});

const XCM_ABI = [
  { type: 'function', name: 'weighMessage', stateMutability: 'view', inputs: [{ name: 'message', type: 'bytes' }], outputs: [{ name: 'weight', type: 'tuple', components: [{ name: 'refTime', type: 'uint64' }, { name: 'proofSize', type: 'uint64' }] }] },
  { type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ name: 'message', type: 'bytes' }, { name: 'weight', type: 'tuple', components: [{ name: 'refTime', type: 'uint64' }, { name: 'proofSize', type: 'uint64' }] }], outputs: [] },
] as const;

const hex = (bytes: number[]) => bytes.map(b => b.toString(16).padStart(2, '0')).join('');
const le = (value: bigint, bytes: number): number[] => Array.from({ length: bytes }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn));

/** Entero compacto de SCALE. */
export function compact(n: bigint): number[] {
  if (n < 0n) throw new Error('compacto negativo');
  if (n < 1n << 6n) return le(n << 2n, 1);
  if (n < 1n << 14n) return le((n << 2n) | 1n, 2);
  if (n < 1n << 30n) return le((n << 2n) | 2n, 4);
  let size = 4;
  while (n >> BigInt(8 * size)) size++;
  return [((size - 4) << 2) | 3, ...le(n, size)];
}

/** Cuenta de 32 bytes de una dirección 0x en Polkadot Hub: dirección + 12 bytes 0xEE. */
export function hubAccount(evm: string): number[] {
  const h = evm.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{40}$/.test(h)) throw new Error('dirección EVM inválida');
  return [...Array.from({ length: 20 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16)), ...new Array(12).fill(0xee)];
}

const fungible = (asset: Asset, amount: bigint) => [...LOC[asset], 0x00, ...compact(amount)];

/** Programa XCM local: retira `give`, lo cambia por al menos `minWant` de `want` y deposita todo en la propia cuenta. */
export function swapMessage(wallet: string, give: Asset, giveAmount: bigint, want: Asset, minWant: bigint): Hex {
  if (give === want || giveAmount <= 0n || minWant <= 0n) throw new Error('intercambio inválido');
  const one = compact(1n);
  return `0x${hex([
    XCM_V5, ...compact(3n),
    WITHDRAW_ASSET, ...one, ...fungible(give, giveAmount),
    EXCHANGE_ASSET, 0x00, ...one, ...fungible(give, giveAmount), ...one, ...fungible(want, minWant), 0x01,
    DEPOSIT_ASSET, 0x01, 0x00, 0x00, 0x01, 0x01, 0x00, ...hubAccount(wallet),
  ])}`;
}

/** Cuánto `want` da el pool por `amount` de `give`, ya con la comisión del pool. */
async function poolQuote(give: Asset, want: Asset, amount: bigint): Promise<bigint> {
  const result = await rpc(HUB_RPCS, 'state_call', ['AssetConversionApi_quote_price_exact_tokens_for_tokens', '0x' + hex([...LOC[give], ...LOC[want], ...le(amount, 16), 1])]);
  const body = result.replace(/^0x/, '');
  if (!body.startsWith('01') || body.length < 34) throw new Error('Polkadot Hub: el pool no cotiza (sin liquidez)');
  const out = BigInt('0x' + (body.slice(2, 34).match(/../g) as string[]).reverse().join(''));
  if (out <= 0n) throw new Error('Polkadot Hub: cotización vacía');
  return out;
}

const num = (raw: bigint, decimals: number) => fromUnits('0x' + raw.toString(16), decimals);

/** Precio medio: media geométrica de vender y recomprar una cantidad pequeña. */
export async function hubPrice(probeDot: number): Promise<number> {
  const usdc = await poolQuote('DOT', 'USDC', BigInt(toUnits(probeDot, DOT_DECIMALS)));
  const back = await poolQuote('USDC', 'DOT', usdc);
  const sell = num(usdc, USDC_DECIMALS) / probeDot;
  const buy = num(usdc, USDC_DECIMALS) / num(back, DOT_DECIMALS);
  if (!(sell > 0) || !(buy > 0)) throw new Error('Polkadot Hub: precio inválido');
  return Math.sqrt(sell * buy);
}

export async function hubBalances(wallet: string): Promise<{ base: number; USDC: number; gas: number }> {
  const word = wallet.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const [dot, usdc] = await Promise.all([
    rpc(HUB_EVM_RPCS, 'eth_getBalance', [wallet, 'latest']),
    rpc(HUB_EVM_RPCS, 'eth_call', [{ to: HUB_USDC_CONTRACT, data: '0x70a08231' + word }, 'latest']),
  ]);
  const base = fromUnits(dot, 18);
  return { base, USDC: fromUnits(usdc, USDC_DECIMALS), gas: base };
}

export async function hubQuote(side: 'BUY' | 'SELL', amountIn: number, refPrice: number): Promise<DexQuote> {
  const [give, want]: [Asset, Asset] = side === 'BUY' ? ['USDC', 'DOT'] : ['DOT', 'USDC'];
  const srcAmountRaw = toUnits(amountIn, give === 'DOT' ? DOT_DECIMALS : USDC_DECIMALS);
  const out = await poolQuote(give, want, BigInt(srcAmountRaw));
  const amountOut = num(out, want === 'DOT' ? DOT_DECIMALS : USDC_DECIMALS);
  const srcUsd = side === 'BUY' ? amountIn : amountIn * refPrice;
  const destUsd = side === 'BUY' ? amountOut * refPrice : amountOut;
  if (!(srcUsd > 0) || !(amountOut > 0)) throw new Error('Polkadot Hub: cotización sin liquidez');
  return {
    amountIn, amountOut, srcUsd, destUsd, gasUsd: HUB_EST_GAS_USD, costPct: ((srcUsd - destUsd + HUB_EST_GAS_USD) / srcUsd) * 100, srcAmountRaw,
    route: { venue: 'hub', give, want, destAmountRaw: out.toString() },
  };
}

function clients(privateKey?: string, wallet?: string) {
  const transport = fallback(HUB_EVM_RPCS.map(url => http(url, { timeout: 20_000, retryCount: 0 })));
  const pub = createPublicClient({ chain: hub, transport });
  if (!privateKey || !wallet) return { pub, wallet: null, account: null };
  const account = liveAccount(privateKey, wallet);
  return { pub, wallet: createWalletClient({ account, chain: hub, transport }), account };
}

/** Mensaje del swap de una cotización, con el mínimo a recibir según el deslizamiento permitido. */
export function quoteMessage(wallet: string, q: DexQuote, slippageBps: number): Hex {
  const r = q.route as { venue?: string; give?: Asset; want?: Asset; destAmountRaw?: string };
  if (r.venue !== 'hub' || !r.give || !r.want || !(r.give in LOC) || !(r.want in LOC) || !r.destAmountRaw) throw new Error('cotización de Polkadot Hub inválida');
  const minOut = (BigInt(r.destAmountRaw) * BigInt(10_000 - slippageBps)) / 10_000n;
  return swapMessage(wallet, r.give, BigInt(q.srcAmountRaw), r.want, minOut);
}

/** Datos de la transacción al precompile: pesa el mensaje y lo ejecuta con ese peso. */
export async function hubSwapTx(walletAddress: string, q: DexQuote, slippageBps: number): Promise<{ to: Hex; data: Hex; gas: bigint }> {
  const { pub } = clients();
  const message = quoteMessage(walletAddress, q, slippageBps);
  const weight = await pub.readContract({ address: XCM_PRECOMPILE, abi: XCM_ABI, functionName: 'weighMessage', args: [message] });
  const data = encodeFunctionData({ abi: XCM_ABI, functionName: 'execute', args: [message, weight] });
  // Si el swap no puede ejecutarse (sin saldo, precio movido más que el deslizamiento…), estimateGas lanza y no se envía nada.
  const gas = ((await pub.estimateGas({ account: walletAddress as Hex, to: XCM_PRECOMPILE, data })) * 13n) / 10n;
  return { to: XCM_PRECOMPILE, data, gas };
}

export async function hubSubmit(walletAddress: string, privateKey: string | undefined, q: DexQuote, slippageBps: number): Promise<Hex> {
  let stage: Stage = 'prepare';
  try {
    const { pub, wallet, account } = clients(privateKey, walletAddress);
    if (!wallet || !account) throw new Error('sin cuenta de firma');
    stage = 'build';
    const tx = await hubSwapTx(walletAddress, q, slippageBps);
    const nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
    stage = 'send';
    return await wallet.sendTransaction({ to: tx.to, data: tx.data, nonce, gas: tx.gas });
  } catch (error) {
    throw new SubmitError((error as Error).message.split('\n')[0].slice(0, 300), stage, null);
  }
}

/** `gasNative`: comisión pagada, en DOT. */
export async function hubSettlement(hash: Hex): Promise<{ status: 'PENDIENTE' | 'CONFIRMADA' | 'FALLIDA'; gasNative: number }> {
  const { pub } = clients();
  try {
    const r = await pub.getTransactionReceipt({ hash });
    return { status: r.status === 'success' ? 'CONFIRMADA' : 'FALLIDA', gasNative: Number(r.gasUsed * r.effectiveGasPrice) / 1e18 };
  } catch (error) {
    if ((error as Error).name === 'TransactionReceiptNotFoundError') return { status: 'PENDIENTE', gasNative: 0 };
    throw error;
  }
}
