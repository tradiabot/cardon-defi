function cardonApi() {
  let saved = "";
  try {
    saved = localStorage.getItem("cardon-api") || "";
  } catch (e) {}
  return saved || (window.CARDON && window.CARDON.api) || "";
}
const API = (window.DEFI_API_BASE || cardonApi()).replace(/\/$/, "");
function cloudToken() {
  try {
    return localStorage.getItem("dexpilot-token") || "";
  } catch (e) {
    return "";
  }
}
let cache = { status: null, orders: [], logs: [], policies: [], config: {} };
let nativeEngine = { running: false, mode: "UNAVAILABLE", detail: "Supervisor nativo no disponible" };
let autoTradingSession = { active: false, sessionId: null, expiresAt: null, swapsUsedToday: 0, maxSwapsPerDay: 8 };
const mock = {
  status: {
    portfolio_value_usd: 700.55,
    pnl_1d_usd: 2.64,
    pnl_1d_pct: 0.38,
    runner: "ONLINE",
    ai_status: "fallback",
    active_policy: "ai_dynamic_policy",
    heartbeat: "ok",
    mode: "semi",
    emergency_stop: false,
  },
  market: { POL: { price: 0.3124, change24h: 1.2, trend1d: "UP", trend7d: "RANGE" }, DOT: { price: 4.184, change24h: -0.4, trend1d: "DOWN", trend7d: "UP" } },
  assets: {
    USDC: { available: 482.16, valueUsd: 482.16 },
    POL: { available: 412.5, valueUsd: 128.85, avgCost: 0.287 },
    DOT: { available: 21.4, valueUsd: 89.54, avgCost: 3.92 },
  },
  signals: [
    { symbol: "POL", action: "HOLD", confidence: 78, reason: "Protección de capital y espera de edge neto", source: "ai_dynamic_policy" },
    { symbol: "DOT", action: "HOLD", confidence: 78, reason: "Datos mock: no forzar operación sin edge", source: "ai_grid_policy" },
  ],
};
mock.status = { ...mock.status, portfolio_value_usd: 0, pnl_1d_usd: 0, pnl_1d_pct: 0, runner: "PAUSED", emergency_stop: true };
mock.assets = { USDC: { available: 0, valueUsd: 0 }, POL: { available: 0, valueUsd: 0, avgCost: 0 }, DOT: { available: 0, valueUsd: 0, avgCost: 0 } };
let MARKET = (() => {
  try {
    const v = localStorage.getItem("dexpilot-market");
    return /^[A-Z0-9]{2,8}$/.test(v || "") ? v : "POL";
  } catch (e) {
    return "POL";
  }
})();
/* Cada petición lleva el mercado elegido; el servidor responde con los datos de ese mercado. */
let GLOBAL = (() => {
  try {
    return localStorage.getItem("dexpilot-global") !== "0";
  } catch (e) {
    return true;
  }
})();
function withMarket(path) {
  if (GLOBAL && path === "/orders") return path;
  return /[?&]market=/.test(path) ? path : path + (path.includes("?") ? "&" : "?") + "market=" + encodeURIComponent(MARKET);
}
async function api(path, options) {
  if (!API) return null;
  let r;
  try {
    const token = cloudToken();
    r = await fetch(API + withMarket(path), {
      ...options,
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "API " + r.status);
    return data;
  } catch (e) {
    refreshNativeEngine();
    toast(r ? e.message : "Sin conexión con Cardón DeFi (Cloudflare): " + e.message);
    return null;
  }
}
function money(v) {
  return "$" + Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function assetDecimals(symbol) {
  return symbol === "USDC" ? 2 : 6;
}
function assetAmount(symbol, value) {
  return Number(value || 0).toFixed(assetDecimals(symbol));
}
function assetPrice(symbol, value) {
  const v = Number(value || 0),
    a = Math.abs(v);
  return "$" + v.toFixed(a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 7);
}
function el(id) {
  return document.getElementById(id);
}
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#5eeec8";
}
function toast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3500);
}
let cycleEndsAt = 0,
  cycleDuration = 120;
