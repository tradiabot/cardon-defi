import { describe, expect, it } from 'vitest';
import { checkExecution, gate, netProfitPct, orderSize, stopLossSize } from '../src/strategy';
import { costBasis, desiredAiOrders, pickTriggered, reconcile, sellFloor, validateUserOrder, type Order } from '../src/orders';
import type { Settings } from '../src/config';
import type { AiDecision } from '../src/ai';

const s: Settings = {
  mode: 'paper', gasReservePol: 2, slippageBps: 50,
  wallet: '0x' + '1'.repeat(40), rpcs: [''], models: [], maxTradeUsdc: 2, maxTradesPerDay: 8, minConfidence: 65,
  minReserveUsdc: 0.5, minProfitPct: 1, stopLossPct: 3, cooldownMs: 15 * 60_000, aiEveryMs: 900_000, maxCostPct: 1, panelUrl: '',
};
const ai = (o: Partial<AiDecision> = {}): AiDecision => ({ action: 'BUY', confidence: 80, reason: 'plan', model: 'm', buyTrigger: 0.105, sellTrigger: 0.115, ...o });
const order = (o: Partial<Order>): Order => ({ id: 1, created_ts: 0, updated_ts: 0, side: 'BUY', trigger_price: 0.1, size_usd: 2, status: 'ACTIVA', source: 'IA', locked: 0, reason: '', expires_ts: null, trade_id: null, note: null, ...o });

describe('gate', () => {
  const g = { now: 0, paused: false, dataAgeMs: 0, staleMs: 900_000, tradesToday: 0, lastTradeTs: null };
  it('bloquea por pausa, datos viejos y límite diario', () => {
    expect(gate({ ...g, paused: true }, s)).toBe('PAUSADO');
    expect(gate({ ...g, dataAgeMs: 1e9 }, s)).toBe('DATOS_VIEJOS');
    expect(gate({ ...g, tradesToday: 8 }, s)).toBe('LIMITE_DIARIO');
    expect(gate(g, s)).toBeNull();
  });
});

describe('stop-loss solo sobre lo comprado por el bot', () => {
  it('no actúa sin unidades del bot aunque la posición caiga', () => {
    expect(stopLossSize(0.1, 50, 0, null, s)).toBeNull();
  });
  it('actúa al −3 % limitado a lo que compró el bot', () => {
    expect(stopLossSize(0.1, 50, 15, -4, s)).toBe(1.5);
    expect(stopLossSize(0.1, 50, 15, -2, s)).toBeNull();
    expect(stopLossSize(0.1, 50, 5, -4, s)).toBeNull();
  });
});

describe('tamaño y ejecución', () => {
  it('respeta reserva USDC y posición disponible', () => {
    expect(orderSize('BUY', 2, 1.2, 0, 0.1, s)).toEqual({ blocked: 'SIN_USDC' });
    expect(orderSize('BUY', 2, 2, 0, 0.1, s)).toEqual({ size: 1.5 });
    expect(orderSize('SELL', 2, 0, 5, 0.1, s)).toEqual({ blocked: 'SIN_POSICION' });
    expect(orderSize('SELL', 5, 0, 50, 0.1, s)).toEqual({ size: 2 });
  });
  it('venta solo con ganancia neta real (precio efectivo − gas), sin contar dos veces la comisión del DEX', () => {
    expect(netProfitPct({ costPct: 0.4, gasPct: 0.3, fillPrice: 0.102 }, 0.1)).toBeCloseTo(1.7);
    expect(checkExecution('SELL', { costPct: 0.4, gasPct: 0.3, fillPrice: 0.102 }, 0.1, s)).toBeNull();
    expect(checkExecution('SELL', { costPct: 0.4, gasPct: 0.3, fillPrice: 0.1012 }, 0.1, s)).toBe('GANANCIA_NETA_INSUFICIENTE');
    expect(checkExecution('SELL', { costPct: 0.4, gasPct: 0.3, fillPrice: 0.11 }, null, s)).toBe('SIN_COSTE_CONOCIDO');
  });
  it('coste DEX alto bloquea salvo stop-loss', () => {
    expect(checkExecution('BUY', { costPct: 1.5, gasPct: 0.1, fillPrice: 0.1 }, null, s)).toBe('COSTE_ALTO');
    expect(checkExecution('SELL', { costPct: 5, gasPct: 1, fillPrice: 0.09 }, 0.1, s, true)).toBeNull();
  });
});

