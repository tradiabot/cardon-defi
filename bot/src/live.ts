import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, fallback, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { AUGUSTUS_V6, TOKENS, type Settings } from './config';
import { buildSwapTx, type DexQuote } from './dex';
import { MARKETS, type Market } from './markets';

export type Stage = 'prepare' | 'approve' | 'build' | 'send';

export class SubmitError extends Error {
  constructor(message: string, readonly stage: Stage, readonly approveHash: Hex | null) {
    super(message);
  }
}

export function liveAccount(privateKey: string | undefined, expectedAddress: string) {
  if (!privateKey) throw new Error('WALLET_PRIVATE_KEY no configurada');
  const key = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('WALLET_PRIVATE_KEY con formato inválido');
  const account = privateKeyToAccount(key);
  if (account.address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error('WALLET_PRIVATE_KEY no corresponde a WALLET_ADDRESS');
  return account;
}

function clients(s: Settings, privateKey?: string) {
  const transport = fallback(s.rpcs.map(url => http(url, { timeout: 15_000, retryCount: 0 })));
  const pub = createPublicClient({ chain: polygon, transport });
  if (!privateKey) return { pub, wallet: null, account: null };
  const account = liveAccount(privateKey, s.wallet);
  return { pub, wallet: createWalletClient({ account, chain: polygon, transport }), account };
}

export async function submitSwap(s: Settings, privateKey: string | undefined, side: 'BUY' | 'SELL', q: DexQuote, m: Market = MARKETS.POL): Promise<{ hash: Hex; approveHash: Hex | null }> {
  let stage: Stage = 'prepare';
  let approveHash: Hex | null = null;
  try {
    const { pub, wallet, account } = clients(s, privateKey);
    if (!wallet || !account) throw new Error('sin cuenta de firma');
    let nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
    // Lo que se entrega es un ERC-20 (USDC al comprar, el token al vender) salvo al vender POL nativo.
    const srcToken = side === 'BUY' ? TOKENS.USDC.address : m.native ? null : (m.address as Hex);
    if (srcToken) {
      const amount = BigInt(q.srcAmountRaw);
      const allowance = await pub.readContract({ address: srcToken, abi: erc20Abi, functionName: 'allowance', args: [account.address, AUGUSTUS_V6] });
      if (allowance < amount) {
        stage = 'approve';
        approveHash = await wallet.sendTransaction({
          to: srcToken, nonce: nonce++, gas: 80_000n,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [AUGUSTUS_V6, amount] }),
        });
      }
    }
    stage = 'build';
    const tx = await buildSwapTx(side, q, s.wallet, s.slippageBps, m);
    const gas = approveHash
      ? 900_000n
      : ((await pub.estimateGas({ account: account.address, to: tx.to, data: tx.data, value: tx.value })) * 13n) / 10n;
    stage = 'send';
    const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, nonce, gas });
    return { hash, approveHash };
  } catch (error) {
    throw new SubmitError((error as Error).message.split('\n')[0].slice(0, 300), stage, approveHash);
  }
}

export async function settlement(s: Settings, hash: Hex, approveHash: Hex | null): Promise<{ status: 'PENDIENTE' | 'CONFIRMADA' | 'FALLIDA'; gasPol: number }> {
  const { pub } = clients(s);
  const read = async (h: Hex) => {
    try {
      return await pub.getTransactionReceipt({ hash: h });
    } catch (error) {
      if ((error as Error).name === 'TransactionReceiptNotFoundError') return null;
      throw error;
    }
  };
  const [swap, approve] = await Promise.all([read(hash), approveHash ? read(approveHash) : null]);
  if (!swap) return { status: 'PENDIENTE', gasPol: 0 };
  const gasWei = swap.gasUsed * swap.effectiveGasPrice + (approve ? approve.gasUsed * approve.effectiveGasPrice : 0n);
  return { status: swap.status === 'success' ? 'CONFIRMADA' : 'FALLIDA', gasPol: Number(gasWei) / 1e18 };
}
