/* Cardón Comunidad (opcional): registro solo con el correo y errores/arreglos compartidos entre agentes.
   La app funciona igual sin registro. La llave para borrar el registro solo vive en este teléfono.
   Todo texto del servidor va con textContent. */
(function () {
  "use strict";
  var C = window.CARDON || {},
    PUB = !!C.publica,
    HUB = (C.comunidad || "https://cardon-comunidad.pages.dev").replace(/\/+$/, ""),
    KEY = "cardon-registro",
    SEEN = "cardon-registro-visto";
  var $ = function (id) {
    return document.getElementById(id);
  };
  function get(k) {
    try {
      return localStorage.getItem(k) || "";
    } catch (e) {
      return "";
    }
  }
  function set(k, v) {
    try {
      if (v) localStorage.setItem(k, v);
      else localStorage.removeItem(k);
    } catch (e) {}
  }
  function reg() {
    try {
      return JSON.parse(get(KEY) || "null");
    } catch (e) {
      return null;
    }
  }
  function node(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }
  function note(id, text, cls) {
    var n = $(id);
    if (!n) return;
    n.textContent = text;
    n.className = "setup-note " + (cls || "");
  }
  function hub(path, body) {
    return fetch(HUB + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok || !d.ok) throw new Error(d.error || "HTTP " + r.status);
        return d;
      });
    });
  }
  var EMAIL = /^[^\s@"<>()[\]\\,;:]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

  function register(email, noteId) {
    email = String(email || "").trim();
    if (!EMAIL.test(email)) return Promise.resolve(note(noteId, "Revisa el correo.", "bad"));
    note(noteId, "Registrando…");
    return hub("/v1/registro", { email: email, edicion: PUB ? "publica" : "personal" })
      .then(function (d) {
        set(KEY, JSON.stringify({ email: email.toLowerCase(), llave: d.llave || "", ts: new Date().toISOString() }));
        set(SEEN, "1");
        paint();
        note(noteId, d.existente ? "Ese correo ya estaba registrado. Para borrarlo, usa el teléfono donde te registraste." : "¡Listo, gracias! Puedes borrar tu registro cuando quieras.", "ok");
        stats();
      })
      .catch(function (e) {
        note(noteId, "No se pudo registrar: " + e.message, "bad");
      });
  }
  function unregister() {
    var r = reg();
    if (!r) return;
    if (!r.llave) {
      set(KEY, "");
      paint();
      return note("com-note", "Este teléfono no tiene la llave de ese registro; se olvidó aquí. Para borrarlo del servidor, escríbenos en GitHub.", "bad");
    }
    if (!window.confirm("¿Borrar tu correo de Cardón Comunidad?")) return;
    note("com-note", "Borrando…");
    hub("/v1/registro/borrar", { llave: r.llave })
      .then(function () {
        set(KEY, "");
        paint();
        note("com-note", "Tu correo se borró del servidor.", "ok");
        stats();
      })
      .catch(function (e) {
        note("com-note", "No se pudo borrar: " + e.message, "bad");
      });
  }
  function stats() {
    return hub("/v1/estado")
      .then(function (d) {
        var s = $("com-stats");
        if (s) s.textContent = d.usuarios + (d.usuarios === 1 ? " persona registrada" : " personas registradas") + " · " + d.agentes30d + (d.agentes30d === 1 ? " agente comparte" : " agentes comparten") + " errores y arreglos (30 días)";
      })
      .catch(function () {});
  }
  function paint() {
    var r = reg(),
      box = $("com-reg");
    if (!box) return;
    box.innerHTML = "";
    if (r) {
      var p = node("p", "muted", "Registrado como ");
      p.appendChild(node("b", null, r.email));
      box.appendChild(p);
      var b = node("button", "wide", "Borrar mi registro");
      b.onclick = unregister;
      box.appendChild(b);
    } else {
      box.innerHTML = '<label>Tu correo<input id="com-email" type="email" autocomplete="email" autocapitalize="off" spellcheck="false" placeholder="tu@correo.com"></label><button id="com-go" class="primary wide">Registrarme</button>';
      $("com-go").onclick = function () {
        register($("com-email").value, "com-note");
      };
    }
  }

  // Interruptor «compartir errores»: vive en el agente (lo lee del médico y se cambia con /doctor/comunidad).
  function paintShare(d) {
    var cb = $("com-share");
    if (!cb || !d || !d.comunidad) return;
    cb.disabled = false;
    cb.checked = !!d.comunidad.on;
  }
  window.cardonShareErrors = function (on) {
    var cb = $("com-share");
    if (typeof api !== "function") return;
    cb.disabled = true;
    api("/doctor/comunidad", { method: "POST", body: JSON.stringify({ on: !!on }) }).then(function (r) {
      cb.disabled = false;
      if (!r) {
        cb.checked = !on;
        return note("com-share-note", "Inicia sesión en tu agente para cambiarlo.", "bad");
      }
      cb.checked = !!r.comunidad.on;
      note("com-share-note", r.comunidad.on ? "Tu agente compartirá, de forma anónima, qué arreglo funcionó para cada error." : "Tu agente ya no comparte nada.", "ok");
      if (window.cardonDoctor) window.cardonDoctor.check();
    });
  };

  function invite() {
    var dash = $("dashboard");
    if (!PUB || !dash || reg() || get(SEEN) || !get("cardon-api")) return;
    var card = node("div", "panel config-form com-invite");
    card.innerHTML =
      '<div class="panel-title">Únete a la comunidad <span class="pill">OPCIONAL</span></div><p class="muted">Deja tu correo para recibir avisos de versiones nuevas y para que sepamos cuántas personas usan Cardón. Solo se guarda el correo, y puedes borrarlo cuando quieras desde Configuración. La app funciona igual sin registro.</p>' +
      '<label>Tu correo<input id="inv-email" type="email" autocomplete="email" autocapitalize="off" spellcheck="false" placeholder="tu@correo.com"></label><div class="form-row two"><button id="inv-no">Seguir sin registro</button><button id="inv-go" class="primary">Registrarme</button></div><p id="inv-note" class="setup-note"></p>';
    dash.insertBefore(card, dash.firstChild);
    $("inv-no").onclick = function () {
      set(SEEN, "1");
      card.remove();
    };
    $("inv-go").onclick = function () {
      register($("inv-email").value, "inv-note").then(function () {
        if (reg())
          setTimeout(function () {
            card.remove();
          }, 2500);
      });
    };
  }

  function mount() {
    var config = $("config");
    if (!config || $("com-panel")) return;
    var panel = node("div", "panel config-form");
    panel.id = "com-panel";
    panel.innerHTML =
      '<div class="panel-title">Comunidad <span class="pill">OPCIONAL</span></div><p id="com-stats" class="muted"></p>' +
      '<p class="muted"><b>Registro:</b> solo tu correo, para avisarte de versiones nuevas y contar cuántas personas usan Cardón. No se vende ni se comparte.</p><div id="com-reg"></div><p id="com-note" class="setup-note"></p>' +
      '<label class="check"><input id="com-share" type="checkbox" disabled onchange="cardonShareErrors(this.checked)"> Compartir errores y arreglos de mi agente (anónimo)</label><p class="muted">Tu agente envía solo el tipo de error (por ejemplo «ia» o «precio»), el arreglo que probó y si funcionó, con un número al azar. Nunca tu wallet, saldos, montos ni claves. A cambio, «Buscar y corregir» te muestra qué funcionó en otros agentes.</p><p id="com-share-note" class="setup-note"></p>' +
      '<p class="muted"><a href="' + HUB + '/">Qué guarda y código abierto</a></p>';
    var danger = config.querySelector(".danger-zone");
    config.insertBefore(panel, danger || null);
    paint();
    stats();
    invite();
    document.addEventListener("cardon-doctor", function (e) {
      paintShare(e.detail);
    });
  }
  window.cardonComunidad = { register: register, unregister: unregister, stats: stats };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