function setCycleTiming(status) {
  cycleDuration = Math.max(1, Number(status.cycle_seconds || 120));
  cycleEndsAt = Date.now() + Math.max(0, Number(status.next_cycle_seconds || 0)) * 1000;
  updateCycleProgress();
}
function updateCycleProgress() {
  const countdown = el("cycle-countdown"),
    progress = el("cycle-progress"),
    note = el("cycle-note");
  if (!countdown || !progress || !note) return;
  const remaining = Math.max(0, Math.ceil((cycleEndsAt - Date.now()) / 1000)),
    elapsed = Math.max(0, Math.min(1, 1 - remaining / cycleDuration));
  countdown.textContent = remaining + "s";
  progress.style.width = (elapsed * 100).toFixed(1) + "%";
  note.textContent =
    remaining > 0 ? `Ciclo de ${cycleDuration}s · análisis y propuestas automáticas.` : "Ciclo en ejecución o esperando actualización del backend.";
}
function setConnection(ok) {
  const c = el("conn");
  const real = cache.status?.real_readonly;
  c.textContent = ok ? cache.status?.execution_status || "CLOUDFLARE" : "SIN CONEXIÓN";
  c.className = "pill " + (ok ? "" : "warn");
}
async function refresh() {
  const [s, a, m, g, c, l, pf] = await Promise.all([
    api("/status"),
    api("/assets"),
    api("/market"),
    api("/signals"),
    api("/chain/status"),
    api("/pilot/learning"),
    api("/portfolio"),
  ]);
  if (pf?.real) cache.portfolio = pf;
  const live = !!(s && a && m && g);
  cache.status = s || mock.status;
  cache.status.market = m?.market || mock.market;
  cache.status.chains = c;
  cache.assets = a?.assets || mock.assets;
  cache.signals = g?.signals || mock.signals;
  cache.learning = l || cache.status.learning || { pending: [], outcomes: [] };
  setConnection(live);
  render();
  renderLearning();
  loadOrders();
  loadPolicies();
  loadLogs();
  loadConfig();
  loadMarkets();
}
function render() {
  const s = cache.status,
    a = cache.assets,
    m = s.market || mock.market,
    ai = s.ai || {};
  setCycleTiming(s);
  el("total").textContent = money(s.portfolio_value_usd);
  renderPnl(s);
  el("runner").textContent = s.runner + (s.emergency_stop ? " / STOP" : "");
  el("runner").className = "pill " + (s.emergency_stop ? "bad" : "");
  el("heartbeat").textContent = s.heartbeat || "offline";
  const executionLabel = window.AndroidWallet && !s.real_execution ? "PILOTO · FIRMA LOCAL" : s.execution_status || "SUPERVISED_PILOT";
  el("status-dl").innerHTML =
    `<dt>Mercado</dt><dd>${MARKET}/USDC${s.market_venue ? " · " + s.market_venue : ""}${s.market_mode ? (s.market_mode === "live" ? " · REAL" : " · SIMULACIÓN") : ""}</dd><dt>Modo</dt><dd>${s.mode || "semi"}</dd><dt>Ejecución</dt><dd class="${s.real_execution ? "positive" : "warn"}">${executionLabel}</dd><dt>IA</dt><dd>${String(s.ai_status || "sin datos").toUpperCase()}</dd><dt>Modelo</dt><dd>${ai.model || "--"}</dd><dt>Supervisor</dt><dd>${ai.status || "--"} ${ai.latencyMs ? `· ${ai.latencyMs}ms` : ""}</dd><dt>Perfil</dt><dd>${s.active_policy || "--"}</dd><dt>Próximo ciclo</dt><dd>${s.next_cycle_seconds || "--"}s</dd>`;
  const chains = cache.status.chains?.chains || [];
  el("chain-status").innerHTML =
    chains
      .map(
        (c) =>
          `${c.name}: <span class="${c.status === "ONLINE" ? "positive" : "negative"}">${c.status}</span>${c.block_number ? ` · bloque ${c.block_number}` : ""}`,
      )
      .join("<br>") || "RPC real no habilitado";
  el("asset-cards").innerHTML = ["USDC", ...Object.keys(a).filter((k) => k !== "USDC" && /^[A-Z0-9]{2,8}$/.test(k))]
    .map(
      (x) =>
        `<article class="asset-card"><span class="ticker">${x}</span><strong>${money(a[x]?.valueUsd || a[x]?.available)}</strong><small>${assetAmount(x, a[x]?.available)} ${x}</small></article>`,
    )
    .join("");
  el("signals").innerHTML = cache.signals
    .map(
      (x) =>
        `<div class="signal"><div class="signal-head"><span><b>${x.symbol}</b> · ${x.source}</span><strong>${x.action}</strong></div><p>${x.reason} · confianza ${x.confidence}%</p></div>`,
    )
    .join("");
  ["POL", "DOT"].forEach((x) =>
    renderAsset(
      x,
      m[x],
      a[x],
      cache.signals.find((s) => s.symbol === x),
    ),
  );
  if (el("desk-chart")) loadDeskChart();
  renderGlobal();
  syncAssetDetails();
}
/* Detalle por moneda (lo que antes eran las pestañas POL y DOT): en Global quedan plegados; al elegir una moneda se abre el suyo. */
function syncAssetDetails() {
  const view = typeof GLOBAL !== "undefined" && GLOBAL ? "GLOBAL" : typeof MARKET !== "undefined" ? MARKET : "POL";
  const changed = window.assetDetailView !== view;
  window.assetDetailView = view;
  let shown = 0;
  document.querySelectorAll(".asset-detail").forEach((d) => {
    const id = d.dataset.asset,
      market = (cache.markets || []).find((m) => m.id === id);
    d.hidden = (cache.markets || []).length ? !(market && market.enabled) || (view !== "GLOBAL" && view !== id) : false;
    if (changed) d.open = view === id;
    if (!d.hidden) shown++;
    if (!d.dataset.bound) {
      d.dataset.bound = "1";
      d.addEventListener("toggle", () => {
        if (d.open) loadAssetChart(id, window.chartRanges?.[id] || "1h");
      });
    }
  });
  const box = el("asset-details");
  if (box) box.hidden = !shown;
}
function renderLearning() {
  const target = el("learning-summary");
  if (!target) return;
  const pending = cache.learning?.pending || [],
    outcomes = cache.learning?.outcomes || [],
    wins = outcomes.filter((item) => item.correct).length,
    rate = outcomes.length ? `${((wins / outcomes.length) * 100).toFixed(0)}%` : "--";
  target.innerHTML = `<b>${outcomes.length}</b> decisiones evaluadas · <b>${rate}</b> coincidencia direccional · ${pending.length} esperando horizonte. Las señales no sustituyen las reglas duras ni autorizan envíos.`;
}
window.deskChartState = window.deskChartState || { symbol: "POL", range: "live" };
function deskTime(timestamp, range) {
  const date = new Date(timestamp);
  if (range === "live") return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (range === "1h" || range === "1d") return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
function deskPrecision(value) {
  return value < 1 ? 5 : value < 10 ? 3 : 2;
}
function drawDeskChart(points, range) {
  const canvas = el("desk-chart"),
    ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;
  const width = canvas.clientWidth || 340,
    height = 210,
    dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const note = el("desk-chart-note"),
    state = el("desk-chart-state");
  if (points.length < 2) {
    state.textContent = "ACUMULANDO";
    state.className = "pill warn";
    note.textContent = "Aún no hay suficientes muestras en este periodo. La vista LIVE se llena cada 15 segundos.";
    return;
  }
  const values = points.map((point) => Number(point.price)),
    min = Math.min(...values),
    max = Math.max(...values),
    span = max - min || Math.max(max * 0.001, 0.00001),
    left = 58,
    right = 10,
    top = 12,
    bottom = 28,
    plotWidth = width - left - right,
    plotHeight = height - top - bottom,
    precision = deskPrecision(max);
  ctx.font = "10px ui-monospace, monospace";
  ctx.lineWidth = 1;
  for (let step = 0; step <= 4; step++) {
    const ratio = step / 4,
      y = top + plotHeight * (1 - ratio),
      value = min + span * ratio;
    ctx.strokeStyle = cssVar("--line");
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(width - right, y);
    ctx.stroke();
    ctx.fillStyle = cssVar("--muted");
    ctx.textAlign = "left";
    ctx.fillText("$" + value.toFixed(precision), 4, y + 3);
  }
  const labelIndexes = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  ctx.fillStyle = cssVar("--muted");
  ctx.textAlign = "center";
  labelIndexes.forEach((index) => {
    const x = left + (index / (points.length - 1)) * plotWidth;
    ctx.fillText(deskTime(points[index].timestamp, range), x, height - 8);
  });
  ctx.strokeStyle = cssVar("--mint");
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = left + (index / (points.length - 1)) * plotWidth,
      y = top + plotHeight - ((Number(point.price) - min) / span) * plotHeight;
    index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  const first = values[0],
    last = values[values.length - 1],
    change = ((last - first) / first) * 100;
  state.textContent = change >= 0 ? "LIVE UP" : "LIVE DOWN";
  state.className = "pill " + (change >= 0 ? "positive" : "bad");
  note.textContent = `${points.length} puntos · $${last.toFixed(precision)} USDC · ${change >= 0 ? "+" : ""}${change.toFixed(2)}% · eje Y: USDC · eje X: ${range === "live" ? "minutos" : range === "1h" ? "horas" : "tiempo"}`;
}
async function loadDeskChart(symbol, range) {
  const next = window.deskChartState;
  if (symbol) next.symbol = symbol;
  if (range) next.range = range;
  document.querySelectorAll("[data-desk-asset] button").forEach((button) => button.classList.toggle("active", button.dataset.symbol === next.symbol));
  document.querySelectorAll("[data-desk-range] button").forEach((button) => button.classList.toggle("active", button.dataset.range === next.range));
  const title = el("desk-chart-title");
  if (title) title.textContent = next.symbol + " / USDC";
  const result = await api("/market/history?symbol=" + next.symbol + "&range=" + next.range);
  if (!result) return;
  drawDeskChart(result.points || [], next.range);
  const note = el("desk-chart-note");
  if (note && result.points?.length) note.textContent += " · fuente: " + result.source;
}
function renderAsset(x, m, a, s) {
  const swap =
    x === "POL"
      ? `<div class="panel swap-panel"><div class="panel-title"><span>Cotización DEX POL / USDC</span><span class="pill warn">NO FIRMADA</span></div><div class="form-row"><select id="swap-direction"><option value="POL-USDC">POL → USDC</option><option value="USDC-POL">USDC → POL</option></select><input id="swap-amount" type="number" min="0" step="any" value="1" placeholder="Monto"><input id="swap-slippage" type="number" min="1" max="500" value="50" placeholder="Slippage bps"><button class="primary" onclick="quotePolUsdc()">Cotizar</button></div><div id="swap-quote" class="muted">La cotización consulta QuickSwap Polygon. No firma ni transmite.</div></div>`
      : "";
  const chart = `<div class="panel price-chart"><div class="panel-title"><span>Evolución ${x} / USDC</span><span id="${x.toLowerCase()}-chart-state" class="pill warn">ACUMULANDO</span></div><div class="chart-tabs" data-chart="${x.toLowerCase()}"><button class="active" data-range="1h" onclick="loadAssetChart('${x}','1h')">1H</button><button data-range="1d" onclick="loadAssetChart('${x}','1d')">1D</button><button data-range="1w" onclick="loadAssetChart('${x}','1w')">1S</button></div><canvas id="${x.toLowerCase()}-chart" height="150"></canvas><p id="${x.toLowerCase()}-chart-note" class="muted">Histórico de precio recopilándose desde el backend.</p><div id="${x.toLowerCase()}-movements" class="price-movements"></div></div>`;
  el(x.toLowerCase() + "-panel").innerHTML =
    `<div class="metric-grid"><div class="metric"><span class="label">PRECIO</span><b>${assetPrice(x, m?.price)}</b><small class="${m?.change24h >= 0 ? "positive" : "negative"}">${m?.change24h >= 0 ? "+" : ""}${m?.change24h}% 24H</small></div><div class="metric"><span class="label">BALANCE</span><b>${assetAmount(x, a?.available)}</b><small>${money(a?.valueUsd)}</small></div><div class="metric"><span class="label">COSTO PROM.</span><b>${assetPrice(x, a?.avgCost)}</b><small>P/L estimado</small></div><div class="metric"><span class="label">SEÑAL</span><b class="positive">${s?.action || "HOLD"}</b><small>${s?.confidence || 0}% confianza</small></div></div>${swap}${chart}<div class="panel" style="margin-top:9px"><div class="panel-title">Lectura de política</div><p class="muted">${s?.reason || "Sin datos confiables: HOLD"}</p><dl><dt>Política</dt><dd>${s?.source || "--"}</dd><dt>Tendencia 1D</dt><dd>${m?.trend1d || "--"}</dd><dt>Tendencia 7D</dt><dd>${m?.trend7d || "--"}</dd><dt>Riesgo</dt><dd>${s?.risk || "OK"}</dd></dl></div>`;
  loadAssetChart(x, window.chartRanges?.[x] || "1h");
}
async function quotePolUsdc() {
  const direction = el("swap-direction").value.split("-"),
    amount = el("swap-amount").value,
    slippage = el("swap-slippage").value;
  if (window.AndroidWallet && direction[0] === "POL") {
    const r = JSON.parse(AndroidWallet.previewSwap("POL", amount, slippage));
    if (r.status !== "READY") {
      el("swap-quote").innerHTML = `<span class="pill bad">BLOQUEADO</span><br>${r.error || "No se pudo cotizar"}`;
      return;
    }
    el("swap-quote").innerHTML =
      `<span class="pill positive">COTIZACIÓN LOCAL</span><br>${amount} POL → <b>${(Number(r.quoted_out_wei) / 1e6).toFixed(6)} USDC</b><br><span class="muted">Mínimo: ${(Number(r.minimum_out_wei) / 1e6).toFixed(6)} USDC · gas: ${r.fee_native_wei} wei</span><button class="danger wide" style="margin-top:9px" onclick="confirmNativeSwap('${amount}','${slippage}')">Firmar y enviar swap REAL</button>`;
    return;
  }
  const r = await api(
    "/dex/quote?asset_in=" + direction[0] + "&asset_out=" + direction[1] + "&amount_in=" + encodeURIComponent(amount) + "&slippage_bps=" + slippage,
  );
  if (!r) return;
  el("swap-quote").innerHTML =
    `<span class="pill positive">COTIZACIÓN</span><br>${amount} ${direction[0]} → <b>${Number(r.amount_out_display).toFixed(direction[1] === "POL" ? 6 : 4)} ${direction[1]}</b><br><span class="muted">Mínimo con slippage: ${Number(r.minimum_out_display).toFixed(direction[1] === "POL" ? 6 : 4)} ${direction[1]} · gas variable · no firmada</span>`;
}
let pendingSwap = null;
function confirmNativeSwap(amount, slippage) {
  pendingSwap = { amount, slippage };
  if (el("swap-confirm-modal")) el("swap-confirm-modal").remove();
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div id="swap-confirm-modal" class="modal-backdrop"><div class="confirm-modal" role="dialog" aria-modal="true"><div class="panel-title">Confirmar swap REAL</div><p>Se firmará localmente un intercambio de <b>${amount} POL</b> por USDC en Polygon.</p><p class="muted">Revisa el mínimo recibido y la comisión antes de continuar. La operación es irreversible.</p><div class="modal-actions"><button onclick="closeSwapConfirm()">CANCELAR</button><button class="danger" onclick="executeNativeSwap()">CONFIRMAR SWAP</button></div></div></div>`,
  );
}
function closeSwapConfirm() {
  pendingSwap = null;
  el("swap-confirm-modal")?.remove();
}
function executeNativeSwap() {
  if (!pendingSwap) return;
  const { amount, slippage } = pendingSwap;
  if (prompt("Escribe SWAP REAL para confirmar esta operación irreversible") !== "SWAP REAL") {
    toast("Swap cancelado");
    return;
  }
  closeSwapConfirm();
  const r = JSON.parse(AndroidWallet.sendSwap("POL", amount, slippage, "SWAP REAL"));
  if (r.status === "SUBMITTED") {
    toast("Swap transmitido · " + r.tx_hash);
    el("swap-quote").innerHTML = `<span class="pill warn">PENDIENTE</span><br><code class="address">${r.tx_hash}</code>`;
  } else {
    toast("Swap bloqueado: " + (r.error || "error"));
    el("swap-quote").innerHTML = `<span class="pill bad">BLOQUEADO</span><br>${r.error || "Error de firma"}`;
  }
}
async function loadAssetChart(symbol, range = "1h") {
  window.chartRanges = window.chartRanges || {};
  window.chartRanges[symbol] = range;
  const key = symbol.toLowerCase();
  document.querySelectorAll(`[data-chart="${key}"] button`).forEach((button) => button.classList.toggle("active", button.dataset.range === range));
  const r = await api("/market/history?symbol=" + symbol + "&range=" + range);
  if (!r) return;
  const canvas = el(key + "-chart"),
    ctx = canvas?.getContext("2d"),
    points = r.points || [];
  if (!canvas || !ctx) return;
  const width = canvas.clientWidth || 320,
    height = 150,
    dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  if (points.length < 2) {
    el(key + "-chart-state").textContent = "ACUMULANDO";
    el(key + "-chart-note").textContent = "Aún no hay suficientes muestras para " + range + ". Se actualizará automáticamente.";
    el(key + "-movements").innerHTML = '<span class="muted">Sin movimientos registrados en este rango.</span>';
    return;
  }
  const values = points.map((point) => Number(point.price)),
    min = Math.min(...values),
    max = Math.max(...values),
    span = max - min || Math.max(max * 0.001, 0.00001),
    pad = 12;
  ctx.strokeStyle = cssVar("--line");
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = pad + ((height - pad * 2) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.strokeStyle = cssVar("--mint");
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((value, index) => {
    const px = values.length === 1 ? width / 2 : index * (width / (values.length - 1)),
      py = height - pad - ((value - min) / span) * (height - pad * 2);
    index ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  });
  ctx.stroke();
  el(key + "-chart-state").textContent = points.length > 2 ? "LIVE" : "ACUMULANDO";
  el(key + "-chart-state").className = "pill " + (points.length > 2 ? "positive" : "warn");
  el(key + "-chart-note").textContent = `${points.length} muestras · fuente: backend · último ${values[values.length - 1].toFixed(5)} USDC`;
  const recent = points.slice(-8).reverse();
  el(key + "-movements").innerHTML = recent
    .map((point, index) => {
      const previous = points[points.length - 1 - (index + 1)],
        delta = previous ? ((point.price - previous.price) / previous.price) * 100 : 0;
      return `<div class="price-movement"><span>${new Date(point.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><b>$${Number(point.price).toFixed(5)}</b><small class="${delta >= 0 ? "positive" : "negative"}">${delta >= 0 ? "+" : ""}${delta.toFixed(3)}%</small></div>`;
    })
    .join("");
}
const ORDER_STATE = { ACTIVA: "warn", EJECUTANDO: "warn", EJECUTADA: "positive", CANCELADA: "", EXPIRADA: "", FALLIDA: "bad", REVISAR: "bad" };
function txLink(hash) {
  return /^0x[0-9a-fA-F]{64}$/.test(hash || "") ? `<a href="https://polygonscan.com/tx/${hash}" target="_blank" rel="noopener">ver transacción</a>` : "";
}
function orderCard(o) {
  const editable = o.editable;
  return `<article class="order"><div><h3>${o.side} ${o.symbol || "POL"} · disparo ${assetPrice("POL", o.triggerPrice)} · ${money(o.amountUsdc)}</h3><p><span class="pill ${ORDER_STATE[o.status] || ""}">${o.status}</span> · ${o.source === "IA" ? "creada por la IA" : "creada por ti"}${o.locked && o.source === "IA" ? " · editada por ti" : ""}</p><p class="muted">${o.note || o.reason || ""}</p><p class="muted">${o.side === "BUY" ? `Compra cuando ${o.symbol || "POL"} baje a este precio` : `Vende cuando ${o.symbol || "POL"} suba a este precio, solo con ganancia neta`}${o.expiresAt ? ` · vence ${new Date(o.expiresAt).toLocaleString()}` : ""}</p>${o.txHash ? `<p>${txLink(o.txHash)}</p>` : ""}</div>${editable ? `<div class="order-actions"><button onclick="editOrder(${o.id},${o.triggerPrice},${o.amountUsdc})">Editar</button><button class="danger" onclick="cancelOrder(${o.id})">Cancelar</button></div>` : ""}</article>`;
}
function tradeCard(t) {
  const ok = t.status === "CONFIRMADA" || t.status === "SIMULADA";
  return `<article class="order"><div><h3>${t.side === "BUY" ? "Compra" : "Venta"} ${t.side === "BUY" ? `${Number(t.amountIn).toFixed(2)} USDC → ${Number(t.amountOut).toPrecision(5)} ${t.symbol || "POL"}` : `${Number(t.amountIn).toPrecision(5)} ${t.symbol || "POL"} → ${Number(t.amountOut).toFixed(2)} USDC`}</h3><p><span class="pill ${ok ? "positive" : t.status === "PENDIENTE" ? "warn" : "bad"}">${t.status}</span> · precio ${assetPrice("POL", t.price)}${t.pnl != null && t.side === "SELL" ? ` · P/L <span class="${t.pnl >= 0 ? "positive" : "negative"}">${money(t.pnl)}</span>` : ""} · ${new Date(t.at).toLocaleString()}</p><p class="muted">${t.error || t.reason || ""}</p>${t.txHash ? `<p>${txLink(t.txHash)}</p>` : ""}</div></article>`;
}
async function loadOrders() {
  const r = await api("/orders");
  cache.orders = r?.orders || [];
  const trades = r?.trades || [];
  const active = cache.orders.filter((o) => o.status === "ACTIVA" || o.status === "EJECUTANDO"),
    past = cache.orders.filter((o) => !active.includes(o));
  const floor = cache.status?.cycle_sell_floor;
  const note = el("order-floor");
  if (note) note.textContent = floor ? `Venta mínima con ganancia ahora: ${assetPrice("POL", floor)}` : "";
  el("orders-list").innerHTML =
    `<div class="panel-title" style="margin-top:12px">Activas (${active.length})</div>${active.map(orderCard).join("") || '<div class="panel muted">Sin órdenes activas. La IA crea órdenes de compra bajo el precio y de venta con ganancia según el mercado.</div>'}<div class="panel-title" style="margin-top:12px">Ejecuciones reales</div>${trades.map(tradeCard).join("") || '<div class="panel muted">Aún no hay compras ni ventas.</div>'}<div class="panel-title" style="margin-top:12px">Historial de órdenes</div>${past.slice(0, 15).map(orderCard).join("") || '<div class="panel muted">Sin historial.</div>'}`;
}
async function createOrder() {
  const side = el("order-side").value,
    triggerPrice = Number(el("order-trigger").value),
    amountUsdc = Number(el("order-amount").value);
  if (!(triggerPrice > 0)) {
    toast("Indica el precio de disparo");
    return;
  }
  const r = await api("/orders", { method: "POST", body: JSON.stringify({ side, triggerPrice, amountUsdc }) });
  if (r?.order) {
    toast(`Orden #${r.order.id} creada · ${side} a ${triggerPrice}`);
    el("order-trigger").value = "";
    loadOrders();
  }
}
async function editOrder(id, trigger, amount) {
  const t = prompt("Nuevo precio de disparo (en USDC)", String(trigger));
  if (t === null) return;
  const a = prompt("Nuevo monto en USDC (máx. 2)", amount);
  if (a === null) return;
  const r = await api("/orders/" + id + "/edit", { method: "POST", body: JSON.stringify({ triggerPrice: Number(t), amountUsdc: Number(a) }) });
  if (r?.order) {
    toast(`Orden #${id} actualizada · la IA ya no la modifica`);
    loadOrders();
  }
}
async function cancelOrder(id) {
  if (!confirm(`¿Cancelar la orden #${id}?`)) return;
  const r = await api("/orders/" + id + "/cancel", { method: "POST" });
  if (r?.order) {
    toast(`Orden #${id} cancelada`);
    loadOrders();
  }
}
function newOrder() {
  document.querySelector('[data-target="orders"]').click();
  el("order-trigger").focus();
}
async function loadPolicies() {
  const r = await api("/policies");
  cache.policies = r?.policies || [];
  el("policies-list").innerHTML = cache.policies
    .map(
      (p) =>
        `<article class="policy ${p.active ? "active" : ""}"><h3>${p.label} ${p.active ? '<span class="pill">ACTIVO</span>' : ""}</h3><div class="meta">${p.id} · riesgo ${p.risk} · ${p.kind} · ${p.assets}</div><p>${p.requiresApproval ? "Requiere aprobación manual antes de operar." : "Apto para propuesta controlada en mock."}</p><button ${p.active ? "disabled" : ""} onclick="activatePolicy('${p.id}')">${p.active ? "ACTIVO" : "ACTIVAR"}</button></article>`,
    )
    .join("");
}
async function activatePolicy(policy) {
  const r = await api("/policies/activate", { method: "POST", body: JSON.stringify({ policy }) });
  if (r) {
    toast("Perfil activado · " + policy);
    loadPolicies();
    loadLogs();
    refresh();
  }
}
async function loadLogs() {
  const r = await api("/logs");
  cache.logs = r?.logs || [];
  el("logs-list").innerHTML = cache.logs.length
    ? cache.logs
        .map(
          (x) =>
            `<article class="log"><div class="log-head"><span>${x.timestamp}</span><span>${x.symbol} · ${x.action}</span></div><p>${x.reason}</p></article>`,
        )
        .join("")
    : '<div class="panel muted">Aún no hay eventos.</div>';
}
async function loadConfig() {
  const r = await api("/config");
  const c = r?.config;
  updateCloudState();
  if (!c) return;
  el("cfg-mode").value = c.mode;
  el("cfg-confidence").value = c.minConfidence;
  el("cfg-reserve").value = c.minReserveUsdc;
  el("cfg-min-profit").value = c.minNetProfitUsdc;
  el("cfg-max-trade").value = c.maxTradeUsdc;
  el("cfg-max-day").value = c.maxTradesPerDay;
  applyLimitsUi(c);
}
function applyLimitsUi(c) {
  const ids = {
    "cfg-confidence": "minConfidence",
    "cfg-reserve": "minReserveUsdc",
    "cfg-min-profit": "minProfitPct",
    "cfg-max-trade": "maxTradeUsdc",
    "cfg-max-day": "maxTradesPerDay",
  };
  for (const id in ids) {
    const i = el(id),
      r = c.ranges && c.ranges[ids[id]];
    i.disabled = !c.editable;
    if (r) {
      i.min = r[0];
      i.max = r[1];
    }
  }
  const amount = el("order-amount");
  if (amount && c.maxTradeUsdc) {
    amount.max = c.maxTradeUsdc;
    if (Number(amount.value) > c.maxTradeUsdc) amount.value = c.maxTradeUsdc;
  }
  const pill = el("cfg-limits-state"),
    save = el("cfg-save");
  if (pill) pill.textContent = c.editable ? "EDITABLE" : "SOLO LECTURA";
  if (save) save.hidden = !c.editable;
  if (c.editable && el("config-note"))
    el("config-note").textContent = "Los cambios se aplican en tu nube desde el siguiente ciclo. Stop-loss −3 %, enfriamiento 15 min, coste DEX máx. 1 %.";
}
async function saveLimits() {
  if (!cloudToken()) {
    toast("Inicia sesión para cambiar los límites");
    return;
  }
  const body = {
    minConfidence: Number(el("cfg-confidence").value),
    minReserveUsdc: Number(el("cfg-reserve").value),
    minProfitPct: Number(el("cfg-min-profit").value),
    maxTradeUsdc: Number(el("cfg-max-trade").value),
    maxTradesPerDay: Number(el("cfg-max-day").value),
  };
  if (body.maxTradeUsdc > 20 && !confirm("Vas a permitir órdenes de hasta " + body.maxTradeUsdc + " USDC cada una. ¿Confirmas?")) return;
  const r = await api("/config", { method: "POST", body: JSON.stringify(body) });
  if (r?.config) {
    applyLimitsUi(r.config);
    toast("Límites guardados");
  }
}
function updateCloudState(ok) {
  const pill = el("cloud-state");
  if (!pill) return;
  const has = !!cloudToken();
  pill.textContent = ok === true ? "CONECTADO" : ok === false ? "SIN SESIÓN VÁLIDA" : has ? "SESIÓN GUARDADA" : "SIN SESIÓN";
  pill.className = "pill " + (ok === true ? "positive" : ok === false ? "bad" : has ? "" : "warn");
  const input = el("cloud-token");
  if (input && !input.value && has) input.placeholder = "•••••••• guardado";
}
async function saveCloudToken() {
  const value = el("cloud-token")
    .value.replace(/[\s\u200B-\u200D\uFEFF]+/g, "")
    .replace(/^["'`]+|["'`]+$/g, "");
  if (!/^[A-Za-z0-9_-]{16,}$/.test(value)) {
    toast(`Token con formato inválido (${value.length} caracteres; debe tener solo letras y números)`);
    return;
  }
  /* Se comprueba ANTES de guardarlo: un token equivocado ya no reemplaza al bueno. */
  let r,
    data = {};
  try {
    r = await fetch(API + "/config", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + value }, body: "{}" });
    data = await r.json().catch(() => ({}));
  } catch (e) {
    toast("Sin conexión con Cardón DeFi: revisa internet e inténtalo de nuevo");
    return;
  }
  if (r.status === 401) {
    toast(`El servidor rechazó ese token (${value.length} caracteres). Cópialo completo, sin espacios.`);
    updateCloudState(!!cloudToken());
    return;
  }
  if (!r.ok && r.status !== 400) {
    toast("Cardón DeFi respondió " + r.status + ": " + (data.error || ""));
    return;
  }
  try {
    localStorage.setItem("dexpilot-token", value);
  } catch (e) {
    toast("No se pudo guardar el token");
    return;
  }
  el("cloud-token").value = "";
  updateCloudState(true);
  toast("Conectado a Cardón DeFi · controles habilitados");
}
function toggleToken() {
  const i = el("cloud-token");
  i.type = i.type === "password" ? "text" : "password";
}
function activateTrading() {
  if (el("auto-confirm-modal")) el("auto-confirm-modal").remove();
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div id="auto-confirm-modal" class="modal-backdrop"><div class="confirm-modal" role="dialog" aria-modal="true"><div class="panel-title">Piloto automático indefinido</div><p><strong>Sesión automática permanente</strong></p><p>Una vez autorizado, la IA supervisará y ejecutará swaps automáticamente de forma indefinida.</p><p class="muted">✓ Sin expiración de sesión<br>✓ Autorización biométrica una sola vez<br>✓ Los swaps se ejecutan sin confirmación cada vez</p><p class="muted">Límites de seguridad (siempre activos):<br>• Máximo $2.00 USDC por swap<br>• Máximo 8 swaps por día<br>• EMERGENCY STOP disponible en cualquier momento</p><p class="muted">Al continuar Android solicitará biometría o PIN del dispositivo.</p><div class="modal-actions"><button onclick="closeAutoConfirm()">CANCELAR</button><button class="primary" onclick="confirmAutoTrading()">AUTORIZAR · ACTIVAR AUTOMÁTICO</button></div></div></div>`,
  );
}
function closeAutoConfirm() {
  el("auto-confirm-modal")?.remove();
}
let biometricAuthorizationResolve = null;
window.onBiometricAuthorization = function (raw) {
  try {
    biometricAuthorizationResolve?.(JSON.parse(raw));
  } catch (error) {
    biometricAuthorizationResolve?.({ error: error.message });
  }
  biometricAuthorizationResolve = null;
};
async function confirmAutoTrading() {
  closeAutoConfirm();
  if (!window.AndroidWallet) {
    toast("La autorización requiere la APK Android");
    return;
  }
  let local;
  try {
    local = JSON.parse(AndroidWallet.status());
  } catch (error) {
    toast("No se pudo leer la wallet local");
    return;
  }
  if (!local.configured || !/^0x[0-9a-fA-F]{40}$/.test(local.address || "")) {
    toast("Crea o importa la wallet local antes de activar");
    return;
  }
  const saved = await api("/config", { method: "POST", body: JSON.stringify({ mode: "auto", minReserveUsdc: 0.5 }) });
  if (!saved) return;
  toast("Sincronizando balances Polygon...");
  const synced = await api("/wallet/sync", { method: "POST", body: JSON.stringify({ address: local.address }) });
  if (!synced?.assets) {
    toast("No se pudieron sincronizar balances; revisa Polygon RPC");
    return;
  }
  cache.assets = synced.assets;
  render();
  const challenge = await api("/execution/challenge");
  if (!challenge) return;
  const pending = new Promise((resolve) => {
    biometricAuthorizationResolve = resolve;
    setTimeout(() => {
      if (biometricAuthorizationResolve) {
        biometricAuthorizationResolve = null;
        resolve({ error: "BIOMETRIC_TIMEOUT" });
      }
    }, 90000);
  });
  const started = JSON.parse(AndroidWallet.authorizeTrading(challenge.message));
  if (started.status !== "BIOMETRIC_PENDING") {
    toast("Autorización del dispositivo no iniciada: " + (started.error || "error"));
    return;
  }
  const signed = await pending;
  if (signed.error) {
    toast("Autorización cancelada: " + signed.error);
    return;
  }
  const verified = await api("/execution/authorize", { method: "POST", body: JSON.stringify(signed) });
  if (!verified) return;
  const activated = await api("/control/activate", { method: "POST", body: JSON.stringify({ address: local.address }) });
  if (activated) toast("Automático supervisado activo; propuestas y firma local obligatoria");
  await startAutoTradingSession();
  refresh();
}
async function startAutoTradingSession() {
  const res = await api("/execution/auto-session/create", { method: "POST" });
  if (res?.session) {
    autoTradingSession.active = true;
    autoTradingSession.sessionId = res.session.id;
    autoTradingSession.expiresAt = null;
    autoTradingSession.swapsUsedToday = 0;
    autoTradingSession.maxSwapsPerDay = res.session.maxSwapsPerDay || 8;
    toast("✓ Sesión automática indefinida · IA supervisando piloto automático");
    updateAutoSessionDisplay();
  }
}
function updateAutoSessionDisplay() {
  if (!autoTradingSession.active) return;
  const status = el("auto-session-status");
  if (status) status.textContent = `✓ Automático activo indefinido · ${autoTradingSession.swapsUsedToday}/${autoTradingSession.maxSwapsPerDay} swaps hoy`;
}
async function closeAutoTradingSession() {
  if (autoTradingSession.active) {
    await api("/execution/auto-session/close", { method: "POST" });
    autoTradingSession.active = false;
    toast("Sesión automática cerrada");
  }
}
async function pauseTrading() {
  closeAutoTradingSession();
  const r = await api("/control/pause", { method: "POST" });
  if (r) {
    toast("Trading pausado");
    refresh();
  }
}
async function emergencyStop() {
  if (!confirm("Activar EMERGENCY STOP? Bloqueará nuevas órdenes.")) return;
  const r = await api("/emergency-stop", { method: "POST" });
  if (r) {
    toast("EMERGENCY STOP activo · " + r.receipt.id);
    refresh();
  }
}
async function control(action) {
  const r = await api("/control/" + action, { method: "POST" });
  if (r) {
    toast("Runner " + r.runner);
    refresh();
  }
}
function ensureTradingControls() {
  const zone = document.querySelector(".danger-zone");
  if (zone && !el("trading-controls"))
    zone.insertAdjacentHTML(
      "afterbegin",
      '<div id="trading-controls" class="control-row"><button class="primary" onclick="activateTrading()">ACTIVAR PILOTO</button><button onclick="pauseTrading()">PAUSAR TRADING</button></div>',
    );
  const motor = document.querySelector("#chain-status");
  if (motor && !el("dashboard-trading-controls"))
    motor.insertAdjacentHTML(
      "afterend",
      '<div id="dashboard-trading-controls" class="control-row"><button class="primary" onclick="activateTrading()">ACTIVAR PILOTO</button><button onclick="pauseTrading()">PAUSAR</button></div>',
    );
}
document.querySelectorAll(".nav button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".nav button,.screen").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    el(b.dataset.target).classList.add("active");
  }),
);
refresh();
function applyReadonlyBalances(read) {
  if (!cache.status || !cache.assets) return;
  const polygon = read?.chains?.polygon || {},
    hub = read?.chains?.polkadotHub || {};
  const token = (chain, symbol) => Number((chain.assets || []).find((x) => x.symbol === symbol)?.balance || 0);
  const pol = Number(polygon.native_balance || 0),
    dot = Number(hub.native_balance || 0),
    usdc = token(polygon, "USDC") + token(hub, "USDC");
  cache.assets = {
    ...cache.assets,
    USDC: { symbol: "USDC", available: usdc, total: usdc, avgCost: 0, valueUsd: usdc },
    POL: { symbol: "POL", available: pol, total: pol, avgCost: 0, valueUsd: pol * Number(cache.status.market?.POL?.price || 0) },
    DOT: { symbol: "DOT", available: dot, total: dot, avgCost: 0, valueUsd: dot * Number(cache.status.market?.DOT?.price || 0) },
  };
  cache.status = { ...cache.status, portfolio_value_usd: Number((usdc + cache.assets.POL.valueUsd + cache.assets.DOT.valueUsd).toFixed(2)) };
  render();
}
async function loadWallet() {
  const r = await api("/wallet/status");
  const w = r?.wallet;
  el("wallet-status").textContent = w ? "SIN CONFIGURAR" : "BACKEND OFFLINE";
  el("wallet-status").className = w ? "pill warn" : "pill bad";
  el("wallet-address").textContent = w?.address || "Wallet local pendiente";
  el("wallet-assets").innerHTML = w
    ? Object.entries(w.assets)
        .map(
          ([symbol, item]) =>
            `<article class="asset-card"><span class="ticker">${item.label || symbol}</span><strong>${assetAmount(symbol, item.balance)}</strong><small>${item.network} · ${item.decimals} dec</small></article>`,
        )
        .join("")
    : '<p class="negative">Sin conexión con Cardón DeFi (Cloudflare): no hay balances on-chain. La wallet local sigue disponible abajo.</p>';
  if (!el("native-wallet-panel")) {
    el("wallet-assets").insertAdjacentHTML(
      "afterend",
      '<div id="native-wallet-panel" class="panel wallet-form"><div class="panel-title">Wallet local real <span class="pill warn">ANDROID KEYSTORE</span></div><p class="muted">La clave se cifra en el dispositivo y no se envía al backend.</p><div class="grid two"><button class="primary" onclick="createNativeWallet()">Crear wallet</button><button onclick="importNativeWallet()">Importar wallet</button></div><div id="wallet-native-result" class="muted" style="margin-top:10px">Disponible dentro del APK Android.</div></div>',
    );
  }
  if (window.AndroidWallet) {
    try {
      const local = JSON.parse(AndroidWallet.status());
      if (local.configured) {
        el("wallet-status").textContent = "REAL LOCAL";
        el("wallet-status").className = "pill positive";
        el("wallet-address").textContent = local.address;
        el("wallet-read-address").value = local.address;
        el("wallet-native-result").textContent = w
          ? "Wallet local cifrada · lectura on-chain disponible"
          : "Wallet local cifrada · backend offline, sin lectura on-chain";
        if (w) setTimeout(loadReadonlyWallet, 50);
      }
    } catch (e) {
      toast("Wallet local no disponible");
    }
  }
}
function walletProgress(message) {
  const panel = el("wallet-native-result");
  if (panel) panel.innerHTML = `<span class="pill warn">PROCESANDO</span><br>${message}`;
}
function walletBusy(busy) {
  document.querySelectorAll("#native-wallet-panel button").forEach((button) => {
    button.disabled = busy;
    button.style.opacity = busy ? ".55" : "";
  });
}
function expectedNetwork(asset) {
  return ["POL", "USDC_POLYGON", "USDT"].includes(asset) ? "polygon" : "polkadotHub";
}
function ensureNetworkSelector() {
  const asset = el("wallet-asset");
  if (!asset || el("wallet-network")) return;
  const form = asset.closest(".wallet-form");
  if (!form) return;
  asset.insertAdjacentHTML(
    "beforebegin",
    '<label>Red<select id="wallet-network"><option value="polygon">Polygon PoS · POL / USDC / USDT</option><option value="polkadotHub">Polkadot Hub · DOT / USDC / USDt</option></select></label>',
  );
  el("wallet-network").addEventListener("change", () => {
    const selected = el("wallet-network").value;
    const current = el("wallet-asset").value;
    const expected = expectedNetwork(current);
    if (selected !== expected) toast("Red incompatible con " + current + "; selecciona " + expected);
  });
  asset.addEventListener("change", () => {
    el("wallet-network").value = expectedNetwork(asset.value);
  });
}
function selectedNetworkFor(asset) {
  const selected = el("wallet-network")?.value;
  const expected = expectedNetwork(asset);
  if (selected && selected !== expected) {
    toast("Red incompatible: " + asset + " requiere " + expected);
    return null;
  }
  return expected;
}
function nativeResult(raw) {
  try {
    const result = JSON.parse(raw);
    if (result.error) {
      const message = "Wallet no creada: " + result.error;
      el("wallet-native-result").innerHTML =
        `<span class="pill bad">ERROR</span><br><span class="negative">${message}</span><p class="muted">Revisa el estado del dispositivo y vuelve a intentarlo.</p>`;
      toast(message);
      return null;
    }
    if (result.backup_phrase_once) {
      el("wallet-native-result").innerHTML =
        `<strong class="negative">ANOTA ESTA FRASE AHORA. NO SE VOLVERÁ A MOSTRAR.</strong><br><code class="address">${result.backup_phrase_once}</code><p class="muted">Guárdala offline. No la envíes por chat ni la compartas.</p>`;
    } else {
      el("wallet-native-result").innerHTML = `<span class="pill positive">CREADA</span><br>Wallet local cifrada · dirección <code>${result.address}</code>`;
    }
    el("wallet-status").textContent = "REAL LOCAL";
    el("wallet-status").className = "pill positive";
    el("wallet-address").textContent = result.address;
    el("wallet-read-address").value = result.address;
    toast("Wallet creada/importada localmente");
    return result;
  } catch (error) {
    el("wallet-native-result").innerHTML = `<span class="pill bad">ERROR FRONTEND</span><br><span class="negative">${error.message}</span>`;
    toast("Error interpretando respuesta de wallet");
    return null;
  }
}
function createNativeWallet() {
  if (!window.AndroidWallet) {
    el("wallet-native-result").innerHTML = '<span class="pill bad">SIN PUENTE</span><br>Abre la aplicación Android, no el navegador.';
    toast("Esta función requiere el APK Android");
    return;
  }
  walletBusy(true);
  walletProgress("Creando cuenta y cifrando secreto en Android Keystore...");
  setTimeout(() => {
    try {
      nativeResult(AndroidWallet.create());
    } catch (error) {
      el("wallet-native-result").innerHTML = `<span class="pill bad">ERROR NATIVO</span><br><span class="negative">${error.message}</span>`;
      toast("Error nativo al crear wallet");
    } finally {
      walletBusy(false);
    }
  }, 80);
}
function importNativeWallet() {
  if (!window.AndroidWallet) {
    el("wallet-native-result").innerHTML = '<span class="pill bad">SIN PUENTE</span><br>Abre la aplicación Android, no el navegador.';
    toast("Esta función requiere el APK Android");
    return;
  }
  if (el("restore-wallet-modal")) el("restore-wallet-modal").remove();
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div id="restore-wallet-modal" class="modal-backdrop"><div class="confirm-modal" role="dialog" aria-modal="true"><div class="panel-title">Restaurar wallet con seed</div><p class="muted">Introduce la frase original de 12 o 24 palabras. Se procesa solo en el APK y se cifra con Android Keystore; no se envía al backend.</p><textarea id="restore-seed" class="restore-seed" rows="4" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="palabra1 palabra2 ..."></textarea><p class="muted">Si existe otra wallet local, escribe <b>RESTORE LOCAL</b> para reemplazarla. Esto no mueve activos on-chain.</p><input id="restore-confirmation" autocomplete="off" autocapitalize="characters" placeholder="RESTORE LOCAL si reemplazarás una wallet"><div class="modal-actions"><button onclick="closeRestoreWallet()">CANCELAR</button><button class="primary" onclick="submitRestoreWallet()">RESTAURAR</button></div></div></div>`,
  );
}
function closeRestoreWallet() {
  el("restore-wallet-modal")?.remove();
}
function submitRestoreWallet() {
  const seed = el("restore-seed")?.value.trim() || "",
    confirmation = el("restore-confirmation")?.value.trim() || "";
  if (!seed) {
    toast("Introduce la frase de recuperación");
    return;
  }
  let local = { configured: false };
  try {
    local = JSON.parse(AndroidWallet.status());
  } catch (error) {}
  if (local.configured && confirmation !== "RESTORE LOCAL") {
    toast("Escribe RESTORE LOCAL para reemplazar la wallet local");
    return;
  }
  el("restore-seed").value = "";
  el("restore-confirmation").value = "";
  closeRestoreWallet();
  walletBusy(true);
  walletProgress("Verificando seed y cifrando la wallet restaurada en Android Keystore...");
  setTimeout(() => {
    try {
      const raw = local.configured ? AndroidWallet.replaceSecret(seed, "RESTORE LOCAL") : AndroidWallet.importSecret(seed);
      const restored = nativeResult(raw);
      if (restored) {
        loadReadonlyWallet();
        toast("Wallet restaurada; sincronizando balances on-chain");
      }
    } catch (error) {
      el("wallet-native-result").innerHTML = `<span class="pill bad">ERROR NATIVO</span><br><span class="negative">${error.message}</span>`;
      toast("No se pudo restaurar la wallet");
    } finally {
      walletBusy(false);
    }
  }, 80);
}
async function loadReadonlyWallet() {
  const address = el("wallet-read-address").value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    toast("Introduce una dirección EVM válida");
    return;
  }
  const r = await api("/wallet/readonly?address=" + encodeURIComponent(address));
  if (!r) return;
  el("wallet-read-result").innerHTML =
    Object.entries(r.chains || {})
      .map(
        ([chain, item]) =>
          `<div class="panel-title" style="margin-top:8px">${item.name || chain} <span class="pill ${item.status === "ONLINE" ? "" : "warn"}">${item.status}</span></div><div class="muted">${item.native || "native"}: <b>${item.native_balance || "--"}</b></div>${(item.assets || []).map((a) => `<div class="muted">${a.symbol}: <b>${a.balance ?? "--"}</b> · ${a.status}</div>`).join("")}`,
      )
      .join("") || "Sin datos";
  const cards = [];
  for (const [chain, item] of Object.entries(r.chains || {})) {
    if (item.native)
      cards.push(
        `<article class="asset-card"><span class="ticker">${item.native}</span><strong>${assetAmount(item.native, item.native_balance)}</strong><small>${item.name || chain} · nativo</small></article>`,
      );
    for (const a of item.assets || [])
      cards.push(
        `<article class="asset-card"><span class="ticker">${a.symbol}</span><strong>${assetAmount(a.symbol, a.balance)}</strong><small>${item.name || chain} · ${a.status}</small></article>`,
      );
  }
  el("wallet-assets").innerHTML = cards.join("");
  applyReadonlyBalances(r);
  const synced = await api("/wallet/sync", { method: "POST", body: JSON.stringify({ address }) });
  if (synced?.assets) {
    cache.assets = synced.assets;
    render();
  }
  toast(synced ? "Balances reales sincronizados para el piloto" : "Lectura on-chain actualizada");
}
async function previewTransfer() {
  const asset = el("wallet-asset").value,
    amount = Number(el("wallet-amount").value),
    to = el("wallet-to").value.trim();
  if (window.AndroidWallet) {
    const r = JSON.parse(AndroidWallet.previewTransfer(asset, String(amount), to));
    if (r.status !== "READY") {
      toast("Transferencia bloqueada: " + (r.error || "error"));
      return;
    }
    el("wallet-preview").innerHTML =
      `<article class="panel wallet-preview"><div class="panel-title">Previsualización real <span class="pill warn">NO FIRMADA</span></div><dl><dt>Activo</dt><dd>${r.asset}</dd><dt>Red</dt><dd>Chain ${r.chain_id}</dd><dt>Monto</dt><dd>${r.amount}</dd><dt>Destino</dt><dd>${r.recipient}</dd><dt>Gas máximo</dt><dd>${r.gas_limit}</dd><dt>Fee nativa</dt><dd>${r.fee_native_wei}</dd></dl><p class="muted">La firma ocurrirá localmente. Verifica destino, activo y monto.</p><button class="danger wide" onclick="confirmNativeTransfer('${asset}','${amount}','${to}')">Firmar y enviar REAL</button></article>`;
    return;
  }
  const r = await api("/wallet/transfer/preview", { method: "POST", body: JSON.stringify({ asset, amount, to }) });
  if (!r) return;
  const p = r.preview;
  el("wallet-preview").innerHTML =
    `<article class="panel wallet-preview"><div class="panel-title">Previsualización mock <span class="pill warn">NO FIRMADA</span></div><dl><dt>Activo</dt><dd>${p.asset}</dd><dt>Red</dt><dd>${p.network}</dd><dt>Monto</dt><dd>${p.amount}</dd><dt>Destino</dt><dd>${p.to}</dd><dt>Comisión</dt><dd>${p.fee}</dd></dl><p class="muted">Verifica cada dato. Para confirmar en mock escribe SEND.</p><button class="danger wide" onclick="confirmTransfer('${p.asset}',${p.amount},'${p.to.replace(/'/g, "\\'")}')">Confirmar envío mock</button></article>`;
}
async function confirmNativeTransfer(asset, amount, to) {
  if (prompt("Escribe SEND REAL para firmar y transmitir esta operación") !== "SEND REAL") {
    toast("Envío real cancelado");
    return;
  }
  const r = JSON.parse(AndroidWallet.sendTransfer(asset, amount, to, "SEND REAL"));
  if (r.status === "SUBMITTED") {
    toast("Transacción transmitida · " + r.tx_hash);
    el("wallet-preview").innerHTML =
      `<article class="panel wallet-preview"><div class="panel-title">Seguimiento on-chain <span class="pill warn">PENDING</span></div><code class="address">${r.tx_hash}</code><p id="tx-state" class="muted">Esperando confirmación...</p></article>`;
    watchNativeTransfer(asset, r.tx_hash);
    loadReadonlyWallet();
    loadLogs();
  } else toast("Envío real bloqueado: " + (r.error || "error"));
}
function watchNativeTransfer(asset, hash) {
  let attempts = 0;
  const timer = setInterval(() => {
    const r = JSON.parse(AndroidWallet.transactionStatus(asset, hash));
    const state = el("tx-state");
    if (!state) {
      clearInterval(timer);
      return;
    }
    state.textContent = r.status + (r.block_number ? " · bloque " + r.block_number : "");
    if (["CONFIRMED", "FAILED"].includes(r.status) || ++attempts >= 30) {
      clearInterval(timer);
      toast("Estado TX: " + r.status);
    }
  }, 5000);
}
async function confirmTransfer(asset, amount, to) {
  const confirmation = prompt("Escribe SEND para confirmar esta transferencia irreversible");
  if (confirmation !== "SEND") {
    toast("Envío cancelado");
    return;
  }
  const r = await api("/wallet/transfer", { method: "POST", body: JSON.stringify({ asset, amount, to, confirmation }) });
  if (r) {
    toast("Transferencia mock enviada · " + r.transaction.id);
    el("wallet-preview").innerHTML = "";
    loadWallet();
    loadLogs();
  }
}
async function copyText(value, label) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(value);
    ok = true;
  } catch {
    try {
      const t = document.createElement("textarea");
      t.value = value;
      t.style.position = "fixed";
      t.style.opacity = "0";
      document.body.appendChild(t);
      t.select();
      ok = document.execCommand("copy");
      t.remove();
    } catch {}
  }
  toast(ok ? `${label || "Dirección"} copiada` : value);
}
async function copyWalletAddress() {
  return copyText(el("wallet-address").textContent);
}
/* Dirección Polkadot (SS58) de una cuenta 0x en Polkadot Hub: AccountId32 = h160 + 0xEE×12 (regla de pallet-revive). */
function blake2b512(input) {
  const M = (1n << 64n) - 1n,
    IV = [
      0x6a09e667f3bcc908n,
      0xbb67ae8584caa73bn,
      0x3c6ef372fe94f82bn,
      0xa54ff53a5f1d36f1n,
      0x510e527fade682d1n,
      0x9b05688c2b3e6c1fn,
      0x1f83d9abfb41bd6bn,
      0x5be0cd19137e2179n,
    ],
    S = [
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
      [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
      [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
      [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
      [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
      [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
      [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
      [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
      [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
    ],
    rot = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M;
  const h = IV.slice();
  h[0] ^= 0x01010040n;
  const blocks = Math.max(1, Math.ceil(input.length / 128));
  for (let b = 0; b < blocks; b++) {
    const block = new Uint8Array(128);
    block.set(input.slice(b * 128, b * 128 + 128));
    const m = [];
    for (let i = 0; i < 16; i++) {
      let x = 0n;
      for (let j = 7; j >= 0; j--) x = (x << 8n) | BigInt(block[i * 8 + j]);
      m.push(x);
    }
    const last = b === blocks - 1,
      v = h.concat(IV);
    v[12] ^= BigInt(last ? input.length : (b + 1) * 128);
    if (last) v[14] ^= M;
    const G = (a, b2, c, d, x, y) => {
      v[a] = (v[a] + v[b2] + x) & M;
      v[d] = rot(v[d] ^ v[a], 32);
      v[c] = (v[c] + v[d]) & M;
      v[b2] = rot(v[b2] ^ v[c], 24);
      v[a] = (v[a] + v[b2] + y) & M;
      v[d] = rot(v[d] ^ v[a], 16);
      v[c] = (v[c] + v[d]) & M;
      v[b2] = rot(v[b2] ^ v[c], 63);
    };
    for (let r = 0; r < 12; r++) {
      const s = S[r % 10];
      G(0, 4, 8, 12, m[s[0]], m[s[1]]);
      G(1, 5, 9, 13, m[s[2]], m[s[3]]);
      G(2, 6, 10, 14, m[s[4]], m[s[5]]);
      G(3, 7, 11, 15, m[s[6]], m[s[7]]);
      G(0, 5, 10, 15, m[s[8]], m[s[9]]);
      G(1, 6, 11, 12, m[s[10]], m[s[11]]);
      G(2, 7, 8, 13, m[s[12]], m[s[13]]);
      G(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  }
  const out = new Uint8Array(64);
  h.forEach((x, i) => {
    for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((x >> BigInt(8 * j)) & 0xffn);
  });
  return out;
}
function polkadotAddress(evm) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(evm || "")) return null;
  const payload = new Uint8Array(33);
  for (let i = 0; i < 20; i++) payload[1 + i] = parseInt(evm.slice(2 + i * 2, 4 + i * 2), 16);
  payload.fill(0xee, 21);
  const pre = new TextEncoder().encode("SS58PRE"),
    data = new Uint8Array(pre.length + 33);
  data.set(pre);
  data.set(payload, pre.length);
  const full = new Uint8Array(35);
  full.set(payload);
  full.set(blake2b512(data).slice(0, 2), 33);
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const b of full) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = A[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of full) {
    if (b) break;
    out = "1" + out;
  }
  return out;
}
function renderReceive() {
  const box = el("receive-list");
  if (!box) return;
  const evm = el("wallet-address").textContent.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(evm)) {
    box.innerHTML = '<p class="muted">Crea o importa la wallet para ver tus direcciones.</p>';
    return;
  }
  const rows = [
    ["Polygon PoS", "POL · USDC · USDT", evm, "Red Polygon. El bot opera aquí."],
    ["Polkadot Hub (0x)", "DOT · USDC · USDt", evm, "Para wallets que aceptan direcciones 0x en Polkadot Hub (Talisman, SubWallet, MetaMask)."],
    [
      "Polkadot Hub (formato Polkadot)",
      "DOT",
      polkadotAddress(evm),
      "Para exchanges y wallets que piden una dirección que empieza por «1». Elige la red Polkadot Asset Hub y manda primero una prueba pequeña.",
    ],
  ];
  box.innerHTML = rows
    .map(
      ([net, assets, addr, note], i) =>
        `<div class="receive"><div class="receive-head"><b>${net}</b><span class="pill">${assets}</span><button class="icon-btn" data-copy="${i}" title="Copiar">⧉ Copiar</button></div><code class="address">${escHtml(addr)}</code><p class="muted">${note}</p></div>`,
    )
    .join("");
  box.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => copyText(rows[b.dataset.copy][2], "Dirección de " + rows[b.dataset.copy][0])));
}
document.addEventListener("DOMContentLoaded", () => {
  const a = el("wallet-address");
  if (a) {
    new MutationObserver(renderReceive).observe(a, { childList: true, characterData: true, subtree: true });
    renderReceive();
  }
});
if (document.readyState !== "loading")
  setTimeout(() => {
    const a = el("wallet-address");
    if (a) {
      new MutationObserver(renderReceive).observe(a, { childList: true, characterData: true, subtree: true });
      renderReceive();
    }
  }, 0);
function refreshNativeEngine() {
  if (!window.AndroidWallet?.engineStatus) return;
  try {
    nativeEngine = JSON.parse(AndroidWallet.engineStatus());
    renderNativeEngine();
  } catch (error) {
    nativeEngine = { running: false, mode: "ERROR", detail: error.message };
  }
}
function renderNativeEngine() {
  const anchor = el("chain-status");
  if (!anchor) return;
  let panel = el("native-engine-status");
  if (!panel) {
    anchor.insertAdjacentHTML("afterend", '<div id="native-engine-status" class="muted" style="margin-top:8px"></div>');
    panel = el("native-engine-status");
  }
  const safe = nativeEngine.mode === "SAFE_HOLD",
    online = nativeEngine.backend_online;
  panel.innerHTML = `Bot en la nube: <span class="${online ? "positive" : "warn"}">${online ? "CLOUDFLARE OK" : nativeEngine.mode === "CLOUD_ALERT" ? "AVISO" : "COMPROBANDO"}</span><br><span>${nativeEngine.detail || "Sin estado"}</span><br><button class="icon-btn" onclick="restartNativeEngine()" title="Volver a comprobar el bot en Cloudflare">↻ COMPROBAR IA</button>`;
}
function restartNativeEngine() {
  if (!window.AndroidWallet?.restartEngine) {
    toast("El supervisor nativo requiere el APK actualizado");
    return;
  }
  try {
    const result = JSON.parse(AndroidWallet.restartEngine());
    toast(result.status === "STARTED" ? "Comprobando el bot en Cloudflare…" : "No se pudo iniciar la comprobación");
    setTimeout(refreshNativeEngine, 1000);
  } catch (error) {
    toast("Error reiniciando supervisor: " + error.message);
  }
}
loadWallet();
setTimeout(() => {
  ensureNetworkSelector();
  ensureTradingControls();
  refreshNativeEngine();
  const n = el("wallet-native-result");
  if (n && !el("wallet-status").textContent.includes("REAL LOCAL"))
    n.textContent = window.AndroidWallet
      ? "Android Keystore detectado · crea o importa una wallet"
      : "Navegador/backend mock · abre esta pantalla desde el APK Android para usar Keystore";
  if (window.AndroidWallet && !el("wallet-status").textContent.includes("REAL")) {
    el("wallet-status").textContent = "REAL PENDIENTE";
    el("wallet-status").className = "pill warn";
  }
  if (window.AndroidWallet) {
    try {
      const local = JSON.parse(AndroidWallet.status());
      if (local.configured) {
        el("wallet-read-address").value = local.address;
        loadReadonlyWallet();
      }
    } catch (error) {
      toast("Lectura local pendiente: " + error.message);
    }
  }
}, 1000);
setInterval(updateCycleProgress, 1000);
setInterval(refresh, 30000);
setInterval(refreshNativeEngine, 15000);
setInterval(() => {
  if (el("desk-chart")) loadDeskChart();
  if (el("pol-chart")) loadAssetChart("POL", window.chartRanges?.POL || "1h");
  if (el("dot-chart")) loadAssetChart("DOT", window.chartRanges?.DOT || "1h");
}, 30000);

function renderPnl(s) {
  const p = el("pnl");
  const sign = (v) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2);
  const since = s.pnl_since ? new Date(s.pnl_since).toLocaleDateString("es-MX", { day: "numeric", month: "short" }) : "";
  if (s.pnl_total_usd === undefined) {
    p.textContent = sign(s.pnl_1d_pct || 0) + "% 1D";
    p.className = (s.pnl_1d_pct || 0) >= 0 ? "positive" : "negative";
    return;
  }
  p.textContent = `Bot ${sign(s.pnl_total_usd).replace(/^([+−])/, "$1$")} (${sign(s.pnl_total_pct)}%)${since ? " desde " + since : ""} · ventas cerradas ${sign(s.pnl_realized_usd).replace(/^([+−])/, "$1$")} · ${MARKET} 24h ${sign(s.pnl_1d_pct || 0)}%`;
  p.className = s.pnl_total_usd >= 0 ? "positive" : "negative";
}

/* ===== ✦ IA: chat con propuestas de órdenes, consenso, panorama global y proveedores =====
   Los textos que vienen de Cardón DeFi (/api/v1) ya llegan escapados por el servidor (clean()).
   Lo que escribe el usuario se escapa aquí con escHtml antes de insertarlo. */
const escHtml = (s) => String(s ?? "").replace(/[&<>"'`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" })[c]);
const unesc = (s) => String(s ?? "").replace(/&(amp|lt|gt|quot|#39|#96);/g, (m, k) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#96": "`" })[k]);
const safeUrl = (u) => (/^https:\/\/[^\s"'<>]+$/.test(unesc(u)) ? u : null);
const pct = (v) => (v == null || !isFinite(v) ? "" : `<small class="${v >= 0 ? "positive" : "negative"}">${v >= 0 ? "+" : ""}${Number(v).toFixed(2)}%</small>`);
const ago = (ts) => {
  if (!ts) return "";
  const m = Math.round((Date.now() - new Date(unesc(ts)).getTime()) / 60000);
  return m < 1 ? "ahora" : m < 60 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h`;
};
const riskClass = (r) => (r === "RISK_ON" ? "" : r === "RISK_OFF" ? "bad" : "warn");
const riskLabel = (r) => ({ RISK_ON: "APETITO DE RIESGO", NEUTRAL: "NEUTRAL", RISK_OFF: "AVERSIÓN AL RIESGO" })[r] || "--";
cache.chat = [];
cache.aiCfg = null;

function loadAiScreen() {
  loadVotes();
  loadMacro();
  loadPolicies();
  loadAiMode();
}
async function loadAiMode() {
  const r = await api("/ai/config");
  if (!r) return;
  cache.aiCfg = r;
  el("ai-mode").textContent = r.consensus.enabled ? `CONSENSO · ${r.consensus.size} IAs` : "UNA IA";
  el("ai-mode").className = "pill" + (r.consensus.enabled ? "" : " warn");
}

const propMarket = (p) => (/^[A-Z0-9]{2,8}$/.test(p.market || "") ? p.market : MARKET);
function proposalCard(p, i) {
  const ok = p.valid && (p.side === "BUY" || p.side === "SELL") && Number(p.triggerPrice) > 0 && Number(p.amountUsdc) > 0;
  return `<div class="proposal ${ok ? "" : "invalid"}"><div><b class="${p.side === "BUY" ? "positive" : "negative"}">${p.side === "BUY" ? "COMPRA" : "VENTA"}</b> ${propMarket(p)} a ${assetPrice("", p.triggerPrice)} · $${Number(p.amountUsdc).toFixed(2)}<p>${p.reason || ""}</p>${ok ? "" : `<p class="negative">No válida: ${p.error || "datos incompletos"}</p>`}</div>${ok ? `<button class="primary" onclick="createProposal('${p.side}',${Number(p.triggerPrice)},${Number(p.amountUsdc)},this,'${propMarket(p)}')">Crear orden</button>` : ""}</div>`;
}
function answerCard(a) {
  if (!a.ok) return `<div class="msg ai err"><span class="who">${a.label}</span><p>Sin respuesta: ${a.error}</p></div>`;
  return `<div class="msg ai"><span class="who">${a.label} · ${(a.ms / 1000).toFixed(1)} s</span><p>${a.reply || ""}</p>${(a.proposals || []).map(proposalCard).join("")}</div>`;
}
function chatAppend(html) {
  const log = el("chat-log");
  if (log.querySelector("p.muted:only-child")) log.innerHTML = "";
  log.insertAdjacentHTML("beforeend", html);
  log.scrollTop = log.scrollHeight;
}
async function askChat(text) {
  const input = el("chat-input");
  const message = (text || input.value).trim();
  if (!message) {
    toast("Escribe una pregunta");
    return;
  }
  if (!cloudToken()) {
    toast("Inicia sesión en Config para usar el chat");
    return;
  }
  input.value = "";
  const consensus = el("chat-consensus").checked;
  chatAppend(`<div class="msg me"><p>${escHtml(message)}</p></div>`);
  const wait = `w${Date.now()}`;
  chatAppend(`<div id="${wait}" class="msg ai thinking"><p>${consensus ? "Consultando a varias IAs…" : "Pensando…"} (puede tardar hasta 40 s)</p></div>`);
  el("chat-send").disabled = true;
  const r = await api("/ai/chat", { method: "POST", body: JSON.stringify({ message, history: cache.chat.slice(-6), consensus }) });
  el("chat-send").disabled = false;
  document.getElementById(wait)?.remove();
  if (!r) {
    chatAppend('<div class="msg ai err"><p>No hubo respuesta del servidor.</p></div>');
    return;
  }
  const answers = r.answers || [];
  chatAppend(answers.map(answerCard).join("") || '<div class="msg ai err"><p>Sin respuestas.</p></div>');
  const best = answers.find((a) => a.ok);
  cache.chat.push({ role: "user", content: message });
  if (best) cache.chat.push({ role: "assistant", content: unesc(best.reply) });
}
function clearChat() {
  cache.chat = [];
  el("chat-log").innerHTML = '<p class="muted">Conversación borrada.</p>';
}
async function createProposal(side, triggerPrice, amountUsdc, btn, mk) {
  mk = /^[A-Z0-9]{2,8}$/.test(mk || "") ? mk : MARKET;
  if (
    !confirm(
      `¿Crear orden ${side === "BUY" ? "de COMPRA" : "de VENTA"} de ${mk} a $${triggerPrice} por $${amountUsdc}? El bot la ejecutará cuando el precio llegue.`,
    )
  )
    return;
  btn.disabled = true;
  const r = await api("/orders?market=" + mk, { method: "POST", body: JSON.stringify({ side, triggerPrice, amountUsdc }) });
  if (r?.order) {
    btn.textContent = "✓ Creada #" + r.order.id;
    toast(`Orden #${r.order.id} creada`);
    loadOrders();
  } else btn.disabled = false;
}
el("chat-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    askChat();
  }
});

async function loadVotes() {
  const r = await api("/ai/votes");
  const box = el("ai-votes");
  if (!r?.decision) {
    box.innerHTML = "Aún no hay decisión de la IA.";
    return;
  }
  const d = r.decision;
  const votes = r.votes || [];
  box.innerHTML = `${r.brake ? `<p class="brake">⏸ ${r.brake.replace(/^freno de compras: /, "Freno de compras: ")}. Las compras de la IA esperan; tus órdenes manuales no se frenan.</p>` : '<p class="brake off">Freno de compras: inactivo (sin aversión al riesgo ni caída en curso)</p>'}<div class="vote-head"><b>${d.action}</b> · confianza ${d.confidence}% · ${ago(r.ts)}${r.reused ? " (plan vigente)" : ""}</div><p class="muted">${d.reason}</p>${d.buyTrigger ? `<p>Compra propuesta: <b>$${Number(d.buyTrigger).toFixed(5)}</b></p>` : ""}${d.sellTrigger ? `<p>Venta propuesta: <b>$${Number(d.sellTrigger).toFixed(5)}</b></p>` : ""}${votes.length ? `<div class="votes">${votes.map((v) => `<div class="vote ${v.ok ? "" : "off"}"><span>${v.label}</span><b class="${v.action === "BUY" ? "positive" : v.action === "SELL" ? "negative" : ""}">${v.ok ? v.action + " " + Math.round(v.confidence) + "%" : "—"}</b><small>${v.ok ? (v.buyTrigger ? "compra " + Number(v.buyTrigger).toFixed(4) : "sin compra") + " · " + (v.ms / 1000).toFixed(1) + " s" : v.error}</small></div>`).join("")}</div>` : '<p class="muted">Decisión de una sola IA (consenso apagado o solo respondió una).</p>'}`;
}

function headlines(title, list) {
  return list?.length
    ? `<div class="news"><span class="label">${title}</span>${list
        .map((h) => {
          const u = safeUrl(h.link);
          return `<a ${u ? `href="${u}" target="_blank" rel="noopener"` : ""}>${h.title}<small>${h.source}${h.ts ? " · " + ago(new Date(h.ts).toISOString()) : ""}</small></a>`;
        })
        .join("")}</div>`
    : "";
}
function renderMacro(m) {
  const box = el("macro");
  if (!m) {
    box.innerHTML = "Todavía no se ha leído el panorama global (se actualiza cada hora).";
    el("macro-risk").textContent = "--";
    return;
  }
  const d = m.digest;
  el("macro-risk").textContent = riskLabel(d.risk);
  el("macro-risk").className = "pill " + riskClass(d.risk);
  const fmtv = (i) =>
    i.value == null
      ? "--"
      : i.unit === "USD" && i.value >= 1e9
        ? "$" + (i.value / 1e12).toFixed(2) + "T"
        : i.unit === "USD"
          ? i.value >= 1000
            ? "$" + Math.round(i.value).toLocaleString("es-MX")
            : "$" + Number(i.value).toFixed(2)
          : Number(i.value).toFixed(i.value >= 100 ? 0 : 2) + (i.unit === "%" ? "%" : i.unit === "/100" ? "/100" : "");
  box.innerHTML = `<p>${d.summary}</p>${d.points?.length ? `<ul class="points">${d.points.map((p) => `<li>${p}</li>`).join("")}</ul>` : ""}<p class="muted">Sesgo cripto: <b>${d.cryptoBias}</b> · puntuación ${d.score} · ${d.model === "reglas" ? "lectura por reglas" : "resumen IA"} · ${ago(m.updatedAt)}</p><div class="macro-grid">${m.indicators.map((i) => `<div class="metric"><span class="label">${i.label}</span><b>${fmtv(i)}</b>${i.id === "fng" ? (i.change != null ? `<small>${i.change >= 0 ? "+" : ""}${i.change} vs ayer</small>` : "") : pct(i.change)}</div>`).join("")}</div>${headlines("ECONOMÍA", m.news.economia)}${headlines("POLÍTICA Y GEOPOLÍTICA", m.news.politica)}${headlines("CRIPTO", m.news.cripto)}${m.errors?.length ? `<p class="muted">Fuentes sin respuesta: ${m.errors.join(" · ")}</p>` : ""}`;
}
async function loadMacro() {
  const r = await api("/macro");
  renderMacro(r?.macro);
}
async function refreshMacro() {
  if (!cloudToken()) {
    toast("Necesitas el token de Cardón DeFi (Config)");
    return;
  }
  el("macro").innerHTML = "Leyendo economía, mercados, política y cripto… (unos 15 s)";
  const r = await api("/macro/refresh", { method: "POST", body: "{}" });
  if (r?.macro) {
    renderMacro(r.macro);
    toast("Panorama global actualizado");
  } else loadMacro();
}

/* --- Config: proveedores y modelos --- */
async function loadAiConfig() {
  const r = await api("/ai/config");
  if (!r) return;
  cache.aiCfg = r;
  cache.aiModels = r.models.map(unesc);
  renderAiProviders();
  renderAiModels();
}
function renderAiProviders() {
  const r = cache.aiCfg;
  const n = r.providers.filter((p) => p.hasKey).length;
  el("ai-keys-state").textContent = `${n}/${r.providers.length} LISTOS`;
  el("ai-keys-state").className = "pill" + (n > 1 ? "" : " warn");
  el("ai-providers").innerHTML = r.providers
    .map((p) => {
      const u = p.signup && safeUrl(p.signup);
      return `<div class="provider"><div class="provider-head"><b>${p.name}</b><span class="pill ${p.hasKey ? "" : "warn"}">${!p.needsKey ? "SIN CLAVE · LISTO" : p.hasKey ? "CLAVE " + (p.keyHint || "") + (p.keySource === "servidor" ? " · servidor" : "") : "SIN CLAVE"}</span></div><p class="muted">${p.note}${u ? ` · <a href="${u}" target="_blank" rel="noopener">Conseguir clave gratis</a>` : ""}</p>${p.needsKey ? `<div class="form-row two"><input id="key-${p.id}" type="password" autocomplete="off" placeholder="Pega tu clave de ${p.name}"><button onclick="saveKey('${p.id}')">Guardar</button></div>${p.keySource === "app" ? `<button class="link-btn" onclick="saveKey('${p.id}',true)">Borrar clave</button>` : ""}` : ""}</div>`;
    })
    .join("");
}
async function saveKey(id, remove) {
  const input = el("key-" + id);
  const value = remove ? null : input?.value.trim();
  if (!remove && !value) {
    toast("Pega la clave primero");
    return;
  }
  if (remove && !confirm("¿Borrar esta clave de la nube?")) return;
  const r = await api("/ai/config", { method: "POST", body: JSON.stringify({ keys: { [id]: value } }) });
  if (r) {
    if (input) input.value = "";
    cache.aiCfg = r;
    renderAiProviders();
    renderAiModels();
    toast(remove ? "Clave borrada" : "Clave guardada cifrada en Cloudflare");
  }
}
function renderAiModels() {
  const r = cache.aiCfg,
    list = cache.aiModels;
  const ready = (m) => {
    const p = r.providers.find((x) => m.startsWith(x.id + ":"));
    return p ? p.hasKey : false;
  };
  const label = (m) => {
    const i = m.indexOf(":");
    const p = r.providers.find((x) => x.id === m.slice(0, i));
    return `${escHtml(m.slice(i + 1).replace(/:free$/, ""))} <small>${p ? p.name.split(" ")[0] : "?"}</small>`;
  };
  const paused = r.paused || {};
  el("ai-models").innerHTML = list
    .map(
      (m, i) =>
        `<div class="model-row ${ready(m) ? "" : "off"}"><span>${i + 1}. ${label(m)}${!ready(m) ? ' <small class="negative">falta clave</small>' : ""}${paused[m] ? ` <small class="warn">en pausa hasta ${new Date(paused[m]).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}</small>` : ""}</span><span><button class="icon-btn" onclick="moveModel(${i},-1)" ${i ? "" : "disabled"}>↑</button><button class="icon-btn" onclick="moveModel(${i},1)" ${i < list.length - 1 ? "" : "disabled"}>↓</button><button class="icon-btn" onclick="removeModel(${i})">✕</button></span></div>`,
    )
    .join("");
  const options = r.providers.flatMap((p) => p.models.map(unesc)).filter((m) => !list.includes(m));
  el("ai-add-select").innerHTML =
    options.map((m) => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join("") || '<option value="">(todos agregados)</option>';
  el("ai-consensus").checked = r.consensus.enabled;
  el("ai-consensus-size").value = String(r.consensus.size);
}
function moveModel(i, d) {
  const l = cache.aiModels;
  [l[i], l[i + d]] = [l[i + d], l[i]];
  renderAiModels();
}
function removeModel(i) {
  if (cache.aiModels.length <= 1) {
    toast("Deja al menos un modelo");
    return;
  }
  cache.aiModels.splice(i, 1);
  renderAiModels();
}
function addModel(custom) {
  const v = (custom ? el("ai-add-custom").value : el("ai-add-select").value).trim();
  if (!v) return;
  if (!/^[a-z]+:[\w.:/-]{2,}$/.test(v)) {
    toast("Formato: proveedor:modelo (ej. groq:llama-3.3-70b-versatile)");
    return;
  }
  if (cache.aiModels.includes(v)) {
    toast("Ya está en la lista");
    return;
  }
  if (cache.aiModels.length >= 8) {
    toast("Máximo 8 modelos");
    return;
  }
  cache.aiModels.push(v);
  if (custom) el("ai-add-custom").value = "";
  renderAiModels();
}
async function saveModels() {
  const r = await api("/ai/config", {
    method: "POST",
    body: JSON.stringify({ models: cache.aiModels, consensus: { enabled: el("ai-consensus").checked, size: Number(el("ai-consensus-size").value) } }),
  });
  if (r) {
    cache.aiCfg = r;
    cache.aiModels = r.models.map(unesc);
    renderAiModels();
    loadAiMode();
    toast("Modelos guardados: se usan desde el próximo ciclo");
  }
}
async function testModels() {
  el("ai-test").innerHTML = "Probando cada modelo con el precio actual… (hasta 45 s)";
  const r = await api("/ai/test", { method: "POST", body: "{}" });
  if (!r) {
    el("ai-test").innerHTML = "";
    return;
  }
  el("ai-test").innerHTML =
    `<div class="votes">${r.results.map((x) => `<div class="vote ${x.ok ? "" : "off"}"><span>${x.label}</span><b class="${x.ok ? "positive" : "negative"}">${x.ok ? "OK · " + x.action + " " + Math.round(x.confidence) + "%" : "FALLA"}</b><small>${x.ok ? (x.ms / 1000).toFixed(1) + " s" : x.error}</small></div>`).join("")}</div>`;
}

document.querySelectorAll(".nav button").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.target === "ai") loadAiScreen();
    if (b.dataset.target === "config") loadAiConfig();
  }),
);

