export interface Portfolio {
  usdc: number;
  units: number;
  avgCostUsd: number;
  realizedPnlUsd: number;
  seededAt: number;
  seedValueUsd: number;
  botUnits?: number;
  botAvgCostUsd?: number;
}

export function seed(usdc: number, units: number, price: number, now: number): Portfolio {
  return { usdc, units, avgCostUsd: price, realizedPnlUsd: 0, seededAt: now, seedValueUsd: usdc + units * price, botUnits: 0, botAvgCostUsd: 0 };
}

export function unrealizedPct(p: Portfolio, price: number): number | null {
  if (p.units <= 0 || p.avgCostUsd <= 0) return null;
  return ((price - p.avgCostUsd) / p.avgCostUsd) * 100;
}

export function botUnrealizedPct(p: Portfolio, price: number): number | null {
  const units = p.botUnits ?? 0;
  const avg = p.botAvgCostUsd ?? 0;
  if (units <= 0 || avg <= 0) return null;
  return ((price - avg) / avg) * 100;
}

export interface Fill {
  amountIn: number;
  amountOut: number;
  gasUsd: number;
}

export function applyFill(p: Portfolio, side: 'BUY' | 'SELL', f: Fill, fromBotUnits = false): { next: Portfolio; realized: number | null } {
  const botUnits = p.botUnits ?? 0;
  const botAvg = p.botAvgCostUsd ?? 0;
  if (side === 'BUY') {
    const spent = f.amountIn + f.gasUsd;
    const units = p.units + f.amountOut;
    const costBasis = p.units * p.avgCostUsd + spent;
    const nextBot = botUnits + f.amountOut;
    return {
      next: { ...p, usdc: Math.max(0, p.usdc - spent), units, avgCostUsd: costBasis / units, botUnits: nextBot, botAvgCostUsd: (botUnits * botAvg + spent) / nextBot },
      realized: null,
    };
  }
  const sold = Math.min(f.amountIn, p.units);
  const realized = f.amountOut - f.gasUsd - sold * p.avgCostUsd;
  const units = p.units - sold;
  const botSold = fromBotUnits ? Math.min(sold, botUnits) : Math.max(0, Math.min(botUnits, sold - (p.units - botUnits)));
  const nextBot = botUnits - botSold;
  return {
    next: {
      ...p, usdc: p.usdc + f.amountOut - f.gasUsd, units, avgCostUsd: units > 1e-12 ? p.avgCostUsd : 0, realizedPnlUsd: p.realizedPnlUsd + realized,
      botUnits: nextBot > 1e-12 ? nextBot : 0, botAvgCostUsd: nextBot > 1e-12 ? botAvg : 0,
    },
    realized,
  };
}

export function applyTrade(p: Portfolio, side: 'BUY' | 'SELL', f: Fill, fromBotUnits = false): { next: Portfolio; realized: number | null } {
  if (side === 'BUY' && f.amountIn + f.gasUsd > p.usdc + 1e-9) throw new Error('USDC insuficiente en cartera paper');
  if (side === 'SELL' && f.amountIn > p.units + 1e-9) throw new Error('POL insuficiente en cartera paper');
  return applyFill(p, side, f, fromBotUnits);
}
