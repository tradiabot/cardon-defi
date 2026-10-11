export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) result = values[i] * k + result * (1 - k);
  return result;
}

export function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function pctChange(from: number, to: number): number {
  return from === 0 ? 0 : ((to - from) / from) * 100;
}

export interface Features {
  price: number;
  samples: number;
  emaFast: number | null;
  emaSlow: number | null;
  rsi: number | null;
  change1h: number | null;
  change24h: number | null;
  /** Mínimo/máximo reciente: dónde se mueve de verdad el precio (para órdenes alcanzables). */
  low6h?: number;
  high6h?: number;
  low24h?: number;
  high24h?: number;
}

const SAMPLES_PER_HOUR = 12;
const SAMPLES_PER_DAY = 288;

export function features(series: number[], change24h: number | null): Features {
  const price = series[series.length - 1];
  const last6h = series.slice(-6 * SAMPLES_PER_HOUR);
  const last24h = series.slice(-SAMPLES_PER_DAY);
  return {
    price,
    samples: series.length,
    emaFast: ema(series, 12),
    emaSlow: ema(series, 48),
    rsi: rsi(series, 14),
    change1h: series.length > SAMPLES_PER_HOUR ? pctChange(series[series.length - 1 - SAMPLES_PER_HOUR], price) : null,
    change24h: change24h ?? (series.length > SAMPLES_PER_DAY ? pctChange(series[series.length - 1 - SAMPLES_PER_DAY], price) : null),
    low6h: Math.min(...last6h), high6h: Math.max(...last6h),
    low24h: Math.min(...last24h), high24h: Math.max(...last24h),
  };
}

export type Action = 'BUY' | 'SELL' | 'HOLD';

export function technicalSignal(f: Features): Action {
  if (f.emaFast === null || f.emaSlow === null || f.rsi === null) return 'HOLD';
  const chasing = (f.change1h ?? 0) > 3;
  if (f.emaFast > f.emaSlow && f.rsi < 65 && !chasing) return 'BUY';
  if (f.emaFast < f.emaSlow && f.rsi > 35) return 'SELL';
  return 'HOLD';
}