/* ===== Mercados: qué monedas opera el bot y en qué red. Los ids vienen de un catálogo fijo del servidor y se validan antes de usarlos. ===== */
cache.markets = [];
const okId = (id) => /^[A-Z0-9]{2,8}$/.test(id || "");
const modeLabel = (m) => (m.mode === "live" ? "REAL" : "SIMULACIÓN");
async function loadMarkets() {
  const r = await api("/markets");
  if (!r?.markets) return;
  cache.markets = r.markets.filter((m) => okId(m.id));
  if (window.cardonLiveMoney) window.cardonLiveMoney(cache.markets.some((m) => m.enabled && m.mode === "live"));
  const cur = cache.markets.find((m) => m.id === MARKET);
  if (!cur || !cur.enabled) {
    if (MARKET !== "POL") {
      setMarket("POL");
      return;
    }
  }
  renderMarketBar();
  renderMarketsPanel();
}
function setMarket(id) {
  if (!okId(id) || (id === MARKET && !GLOBAL)) return;
  MARKET = id;
  GLOBAL = false;
  try {
    localStorage.setItem("dexpilot-market", id);
    localStorage.setItem("dexpilot-global", "0");
  } catch (e) {}
  cache.chat = [];
  if (window.deskChartState) window.deskChartState.symbol = id;
  renderMarketBar();
  refresh();
  if (el("ai")?.classList.contains("active") && typeof loadAiScreen === "function") loadAiScreen();
}
function renderMarketBar() {
  let bar = el("market-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "market-bar";
    el("app").insertAdjacentElement("beforebegin", bar);
  }
  const on = cache.markets.filter((m) => m.enabled);
  bar.innerHTML =
    `<button class="mk globe ${GLOBAL ? "active" : ""}" onclick="setGlobal()" title="Todo junto">${GLOBE}<small>GLOBAL</small></button>` +
    on
      .map(
        (m) =>
          `<button class="mk ${!GLOBAL && m.id === MARKET ? "active" : ""}" onclick="setMarket('${m.id}')"><b>${m.id}</b><small>${modeLabel(m)}</small></button>`,
      )
      .join("") +
    `<button class="mk add" onclick="openMarkets()" title="Activar más monedas">＋<small>monedas</small></button>`;
  const pair = el("order-pair");
  if (pair) pair.textContent = MARKET + "/USDC";
  const tabs = document.querySelector("[data-desk-asset]");
  if (tabs) {
    const ids = [...new Set([...on.map((m) => m.id), "POL", "DOT"])];
    const cur = window.deskChartState?.symbol;
    tabs.innerHTML = ids
      .map((id) => `<button class="${id === cur ? "active" : ""}" data-symbol="${id}" onclick="loadDeskChart('${id}')">${id}</button>`)
      .join("");
  }
}
function openMarkets() {
  document.querySelector('[data-target="config"]').click();
  el("markets-panel")?.scrollIntoView({ behavior: "smooth" });
}
function renderMarketsPanel() {
  let box = el("markets-panel");
  if (!box) {
    box = document.createElement("div");
    box.id = "markets-panel";
    box.className = "panel";
    const cfg = el("config");
    (cfg.firstElementChild || cfg).insertAdjacentElement(cfg.firstElementChild ? "afterend" : "afterbegin", box);
  }
  const groups = {};
  cache.markets.forEach((m) => (groups[m.venueName] = groups[m.venueName] || []).push(m));
  box.innerHTML = `<div class="panel-title">Mercados <span class="pill">${cache.markets.filter((m) => m.enabled).length} ACTIVOS</span></div><p class="muted">Cada moneda se opera contra USDC en un exchange descentralizado con tu propia wallet. Las nuevas empiezan en simulación (cartera de práctica de 10 USDC, precios reales) para que veas cómo se comporta antes de usar dinero real.</p>${Object.entries(
    groups,
  )
    .map(([venue, list]) => `<div class="mk-group">${venue}</div>${list.map(marketRow).join("")}`)
    .join("")}`;
}
function marketRow(m) {
  const state = m.enabled ? `<span class="pill ${m.mode === "live" ? "positive" : "warn"}">${modeLabel(m)}</span>` : '<span class="pill">APAGADO</span>';
  const info = m.enabled
    ? `${m.price ? assetPrice("", m.price) : "esperando primer ciclo"}${m.balance != null ? ` · ${Number(m.balance).toPrecision(4)} ${m.id} · ${money(m.usdc)} USDC` : ""}${m.errors?.length ? ` · <span class="negative">${m.errors[0]}</span>` : ""}`
    : "Sin activar";
  const mode =
    m.enabled && !m.modeLocked
      ? `<button onclick="setMarketMode('${m.id}','${m.mode === "live" ? "paper" : "live"}')">${m.mode === "live" ? "Volver a simulación" : "Pasar a dinero real"}</button>`
      : "";
  const toggle =
    m.id === "POL"
      ? ""
      : `<button class="${m.enabled ? "danger" : "primary"}" onclick="toggleMarket('${m.id}',${m.enabled ? "false" : "true"})">${m.enabled ? "Apagar" : "Activar"}</button>`;
  return `<div class="mk-row"><div><b>${m.pair}</b> <small class="muted">${m.name}</small> ${state}<p class="muted">${info}</p></div><div class="mk-actions">${mode}${toggle}</div></div>`;
}
async function postMarket(body) {
  if (!cloudToken()) {
    toast("Inicia sesión en Config para cambiar mercados");
    return null;
  }
  return api("/markets", { method: "POST", body: JSON.stringify(body) });
}
async function toggleMarket(id, enabled) {
  if (!okId(id)) return;
  if (!enabled && !confirm(`¿Apagar ${id}? El bot deja de analizarlo y sus órdenes activas quedan sin vigilar hasta que lo actives de nuevo.`)) return;
  const r = await postMarket({ market: id, enabled });
  if (r) {
    toast(enabled ? `${id} activado: su primer ciclo corre en menos de 5 min` : `${id} apagado`);
    if (!enabled && MARKET === id) {
      setMarket("POL");
      return;
    }
    loadMarkets();
  }
}
async function setMarketMode(id, mode) {
  if (!okId(id)) return;
  const m = cache.markets.find((x) => x.id === id);
  if (mode === "live") {
    const beta =
      m?.venue === "hydration"
        ? "\n\nAVISO: la firma en Hydration todavía no se ha probado con dinero real. La primera operación es la prueba; empieza con poco."
        : "";
    if (
      !confirm(
        `¿Pasar ${id} a DINERO REAL?\n\nEl bot comprará y venderá ${id} con el USDC de tu wallet en ${m?.venueName || "su red"}, hasta el máximo por operación configurado.${beta}`,
      )
    )
      return;
  }
  const r = await postMarket({ market: id, mode });
  if (r) {
    toast(`${id}: ${mode === "live" ? "dinero real" : "simulación"}`);
    loadMarkets();
    if (id === MARKET) refresh();
  }
}

