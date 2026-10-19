/* Estado en tiempo real y «Buscar y corregir» (Config).
   El bot clasifica sus errores (/doctor) y solo acepta arreglos de una lista cerrada. Aquí se aplican solos los
   seguros (repetir un ciclo, reordenar la IA); los que cambian algo tuyo (pasar a simulación, reanudar) piden
   confirmación. La IA explica y elige entre esos mismos arreglos. Todo texto del servidor va con textContent. */
(function () {
  "use strict";
  var AREAS = [
    ["nube", "☁ Nube (Cloudflare)"],
    ["ciclos", "⟳ Ciclos"],
    ["red", "⛓ Redes y precios"],
    ["ia", "◎ IA"],
    ["fondos", "◈ Fondos y gas"],
    ["dex", "⇄ Intercambios (DEX)"],
  ];
  var AREA_OF = { sin_ciclos: "ciclos", atrasado: "ciclos", pausado: "ciclos", ordenes: "ciclos", error: "ciclos", precio: "red", onchain: "red", ia: "ia", gas: "fondos", sin_fondos: "fondos", clave: "fondos", dex: "dex" };
  var state = { data: null, ms: null, err: null, at: 0 },
    running = false,
    timer = null;

  function $(id) {
    return document.getElementById(id);
  }
  function node(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }
  function call(path, body) {
    return typeof api === "function" ? api(path, body ? { method: "POST", body: JSON.stringify(body) } : undefined) : Promise.resolve(null);
  }

  function check() {
    var t0 = Date.now();
    return call("/doctor").then(function (d) {
      state.ms = Date.now() - t0;
      state.data = d;
      state.err = d ? null : "sin respuesta";
      state.at = Date.now();
      paint();
      return d;
    });
  }

  function lights() {
    var out = {};
    AREAS.forEach(function (a) {
      out[a[0]] = { level: "verde", detail: "Sin problemas" };
    });
    if (state.err) {
      out.nube = { level: "rojo", detail: "No responde: " + state.err };
      return out;
    }
    out.nube = { level: state.ms > 4000 ? "amarillo" : "verde", detail: state.ms > 4000 ? "Responde lento" : "En línea", ms: state.ms };
    ((state.data && state.data.findings) || []).forEach(function (f) {
      var k = AREA_OF[f.code] || "ciclos",
        cur = out[k];
      var text = (f.market ? f.market + ": " : "") + f.detail;
      if (cur.level === "verde" || (cur.level === "amarillo" && f.level === "rojo")) out[k] = { level: f.level, detail: text, n: 1 };
      else if (cur.level === f.level) {
        cur.n = (cur.n || 1) + 1;
        cur.extra = cur.n - 1;
      }
    });
    return out;
  }
  function worst(l) {
    var w = "verde";
    Object.keys(l).forEach(function (k) {
      if (l[k].level === "rojo" || (l[k].level === "amarillo" && w === "verde")) w = l[k].level;
    });
    return w;
  }

  function paint() {
    var box = $("doc-lights");
    if (!box) return;
    var l = lights(),
      w = worst(l);
    box.innerHTML = "";
    AREAS.forEach(function (a) {
      var x = l[a[0]],
        row = node("div", "doc-row " + x.level),
        info = node("span", "doc-info");
      row.appendChild(node("i", "doc-dot"));
      info.appendChild(node("b", null, a[1]));
      info.appendChild(node("small", null, x.detail + (x.extra ? " (+" + x.extra + " más)" : "")));
      row.appendChild(info);
      if (x.ms != null) row.appendChild(node("span", "doc-ms", x.ms + " ms"));
      box.appendChild(row);
    });
    var pill = $("doc-pill");
    pill.textContent = state.err ? "SIN CONEXIÓN" : { rojo: "HAY FALLAS", amarillo: "REVISAR", verde: "TODO BIEN" }[w];
    pill.className = "pill " + (w === "rojo" ? "bad" : w === "amarillo" ? "warn" : "");
    paintFindings();
    paintLog();
    $("doc-ts").textContent = state.at ? "Revisado " + new Date(state.at).toLocaleTimeString() + " · se actualiza solo cada 20 s mientras estás en Config" : "";
  }

  function fixButton(fix, market, label) {
    var d = state.data || {},
      F = (d.fixes || {})[fix];
    if (!F) return null;
    var b = node("button", F.safe ? "primary" : "", label || F.text + (market ? " (" + market + ")" : ""));
    b.onclick = function () {
      if (!F.safe && !window.confirm(F.text + (market ? " (" + market + ")" : "") + "?")) return;
      b.disabled = true;
      apply(fix, market).then(function () {
        b.disabled = false;
        return check();
      });
    };
    return b;
  }

  function paintFindings() {
    var box = $("doc-findings");
    box.innerHTML = "";
    ((state.data && state.data.findings) || []).forEach(function (f) {
      var card = node("div", "doc-finding " + f.level);
      card.appendChild(node("b", null, (f.market ? f.market + " · " : "") + f.detail));
      (f.fixes || []).forEach(function (id) {
        var b = fixButton(id, f.market);
        if (b) card.appendChild(b);
      });
      if (!(f.fixes || []).length) card.appendChild(node("small", "muted", "No tiene arreglo automático: toca «Buscar y corregir» para que la IA te explique qué hacer."));
      box.appendChild(card);
    });
  }

  function paintLog() {
    var box = $("doc-history");
    var log = (state.data && state.data.log) || [];
    box.hidden = !log.length;
    if (!log.length) return;
    box.innerHTML = "";
    box.appendChild(node("b", null, "Arreglos recientes"));
    log.slice(0, 6).forEach(function (e) {
      box.appendChild(
        node(
          "div",
          e.ok ? "ok" : "bad",
          new Date(e.ts).toLocaleString() + " · " + (e.auto ? "automático" : "desde la app") + " · " + (e.ok ? "✓ " : "✗ ") + e.result,
        ),
      );
    });
  }

  function apply(fix, market) {
    return call("/doctor/fix", { fix: fix, market: market }).then(function (r) {
      if (r && typeof toast === "function") toast((r.ok ? "✓ " : "✗ ") + r.result);
      return r;
    });
  }

  function autoFix() {
    if (running) return Promise.resolve();
    running = true;
    var out = $("doc-log"),
      btn = $("doc-fix");
    out.hidden = false;
    out.innerHTML = "";
    btn.disabled = true;
    function log(t, cls) {
      var d = node("div", cls || "", t);
      out.appendChild(d);
      return d;
    }
    log("▸ Revisando nube, ciclos, redes, IA y fondos…");
    return check()
      .then(function (d) {
        if (!d) throw new Error("tu bot no responde");
        var f = d.findings || [];
        if (!f.length) {
          log("✓ Todo funciona: no hay nada que corregir.", "ok");
          return;
        }
        f.forEach(function (x) {
          log("  " + (x.level === "rojo" ? "✗ " : "! ") + (x.market ? x.market + ": " : "") + x.detail, x.level === "rojo" ? "bad" : "warn");
        });
        // Arreglos seguros: cada uno una sola vez por mercado.
        var todo = [],
          seen = {};
        f.forEach(function (x) {
          (x.fixes || []).forEach(function (id) {
            var F = d.fixes[id],
              key = id + ":" + (id === "ia_todos" ? "" : x.market || "");
            if (F && F.safe && !seen[key]) {
              seen[key] = 1;
              todo.push({ fix: id, market: x.market });
            }
          });
        });
        var i = 0;
        function next() {
          if (i >= todo.length) return Promise.resolve();
          var t = todo[i++],
            l = log("▸ " + d.fixes[t.fix].text + (t.market && t.fix !== "ia_todos" ? " (" + t.market + ")" : "") + "…");
          return apply(t.fix, t.market).then(function (r) {
            l.textContent = "  " + (r && r.ok ? "✓ " : "✗ ") + (r ? r.result : "no se pudo (¿sesión iniciada?)");
            l.className = r && r.ok ? "ok" : "bad";
            return next();
          });
        }
        return next()
          .then(check)
          .then(function (d2) {
            var rest = (d2 && d2.findings) || [];
            if (!rest.length) {
              log("✓ Arreglado: ya no quedan problemas.", "ok");
              return;
            }
            log("▸ Pidiendo a la IA que explique lo que queda…");
            return call("/doctor/ai", {}).then(function (r) {
              if (!r) {
                log("  ✗ La IA no pudo analizarlo ahora.", "bad");
                return;
              }
              log("◎ IA (" + r.model + "): " + r.resumen);
              (r.pasos || []).forEach(function (p, n) {
                log("   " + (n + 1) + ". " + p);
              });
              var picks = (r.arreglos || []).filter(function (a) {
                return d2.fixes[a.fix] && !d2.fixes[a.fix].safe;
              });
              if (picks.length) {
                log("La IA sugiere esto; se aplica solo si lo confirmas:");
                picks.forEach(function (a) {
                  var b = fixButton(a.fix, a.market);
                  if (b) out.appendChild(b);
                });
              }
            });
          });
      })
      .catch(function (e) {
        log("✗ " + (e.message || e), "bad");
      })
      .then(function () {
        running = false;
        btn.disabled = false;
      });
  }

  function visible() {
    var c = $("config");
    return c && c.classList.contains("active") && !document.hidden;
  }
  function loop() {
    if (visible() && !running) check();
  }

  function mount() {
    var config = $("config");
    if (!config || $("doc-panel")) return;
    var panel = node("div", "panel config-form");
    panel.id = "doc-panel";
    panel.innerHTML =
      '<div class="panel-title">🚦 Estado en tiempo real <span id="doc-pill" class="pill">—</span></div><div id="doc-lights" class="doc-lights"></div><div id="doc-findings"></div>' +
      '<div class="form-row two"><button id="doc-check">↻ REVISAR AHORA</button><button id="doc-fix" class="primary">🔍 BUSCAR Y CORREGIR</button></div>' +
      '<small id="doc-ts" class="muted"></small><div id="doc-log" class="doc-log" hidden></div><div id="doc-history" class="doc-log" hidden></div>' +
      '<p class="muted">El bot también se revisa solo: si la IA falla, prueba los modelos y deja primero a los que responden. La app te avisa con una notificación cuando un mercado sigue con errores.</p>';
    config.insertBefore(panel, config.querySelector(".panel"));
    $("doc-check").onclick = function () {
      check();
    };
    $("doc-fix").onclick = autoFix;
    paint();
    if (!timer) timer = setInterval(loop, 20000);
    document.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest('[data-target="config"]');
      if (b) setTimeout(check, 50);
    });
  }
  window.cardonDoctor = { check: check, autoFix: autoFix };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
