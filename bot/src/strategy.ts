import type { Settings } from './config';
import type { Side } from './orders';

export interface GateInput {
  now: number;
  paused: boolean;
  dataAgeMs: number;
  staleMs: number;
  tradesToday: number;
  lastTradeTs: number | null;
}

export function gate(i: GateInput, s: Settings): string | null {
  if (i.paused) return 'PAUSADO';
  if (i.dataAgeMs > i.staleMs) return 'DATOS_VIEJOS';
  if (i.tradesToday >= s.maxTradesPerDay) return 'LIMITE_DIARIO';
  return null;
}

export const MIN_TRADE_USD = 1;

export function stopLossSize(price: number, units: number, botUnits: number, botUnrealizedPct: number | null, s: Settings): number | null {
  if (botUnrealizedPct === null || botUnrealizedPct > -s.stopLossPct) return null;
  const size = Math.min(s.maxTradeUsdc, Math.min(botUnits, units) * price);
  return size >= MIN_TRADE_USD ? size : null;
}

export function orderSize(side: Side, wanted: number, usdc: number, units: number, price: number, s: Settings): { size: number } | { blocked: string } {
  const available = side === 'BUY' ? usdc - s.minReserveUsdc : units * price;
  const size = Math.min(wanted, s.maxTradeUsdc, available);
  if (size < MIN_TRADE_USD) return { blocked: side === 'BUY' ? 'SIN_USDC' : 'SIN_POSICION' };
  return { size };
}

export interface Fill {
  costPct: number;
  gasPct: number;
  fillPrice: number;
}

export function netProfitPct(fill: Fill, avgCostUsd: number): number {
  return ((fill.fillPrice - avgCostUsd) / avgCostUsd) * 100 - fill.gasPct;
}

export function checkExecution(side: Side, fill: Fill, avgCostUsd: number | null, s: Settings, stopLoss = false): string | null {
  if (stopLoss) return null;
  if (fill.costPct > s.maxCostPct) return 'COSTE_ALTO';
  if (side === 'SELL') {
    if (!avgCostUsd || avgCostUsd <= 0) return 'SIN_COSTE_CONOCIDO';
    if (netProfitPct(fill, avgCostUsd) < s.minProfitPct) return 'GANANCIA_NETA_INSUFICIENTE';
  }
  return null;
}

export const RISK_MAX_AGE_MS = 3 * 3_600_000;
export const KNIFE_CHANGE_1H = -1;

/**
 * Freno a las compras de la IA (las órdenes del usuario no se frenan: son decisión suya):
 * - RIESGO_GLOBAL: el panorama global marca aversión al riesgo (lectura de menos de 3 h);
 * - CAIDA_ACTIVA: POL cae ≥1 % en la última hora, o marca un mínimo nuevo de 30 min mientras baja.
 * La orden queda ACTIVA y se ejecuta en cuanto pase el freno y siga disparada.
 */
export function buyGuard(i: { risk: string | null; riskAgeMs: number; change1h: number | null; price: number; last30m: number[] }): string | null {
  if (i.risk === 'RISK_OFF' && i.riskAgeMs <= RISK_MAX_AGE_MS) return 'RIESGO_GLOBAL';
  const ch = i.change1h ?? 0;
  if (ch <= KNIFE_CHANGE_1H) return 'CAIDA_ACTIVA';
  const prior = i.last30m.slice(0, -1);
  if (prior.length >= 3 && i.price <= Math.min(...prior) && ch < -0.3) return 'CAIDA_ACTIVA';
  return null;
}