describe('plan de órdenes de la IA', () => {
  const ctx = { price: 0.11, usdc: 6.5, sellableUnits: 30, avgCostUsd: 0.1 };
  it('crea compra por debajo del precio y venta por encima del suelo de ganancia', () => {
    const p = desiredAiOrders(ai(), ctx, s);
    expect(p.BUY).toMatchObject({ trigger: 0.105, sizeUsd: 2 });
    expect(p.SELL).toMatchObject({ trigger: 0.115, sizeUsd: 2 });
  });
  it('la venta nunca baja del suelo (coste + comisiones + ganancia mínima)', () => {
    expect(sellFloor(0.1, s)).toBeCloseTo(0.1016);
    expect(desiredAiOrders(ai({ sellTrigger: 0.09 }), ctx, s).SELL!.trigger).toBeCloseTo(0.1016);
  });
  it('recorta compras demasiado lejanas o por encima del precio', () => {
    expect(desiredAiOrders(ai({ buyTrigger: 0.05 }), ctx, s).BUY!.trigger).toBeCloseTo(0.1012);
    expect(desiredAiOrders(ai({ buyTrigger: 0.2 }), ctx, s).BUY!.trigger).toBe(0.11);
  });
  it('sin confianza, sin USDC o sin POL retira el lado correspondiente', () => {
    expect(desiredAiOrders(ai({ confidence: 40 }), ctx, s).BUY).toBeNull();
    expect(desiredAiOrders(ai({ action: 'SELL' }), ctx, s).BUY).toBeNull();
    expect(desiredAiOrders(ai(), { ...ctx, usdc: 1 }, s).BUY).toBeNull();
    expect(desiredAiOrders(ai(), { ...ctx, sellableUnits: 0 }, s).SELL).toBeNull();
    expect(desiredAiOrders(ai(), { ...ctx, avgCostUsd: null }, s).SELL).toBeNull();
  });
  it('si la IA falla, no toca las órdenes', () => {
    expect(desiredAiOrders(null, ctx, s)).toEqual({ BUY: undefined, SELL: undefined });
  });
});

describe('reconciliar órdenes', () => {
  it('crea, mueve solo si cambia > 0.2 %, cancela y respeta las editadas por el usuario', () => {
    const want = { BUY: { trigger: 0.105, sizeUsd: 2, reason: 'r' }, SELL: null };
    expect(reconcile([], want).create).toHaveLength(1);
    expect(reconcile([order({ trigger_price: 0.10505 })], want).update).toHaveLength(0);
    expect(reconcile([order({ trigger_price: 0.1 })], want).update).toHaveLength(1);
    const r = reconcile([order({ id: 2, side: 'SELL' }), order({ id: 3, side: 'SELL', source: 'USUARIO', locked: 1 })], want);
    expect(r.cancel.map(c => c.id)).toEqual([2]);
    expect(reconcile([order({ locked: 1, trigger_price: 0.09 })], want).create).toHaveLength(1);
  });
  it('elimina duplicados de la IA', () => {
    expect(reconcile([order({ id: 1 }), order({ id: 2 })], { BUY: { trigger: 0.1, sizeUsd: 2, reason: '' }, SELL: undefined }).cancel.map(c => c.id)).toEqual([2]);
  });
});

describe('disparo', () => {
  it('BUY se dispara al bajar del precio, SELL al subir; SELL tiene prioridad', () => {
    const os = [order({ id: 1, side: 'BUY', trigger_price: 0.105, created_ts: 1 }), order({ id: 2, side: 'SELL', trigger_price: 0.1, created_ts: 2 })];
    expect(pickTriggered(os, 0.104)?.id).toBe(2);
    expect(pickTriggered([os[0]], 0.104)?.id).toBe(1);
    expect(pickTriggered([os[0]], 0.106)).toBeNull();
    expect(pickTriggered([order({ status: 'CANCELADA', trigger_price: 1 })], 0.1)).toBeNull();
  });
});

