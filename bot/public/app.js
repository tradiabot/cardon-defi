const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (v, d = 2) => (v == null || !Number.isFinite(+v) ? '—' : '$' + (+v).toLocaleString('es', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmt = (v, d = 4) => (v == null || !Number.isFinite(+v) ? '—' : (+v).toLocaleString('es', { maximumFractionDigits: d }));
const pct = v => (v == null || !Number.isFinite(+v) ? '—' : `${v >= 0 ? '+' : ''}${(+v).toFixed(2)}%`);
const sign = v => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const time = ts => new Date(ts).toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const ago = ms => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
const kv = rows => rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
const statusCls = st => (st === 'CONFIRMADA' ? 'pos' : ['FALLIDA', 'DESCONOCIDA', 'ERROR_ENVIO'].includes(st) ? 'neg' : st === 'SIMULADA' ? 'muted' : 'warn');
const actionCls = a => (a === 'BUY' ? 'pos' : a === 'SELL' ? 'neg' : 'muted');

async function get(path) {
  const res = await fetch(path, { cache: 'no-store' });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function renderStatus(s) {
  const c = s.cycle;
  const age = c ? s.now - c.ts : null;
  const engine = $('engine');
  if (s.control.paused) { engine.textContent = 'PAUSADO'; engine.className = 'pill bad'; }
  else if (!c) { engine.textContent = 'SIN CICLOS'; engine.className = 'pill warn'; }
  else if (age > 15 * 60_000) { engine.textContent = 'CRON DETENIDO'; engine.className = 'pill bad'; }
  else if (!c.ok) { engine.textContent = 'CON ERRORES'; engine.className = 'pill warn'; }
  else { engine.textContent = 'EN MARCHA'; engine.className = 'pill ok'; }

  for (const sym of ['POL', 'DOT']) {
    const p = c?.prices?.[sym];
    $(`${sym.toLowerCase()}-price`).textContent = usd(p?.usd, 4);
    const ch = $(`${sym.toLowerCase()}-change`);
    ch.textContent = p ? `${pct(p.change24h)} en 24 h · ${p.source}` : 'sin dato';
    ch.className = `muted ${sign(p?.change24h)}`;
  }

  const live = s.mode === 'LIVE';
  const mode = $('mode');
  mode.textContent = live ? (s.signing ? 'REAL · FIRMANDO' : 'REAL · SIN CLAVE') : 'PAPER · SIN FIRMA';
  mode.className = live ? (s.signing ? 'pill bad' : 'pill warn') : 'pill warn';
  mode.title = live ? `Opera con dinero real · deslizamiento máx. ${s.slippageBps / 100}% · reserva gas ${s.gasReservePol} POL` : 'Simula con cotizaciones DEX reales; no firma transacciones';
  $('book-title').textContent = live ? 'Cartera real' : 'Cartera paper';
  const paper = s.paper;
  $('paper-value').textContent = usd(paper?.valueUsd);
  $('paper-pnl').innerHTML = paper?.pnlUsd != null
    ? `<span class="${sign(paper.pnlUsd)}">${usd(paper.pnlUsd)}</span> desde ${esc(time(paper.seededAt))} · realizado ${usd(paper.realizedPnlUsd)}`
    : 'Se inicializa en el primer ciclo';

  $('cycle-age').textContent = age == null ? '—' : `hace ${ago(age)}`;
  $('cycle-info').textContent = c ? `${c.durationMs} ms · cron cada 5 min` : 'Aún no ha corrido el cron';

  const d = c?.decision;
  const f = c?.features;
  $('decision').innerHTML = d ? kv([
    ['Final', `<strong class="${actionCls(d.final)}">${esc(d.final)}</strong>${d.trigger ? ` · ${esc(d.trigger)}` : ''}`],
    ['Bloqueado por', esc(d.blockedBy || '—')],
    ['Señal técnica', `<span class="${actionCls(d.technical)}">${esc(d.technical)}</span>`],
    ['IA', d.ai ? `<span class="${actionCls(d.ai.action)}">${esc(d.ai.action)}</span> · ${fmt(d.ai.confidence, 0)}% · ${esc(d.ai.model)}` : '<span class="neg">no disponible</span>'],
    ['Razón IA', esc(d.ai?.reason || '—')],
    ['EMA 12 / 48', f ? `${fmt(f.emaFast, 5)} / ${fmt(f.emaSlow, 5)}` : '—'],
    ['RSI 14', fmt(f?.rsi, 1)],
    ['Cambio 1 h', pct(f?.change1h)],
    ['Muestras', f ? `${f.samples} ${f.samples < 49 ? '(calentando: hacen falta 49 para EMA 48)' : ''}` : '—'],
  ]) : '<dt>—</dt><dd>Sin decisiones todavía</dd>';

  const price = c?.prices?.POL?.usd;
  const upnl = paper?.units > 0 && paper.avgCostUsd > 0 && price ? ((price - paper.avgCostUsd) / paper.avgCostUsd) * 100 : null;
  $('position').innerHTML = paper ? kv([
    ['USDC', fmt(paper.usdc, 2)],
    ['POL', fmt(paper.units, 4)],
    ['Coste medio', usd(paper.avgCostUsd, 5)],
    ['P/L abierto', `<span class="${sign(upnl)}">${pct(upnl)}</span>`],
  ]) : '<dt>—</dt><dd>Sin inicializar</dd>';
  const oc = c?.onchain || c?.onchainLast;
  const stale = !c?.onchain && oc ? ` <span class="warn">(hace ${ago(s.now - oc.ts)})</span>` : '';
  $('onchain').innerHTML = kv([
    ['Dirección', `<code>${esc(s.wallet.slice(0, 8))}…${esc(s.wallet.slice(-6))}</code>`],
    ['POL', oc ? fmt(oc.POL, 4) + stale : '<span class="neg">sin lectura</span>'],
    ['USDC', oc ? fmt(oc.USDC, 2) + stale : '<span class="neg">sin lectura</span>'],
  ]);

  const errors = c?.errors || [];
  const warnings = c?.warnings || [];
  $('errors-card').hidden = errors.length + warnings.length === 0;
  $('errors').innerHTML = errors.map(e => `<li>${esc(e)}</li>`).join('') + warnings.map(w => `<li class="warn">Aviso: ${esc(w)}</li>`).join('');

  const l = s.limits;
  $('limits').innerHTML = kv([
    ['Máx. por operación', `${l.maxTradeUsdc} USDC`],
    ['Máx. operaciones/día', l.maxTradesPerDay],
    ['Confianza mínima IA', `${l.minConfidence}%`],
    ['Reserva USDC', `${l.minReserveUsdc} USDC`],
    ['Ganancia neta mínima', `${l.minProfitPct}%`],
    ['Stop-loss', `-${l.stopLossPct}%`],
    ['Enfriamiento', `${l.cooldownMinutes} min`],
    ['Coste DEX máximo', `${l.maxCostPct}%`],
    ['IA', s.ai.configured ? esc(s.ai.models.join(' → ')) : '<span class="neg">GROQ_API_KEY no configurada</span>'],
  ]);
  $('control-state').textContent = s.control.paused
    ? `Pausado ${s.control.changedAt ? 'desde ' + time(s.control.changedAt) : ''}${s.control.reason ? ' · ' + s.control.reason : ''}`
    : s.admin.configured ? 'Activo. Los controles requieren el token.' : 'ADMIN_TOKEN no configurado: controles desactivados.';
}

function renderChart(prices) {
  const svg = $('chart');
  if (prices.length < 2) { svg.innerHTML = ''; $('chart-meta').textContent = 'Acumulando datos…'; return; }
  const ys = prices.map(p => p.usd);
  const min = Math.min(...ys), max = Math.max(...ys), span = max - min || max * 0.01;
  const t0 = prices[0].ts, t1 = prices[prices.length - 1].ts;
  const pts = prices.map(p => [((p.ts - t0) / (t1 - t0 || 1)) * 600, 150 - ((p.usd - min) / span) * 140]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  svg.innerHTML = `<path class="area" d="${line}L600,160L0,160Z"/><path class="line" d="${line}"/>`;
  $('chart-meta').textContent = `mín ${usd(min, 4)} · máx ${usd(max, 4)} · ${prices.length} puntos`;
}

function renderTrades(rows) {
  $('trades').innerHTML = rows.length ? rows.map(t => `<tr>
    <td>${esc(time(t.ts))}</td><td class="${actionCls(t.side)}">${esc(t.side)}</td>
    <td>${fmt(t.amount_in)} ${t.side === 'BUY' ? 'USDC' : 'POL'}</td><td>${fmt(t.amount_out)} ${t.side === 'BUY' ? 'POL' : 'USDC'}</td>
    <td>${usd(t.price_usd, 5)}</td><td>${pct(t.cost_pct)}</td>
    <td class="${sign(t.realized_pnl_usd)}">${t.realized_pnl_usd == null ? '—' : usd(t.realized_pnl_usd, 4)}</td>
    <td class="${statusCls(t.status)}">${/^0x[0-9a-fA-F]{64}$/.test(t.tx_hash || '') ? `<a href="https://polygonscan.com/tx/${t.tx_hash}" target="_blank" rel="noopener">${esc(t.status)}</a>` : esc(t.status)}</td>
    <td class="wrap">${esc(t.error || t.reason)}</td></tr>`).join('') : '<tr><td colspan="9" class="muted">Sin operaciones</td></tr>';
}

function renderDecisions(rows) {
  $('decisions').innerHTML = rows.length ? rows.map(d => `<tr>
    <td>${esc(time(d.ts))}</td><td class="${actionCls(d.technical)}">${esc(d.technical)}</td>
    <td class="${actionCls(d.ai_action)}">${esc(d.ai_action || '—')}</td><td>${d.ai_confidence == null ? '—' : fmt(d.ai_confidence, 0) + '%'}</td>
    <td class="${actionCls(d.final)}"><strong>${esc(d.final)}</strong></td><td>${esc(d.blocked_by || '—')}</td>
    <td class="wrap">${esc(d.ai_reason || d.ai_error || '')}</td></tr>`).join('') : '<tr><td colspan="7" class="muted">Sin decisiones</td></tr>';
}

function renderOrders(rows, s) {
  const active = rows.filter(o => o.status === 'ACTIVA').length;
  const floor = s.cycle?.orders?.sellFloor;
  $('orders-meta').textContent = `${active} activas${floor ? ` · venta mínima con ganancia ${usd(floor, 5)}` : ''}`;
  $('orders').innerHTML = rows.length ? rows.map(o => `<tr>
    <td>${o.id}</td><td class="${actionCls(o.side)}">${esc(o.side)}</td><td>${usd(o.trigger_price, 5)}</td><td>${fmt(o.size_usd, 2)} USDC</td>
    <td class="${o.status === 'ACTIVA' ? 'warn' : o.status === 'EJECUTADA' ? 'pos' : 'muted'}">${esc(o.status)}</td>
    <td>${esc(o.source)}${o.locked ? ' · editada' : ''}</td>
    <td class="wrap">${esc(o.note || o.reason)}</td>
    <td>${o.status === 'ACTIVA' ? `<button data-edit="${o.id}" data-trigger="${o.trigger_price}" data-size="${o.size_usd}">Editar</button> <button class="danger" data-cancel="${o.id}">Cancelar</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="8" class="muted">La IA creará órdenes cuando tenga suficiente historial y USDC/POL disponibles</td></tr>';
}

$('orders').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.cancel && confirm(`¿Cancelar la orden #${b.dataset.cancel}?`)) admin(`/api/admin/orders/${b.dataset.cancel}/cancel`);
  if (b.dataset.edit) {
    const trigger = prompt('Nuevo precio de disparo (USDC por POL)', Number(b.dataset.trigger).toFixed(5));
    if (trigger === null) return;
    const size = prompt('Nuevo monto (USDC)', b.dataset.size);
    if (size === null) return;
    admin(`/api/admin/orders/${b.dataset.edit}/edit`, { triggerPrice: Number(trigger), amountUsdc: Number(size) });
  }
});

async function refresh() {
  try {
    const [s, p, t, d, o] = await Promise.all([get('/api/status'), get('/api/prices?symbol=POL&hours=24'), get('/api/trades?limit=20'), get('/api/decisions?limit=20'), get('/api/orders?limit=30')]);
    renderStatus(s); renderChart(p.prices); renderTrades(t.trades); renderDecisions(d.decisions); renderOrders(o.orders, s);
  } catch (error) {
    $('engine').textContent = 'API NO RESPONDE'; $('engine').className = 'pill bad';
    $('errors-card').hidden = false; $('errors').innerHTML = `<li>${esc(error.message)}</li>`;
  }
}

let storedToken = '';
try { storedToken = localStorage.getItem('dexpilot-token') || ''; } catch {}
$('token').value = storedToken;

async function admin(path, body) {
  const token = $('token').value.trim();
  try { localStorage.setItem('dexpilot-token', token); } catch {}
  const msg = $('control-msg');
  const buttons = document.querySelectorAll('.actions button');
  buttons.forEach(b => (b.disabled = true));
  msg.textContent = 'Enviando…';
  try {
    const res = await fetch(path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    msg.textContent = data.skipped ? `Omitido: ${data.skipped}` : 'Hecho';
    await refresh();
  } catch (error) {
    msg.textContent = `Error: ${error.message}`;
  } finally {
    buttons.forEach(b => (b.disabled = false));
  }
}

$('btn-pause').onclick = () => admin('/api/admin/pause', { reason: 'Pausa manual desde el panel' });
$('btn-resume').onclick = () => admin('/api/admin/resume');
$('btn-run').onclick = () => admin('/api/admin/run');

refresh();
setInterval(refresh, 30_000);
