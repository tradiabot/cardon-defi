import { type Env } from './config';
import { loadMarket } from './context';
import { getKv } from './db';
import { MARKETS, market, VENUES, type Market } from './markets';
import { baseOf } from './venues';
import { loadAi } from './aiConfig';
import { brief, type Macro } from './macro';
import { costBasis, sellFloor, validateUserOrder, type Order } from './orders';
import { callModel, CallError, extractJson, modelLabel, type ChatMessage } from './providers';

/**
 * Chat de la app: el usuario pregunta y la IA responde con el contexto real del bot y, si viene al caso,
 * propone órdenes condicionales. Las propuestas NUNCA se crean solas: se validan con las mismas reglas
 * que una orden manual y la app muestra «Crear orden» para que el usuario decida.
 */
export interface Proposal { market: string; side: 'BUY' | 'SELL'; triggerPrice: number; amountUsdc: number; reason: string; valid: boolean; error?: string }
export interface Answer { model: string; label: string; ok: boolean; ms: number; reply?: string; proposals?: Proposal[]; error?: string }

const SYSTEM = `Eres el asistente de trading de DEX Pilot, un bot spot de criptomonedas contra USDC en DEX (autocustodia) que opera con órdenes condicionales. El par y la red de esta conversación vienen en "par" y "red" del contexto.
Responde en español, claro y breve (máx. 120 palabras), usando SOLO los datos de "contexto". Si un dato no está, dilo.
Puedes proponer órdenes condicionales cuando el usuario las pida o cuando tengan sentido:
- BUY: trigger_price POR DEBAJO del precio actual (se ejecuta al bajar hasta ahí); realista según low6h/low24h.
- SELL: trigger_price por encima del precio y NUNCA por debajo de sell_floor (ya incluye costes y la ganancia mínima). Solo si hay monedas compradas por el bot.
- amount_usdc entre 1 y max_trade_usdc.
Considera el contexto global (riesgo, bolsa, dólar, noticias) como filtro. No prometas ganancias; menciona el riesgo principal.
Responde SOLO un objeto JSON: {"reply":"texto para el usuario","proposals":[{"side":"BUY"|"SELL","trigger_price":número,"amount_usdc":número,"reason":"máx 120 caracteres"}]}
proposals puede ser [] si no conviene operar.`;

async function context(env: Env, m: Market) {
  const [{ s, cycle, book, price }, macro, orders, trades] = await Promise.all([
    loadMarket(env, m),
    getKv<Macro>(env.DB, 'macro'),
    env.DB.prepare("SELECT * FROM orders WHERE status = 'ACTIVA' AND symbol = ? ORDER BY id DESC LIMIT 10").bind(m.id).all<Order>(),
    env.DB.prepare('SELECT ts, side, amount_in, amount_out, price_usd, realized_pnl_usd, status FROM trades WHERE symbol = ? ORDER BY id DESC LIMIT 5').bind(m.id).all(),
  ]);
  const avg = book ? costBasis(book) : null;
  const balances = cycle?.onchain ?? cycle?.onchainLast;
  return {
    m, s, price, avg,
    data: {
      par: `${m.id}/USDC`, red: VENUES[m.venue].name, modo: s.mode === 'live' ? 'real' : 'simulación', precio: price, indicadores: cycle?.features ?? null,
      saldo: balances ? { [m.id]: baseOf(balances), USDC: balances.USDC, reserva_gas: s.gasReservePol } : null,
      posicion_bot: book ? { comprado_por_el_bot: book.botUnits ?? 0, coste_medio: avg, pnl_realizado_usd: book.realizedPnlUsd } : null,
      sell_floor: sellFloor(avg, s),
      reglas: { max_trade_usdc: s.maxTradeUsdc, min_ganancia_pct: s.minProfitPct, stop_loss_pct: s.stopLossPct },
      ordenes_activas: orders.results.map(o => ({ id: o.id, lado: o.side, disparo: o.trigger_price, usd: o.size_usd, origen: o.source })),
      ultimas_operaciones: trades.results,
      plan_ia_actual: cycle?.aiPlan?.decision ? { accion: cycle.aiPlan.decision.action, confianza: cycle.aiPlan.decision.confidence, motivo: cycle.aiPlan.decision.reason } : null,
      global: brief(macro),
      titulares: macro ? [...macro.news.economia.slice(0, 3), ...macro.news.politica.slice(0, 3), ...macro.news.cripto.slice(0, 3)].map(h => h.title) : [],
    },
  };
}

function proposals(raw: unknown, c: Awaited<ReturnType<typeof context>>): Proposal[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 3).map(p => {
    const side = String((p as Record<string, unknown>).side ?? '').toUpperCase() as Proposal['side'];
    const triggerPrice = Number((p as Record<string, unknown>).trigger_price);
    const amountUsdc = Number((p as Record<string, unknown>).amount_usdc);
    const reason = String((p as Record<string, unknown>).reason ?? '').slice(0, 160);
    const v = validateUserOrder({ side, triggerPrice, amountUsdc }, { price: c.price, avgCostUsd: c.avg }, c.s);
    let error = 'error' in v ? v.error : undefined;
    if (!error && side === 'BUY' && triggerPrice >= c.price) error = 'Una compra condicional debe estar por debajo del precio actual';
    return { market: c.m.id, side, triggerPrice, amountUsdc, reason, valid: !error, ...(error ? { error } : {}) };
  });
}

export async function chat(env: Env, body: { message?: unknown; history?: unknown; consensus?: unknown; market?: unknown }): Promise<{ answers: Answer[] } | { error: string }> {
  const message = String(body.message ?? '').trim().slice(0, 600);
  if (!message) return { error: 'Escribe una pregunta' };
  const history = (Array.isArray(body.history) ? body.history : [])
    .slice(-6)
    .filter((m): m is { role: string; content: string } => typeof m?.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content.slice(0, 800) }));
  const [ai, c, blocked] = await Promise.all([loadAi(env), context(env, market(body.market as string) ?? MARKETS.POL), getKv<Record<string, number>>(env.DB, 'ai_cooldown')]);
  const now = Date.now();
  const pool = ai.models.filter(m => (blocked?.[m] ?? 0) <= now);
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `contexto: ${JSON.stringify(c.data)}` },
    ...history,
    { role: 'user', content: message },
  ];
  const ask = async (model: string): Promise<Answer> => {
    const t = Date.now();
    try {
      const d = extractJson<{ reply?: unknown; proposals?: unknown }>(await callModel(model, ai.keys, messages, { budget: 900, now }));
      return { model, label: modelLabel(model), ok: true, ms: Date.now() - t, reply: String(d.reply ?? '').slice(0, 1500), proposals: proposals(d.proposals, c) };
    } catch (error) {
      return { model, label: modelLabel(model), ok: false, ms: Date.now() - t, error: (error instanceof CallError || error instanceof Error ? error.message : String(error)).slice(0, 200) };
    }
  };
  if (body.consensus) return { answers: await Promise.all(pool.slice(0, Math.max(2, ai.consensus.size)).map(ask)) };
  const answers: Answer[] = [];
  for (const m of pool) {
    const a = await ask(m);
    answers.push(a);
    if (a.ok) break;
  }
  return answers.length ? { answers } : { error: 'Todas las IAs están en pausa por límite; prueba en unos minutos' };
}