describe('órdenes del usuario', () => {
  const c = { price: 0.11, avgCostUsd: 0.1 };
  it('valida lado, rango, monto y ganancia en ventas', () => {
    expect(validateUserOrder({ side: 'buy', triggerPrice: 0.105, amountUsdc: 2 }, c, s)).toEqual({ side: 'BUY', trigger: 0.105, sizeUsd: 2 });
    expect(validateUserOrder({ side: 'X', triggerPrice: 0.1, amountUsdc: 2 }, c, s)).toHaveProperty('error');
    expect(validateUserOrder({ side: 'BUY', triggerPrice: 0.01, amountUsdc: 2 }, c, s)).toHaveProperty('error');
    expect(validateUserOrder({ side: 'BUY', triggerPrice: 0.1, amountUsdc: 5 }, c, s)).toHaveProperty('error');
    expect((validateUserOrder({ side: 'SELL', triggerPrice: 0.1, amountUsdc: 2 }, c, s) as { error: string }).error).toContain('sin ganancia');
    expect(validateUserOrder({ side: 'SELL', triggerPrice: 0.12, amountUsdc: 2 }, c, s)).toMatchObject({ side: 'SELL' });
  });
});

describe('órdenes alcanzables según el rango de 6 h', () => {
  const ctx = { price: 0.11, usdc: 6.5, sellableUnits: 30, avgCostUsd: 0.1 };
  it('sube una compra lejana hasta justo bajo el mínimo de 6 h y baja una venta lejana hacia el máximo', () => {
    const range = { ...ctx, price: 0.1091, low6h: 0.1080, high6h: 0.1102, avgCostUsd: 0.1070 };
    const p = desiredAiOrders(ai({ buyTrigger: 0.105, sellTrigger: 0.13 }), range, s);
    expect(p.BUY!.trigger).toBeCloseTo(0.1080 * 0.997, 6);
    expect(p.SELL!.trigger).toBeCloseTo(0.1102 * 1.003, 6);
  });
  it('nunca baja la venta del suelo con ganancia', () => {
    const p = desiredAiOrders(ai({ sellTrigger: 0.13 }), { ...ctx, price: 0.1091, low6h: 0.108, high6h: 0.1102, avgCostUsd: 0.112 }, s);
    expect(p.SELL!.trigger).toBeCloseTo(0.112 * 1.016, 6);
  });
  it('el suelo usa el coste del bot, no la reserva de gas', () => {
    expect(costBasis({ units: 20, avgCostUsd: 0.112, botUnits: 18, botAvgCostUsd: 0.108 })).toBe(0.108);
    expect(costBasis({ units: 2, avgCostUsd: 0.112, botUnits: 0, botAvgCostUsd: 0 })).toBe(0.112);
  });
});

import { buyGuard } from '../src/strategy';

describe('freno a compras de la IA', () => {
  const base = { risk: 'NEUTRAL', riskAgeMs: 60_000, change1h: 0.2, price: 0.1, last30m: [0.101, 0.1005, 0.1002, 0.0999, 0.1001, 0.1, 0.1] };
  it('compra si el mercado está tranquilo o ya rebotó', () => {
    expect(buyGuard(base)).toBeNull();
    expect(buyGuard({ ...base, change1h: -0.6 })).toBeNull(); // baja, pero sobre el mínimo de 30 min: ya giró
  });
  it('aversión al riesgo global frena, salvo lectura vieja (>3 h)', () => {
    expect(buyGuard({ ...base, risk: 'RISK_OFF' })).toBe('RIESGO_GLOBAL');
    expect(buyGuard({ ...base, risk: 'RISK_OFF', riskAgeMs: 4 * 3_600_000 })).toBeNull();
  });
  it('caída activa: −1 % en 1 h, o mínimo nuevo de 30 min mientras baja', () => {
    expect(buyGuard({ ...base, change1h: -1.2 })).toBe('CAIDA_ACTIVA');
    expect(buyGuard({ ...base, change1h: -0.5, price: 0.0995, last30m: [...base.last30m.slice(0, -1), 0.0995] })).toBe('CAIDA_ACTIVA');
  });
});