/* ===== Inicio de sesión: la wallet del teléfono firma un reto del servidor (tras huella o PIN) y la app guarda el token de sesión. ===== */
let walletLoginResolve = null;
window.onWalletLogin = (raw) => {
  let r;
  try {
    r = JSON.parse(raw);
  } catch (e) {
    r = { error: "respuesta inválida" };
  }
  if (walletLoginResolve) {
    const f = walletLoginResolve;
    walletLoginResolve = null;
    f(r);
  }
};
const LOGIN_ERRORS = {
  WALLET_NOT_CONFIGURED: "Este teléfono aún no tiene wallet: créala o impórtala en la pestaña Wallet",
  BIOMETRIC_API_REQUIRED: "Este Android es demasiado antiguo para iniciar sesión con huella; usa el token manual",
  BIOMETRIC_TIMEOUT: "Se agotó el tiempo de espera",
  BIOMETRIC_ERROR_10: "Cancelado",
  BIOMETRIC_ERROR_13: "Cancelado",
  BIOMETRIC_ERROR_11: "Configura primero una huella o un PIN de bloqueo en el teléfono",
  BIOMETRIC_ERROR_14: "Configura primero un PIN de bloqueo en el teléfono",
};
function loginNote(text, bad) {
  const n = el("login-note");
  if (n) {
    n.textContent = text || "";
    n.className = bad ? "negative" : "muted";
  }
}
async function walletLogin() {
  if (!window.AndroidWallet || typeof AndroidWallet.walletLogin !== "function") {
    toast("El inicio de sesión con huella solo funciona dentro de la app Android");
    return;
  }
  loginNote("Pidiendo acceso al bot…");
  const c = await api("/auth/challenge");
  if (!c?.message) {
    loginNote("No se pudo contactar con el bot", true);
    return;
  }
  const message = unesc(c.message);
  let local = {};
  try {
    local = JSON.parse(AndroidWallet.status());
  } catch (e) {}
  if (local.address && c.wallet && local.address.toLowerCase() !== unesc(c.wallet).toLowerCase()) {
    loginNote(
      `La wallet de este teléfono (${local.address.slice(0, 8)}…) no es la del bot (${unesc(c.wallet).slice(0, 8)}…). Importa la wallet del bot en la pestaña Wallet o usa el token manual.`,
      true,
    );
    return;
  }
  const pending = new Promise((resolve) => {
    walletLoginResolve = resolve;
    setTimeout(() => {
      if (walletLoginResolve) {
        walletLoginResolve = null;
        resolve({ error: "BIOMETRIC_TIMEOUT" });
      }
    }, 90000);
  });
  let started = {};
  try {
    started = JSON.parse(AndroidWallet.walletLogin(message));
  } catch (e) {
    started = { error: String(e.message || e) };
  }
  if (started.status !== "BIOMETRIC_PENDING") {
    walletLoginResolve = null;
    loginNote(LOGIN_ERRORS[started.error] || "No se pudo iniciar: " + (started.error || "error"), true);
    return;
  }
  loginNote("Confirma con tu huella o PIN…");
  const signed = await pending;
  if (signed.error || signed.status !== "SIGNED") {
    loginNote(LOGIN_ERRORS[signed.error] || "No se completó: " + (signed.error || "cancelado"), true);
    return;
  }
  let r,
    data = {};
  try {
    r = await fetch(API + "/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: signed.message, signature: signed.signature }),
    });
    data = await r.json();
  } catch (e) {
    loginNote("Sin conexión con el bot: " + e.message, true);
    return;
  }
  if (!r.ok || !/^[0-9a-f]{64}$/.test(data.token || "")) {
    loginNote(unesc(data.error) || "El bot rechazó el inicio de sesión", true);
    return;
  }
  try {
    localStorage.setItem("dexpilot-token", data.token);
    localStorage.setItem("dexpilot-session", "1");
  } catch (e) {
    loginNote("No se pudo guardar la sesión en el teléfono", true);
    return;
  }
  if (el("cloud-token")) el("cloud-token").value = "";
  updateCloudState(true);
  sessionUi();
  loginNote("Sesión iniciada. Caduca en 90 días; entonces vuelves a tocar el botón.");
  toast("Sesión iniciada");
  refresh();
}
async function cloudLogout() {
  if (
    !confirm(
      "¿Cerrar la sesión de Cardón DeFi en este teléfono? El bot sigue funcionando; solo dejas de poder controlarlo desde aquí hasta que vuelvas a entrar.",
    )
  )
    return;
  await api("/auth/logout", { method: "POST", body: "{}" });
  try {
    localStorage.removeItem("dexpilot-token");
    localStorage.removeItem("dexpilot-session");
  } catch (e) {}
  updateCloudState(false);
  sessionUi();
  loginNote("Sesión cerrada.");
}
function sessionUi() {
  const b = el("logout-btn");
  let has = false;
  try {
    has = !!localStorage.getItem("dexpilot-token");
  } catch (e) {}
  if (b) b.hidden = !has;
}
/* Al abrir: si la sesión guardada ya no vale (caducó o se cerró), se dice claramente en vez de fallar en cada botón. */
async function checkSession() {
  sessionUi();
  if (!cloudToken()) return;
  let r;
  try {
    r = await fetch(API + "/auth/session", { headers: { authorization: "Bearer " + cloudToken() } });
    const d = await r.json();
    if (r.ok && d.valid === false) {
      updateCloudState(false);
      loginNote("Tu sesión caducó o se cerró: vuelve a iniciar sesión.", true);
    }
  } catch (e) {}
}
checkSession();

/* ===== Vista global: el total de todas las redes y monedas en la pantalla principal. La simulación se muestra aparte, nunca sumada. ===== */
const GLOBE =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18M5 7.2h14M5 16.8h14"/></svg>';
function setGlobal() {
  if (GLOBAL) return;
  GLOBAL = true;
  try {
    localStorage.setItem("dexpilot-global", "1");
  } catch (e) {}
  renderMarketBar();
  refresh();
}
const signUsd = (v) => (v >= 0 ? "+$" : "−$") + Math.abs(Number(v || 0)).toFixed(2);
const STATE_CLASS = { OK: "positive", "CON ERRORES": "warn", DETENIDO: "bad", ESPERANDO: "warn" };
function renderGlobal() {
  const label = el("total-label"),
    dash = el("dashboard");
  let panel = el("global-panel");
  if (dash) dash.classList.toggle("global-view", GLOBAL);
  const g = cache.portfolio;
  if (!GLOBAL || !g?.real) {
    if (label) label.textContent = `VALOR · MERCADO ${MARKET}`;
    if (panel) panel.remove();
    return;
  }
  const r = g.real,
    sim = g.simulation || { markets: 0 };
  if (label) label.textContent = "VALOR TOTAL · TODAS LAS REDES";
  el("total").textContent = money(r.valueUsd);
  const p = el("pnl");
  p.textContent = `Bot ${signUsd(r.pnlUsd)} (${r.pnlPct >= 0 ? "+" : "−"}${Math.abs(r.pnlPct).toFixed(2)}%) · ventas cerradas ${signUsd(r.realizedUsd)} · ${r.markets} ${r.markets === 1 ? "mercado" : "mercados"} con dinero real`;
  p.className = r.pnlUsd >= 0 ? "positive" : "negative";
  const live = (g.markets || []).filter((m) => okId(m.id) && m.mode === "live"),
    paper = (g.markets || []).filter((m) => okId(m.id) && m.mode !== "live");
  el("asset-cards").innerHTML =
    (r.usdc || [])
      .map(
        (u) =>
          `<article class="asset-card"><span class="ticker">USDC · ${u.venueName}</span><strong>${money(u.amount)}</strong><small>${Number(u.amount).toFixed(2)} USDC</small></article>`,
      )
      .join("") +
    live
      .map(
        (m) =>
          `<article class="asset-card" onclick="setMarket('${m.id}')"><span class="ticker">${m.id} · ${m.venueName}</span><strong>${money(m.valueUsd)}</strong><small>${assetAmount(m.id, m.balance)} ${m.id}</small></article>`,
      )
      .join("");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "global-panel";
    panel.className = "panel";
    el("asset-cards").insertAdjacentElement("afterend", panel);
  }
  const row = (m) =>
    `<button class="g-row" onclick="setMarket('${m.id}')"><span class="g-name"><b>${m.id}</b><small>${m.venueName}</small></span><span class="g-num"><b>${m.mode === "live" ? money(m.valueUsd) : "práctica"}</b><small>${m.price ? assetPrice("", m.price) : "sin precio"}</small></span><span class="g-num"><b class="${m.pnlUsd >= 0 ? "positive" : "negative"}">${signUsd(m.pnlUsd)}</b><small>${m.activeOrders} ${m.activeOrders === 1 ? "orden" : "órdenes"}</small></span><span class="pill ${STATE_CLASS[m.state] || "warn"}">${m.state}</span></button>`;
  panel.innerHTML = `<div class="panel-title"><span>${GLOBE} Todos los mercados</span><span class="pill ${g.paused ? "bad" : ""}">${g.paused ? "PAUSADO" : live.length + " REALES"}</span></div><div class="g-head"><span>Moneda</span><span>Valor</span><span>Resultado del bot</span><span>Estado</span></div>${live.map(row).join("") || '<p class="muted">Ningún mercado opera con dinero real.</p>'}${paper.length ? `<div class="mk-group">Simulación · dinero ficticio, no suma al total (${money(sim.valueUsd)} de práctica, resultado ${signUsd(sim.pnlUsd)})</div>${paper.map(row).join("")}` : ""}<p class="muted">Toca una moneda para ver su detalle, sus órdenes y su gráfica.</p>`;
  const dl = el("status-dl");
  const first = dl?.querySelector("dd");
  if (first) first.textContent = "Todos · vista global";
}
