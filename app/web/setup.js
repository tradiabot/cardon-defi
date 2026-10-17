/* Cardón DeFi: aviso legal, instalador guiado, temas de color, clave de firma y donaciones.
   Todo texto que venga de fuera (GitHub, Cloudflare) se inserta con textContent, nunca como HTML. */
(function () {
  "use strict";
  var C = window.CARDON || {},
    PUB = !!C.publica,
    NATIVE = window.AndroidWallet || null;
  var AVISO_VERSION = "2026-10-11",
    REPO = "cardon-nube",
    WORKER = "cardon-defi";
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
      localStorage.setItem(k, v);
    } catch (e) {}
  }
  function say(m) {
    if (typeof toast === "function") toast(m);
  }
  function wait(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }
  function parse(t) {
    try {
      return t ? JSON.parse(t) : {};
    } catch (e) {
      return {};
    }
  }
  function native(name) {
    try {
      return parse(NATIVE[name].apply(NATIVE, [].slice.call(arguments, 1)));
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }
  function h(html) {
    var d = document.createElement("div");
    d.innerHTML = html;
    return d.firstElementChild;
  }

  /* ---------- Temas de color ---------- */
  var THEMES = [
    { id: "noche", name: "Noche", hint: "Menta sobre oscuro", sw: ["#0a0f0d", "#5eeec8", "#d9b87a"] },
    { id: "atardecer", name: "Atardecer", hint: "Terracota cálido", sw: ["#140d0a", "#ff9d6b", "#f2c879"] },
    { id: "oasis", name: "Oasis", hint: "Azul de agua", sw: ["#090e14", "#6cc7ff", "#e3c08a"] },
    { id: "arena", name: "Arena", hint: "Claro, para el sol", sw: ["#f3ede1", "#0f6b55", "#a8823f"] },
  ];
  function applyTheme(id) {
    if (
      !THEMES.some(function (t) {
        return t.id === id;
      })
    )
      id = "noche";
    document.documentElement.setAttribute("data-theme", id);
    var meta = document.querySelector("meta[name=theme-color]");
    if (meta)
      meta.content = THEMES.filter(function (t) {
        return t.id === id;
      })[0].sw[0];
    set("cardon-theme", id);
    [].forEach.call(document.querySelectorAll(".theme-opt"), function (b) {
      b.classList.toggle("active", b.dataset.theme === id);
    });
    window.dispatchEvent(new Event("cardon-theme"));
  }
  window.cardonTheme = applyTheme;
  applyTheme(get("cardon-theme") || "noche");

  /* ---------- HTTP hacia GitHub y Cloudflare ---------- */
  var pending = {},
    seq = 0;
  window.onNativeHttp = function (id, status, text) {
    var f = pending[id];
    if (f) {
      delete pending[id];
      f({ status: status, data: parse(text) });
    }
  };
  function http(method, url, headers, body) {
    var payload = body ? JSON.stringify(body) : "";
    if (NATIVE && NATIVE.http)
      return new Promise(function (resolve) {
        var id = "h" + ++seq;
        pending[id] = resolve;
        NATIVE.http(id, method, url, JSON.stringify(headers), payload);
      });
    return fetch(url, { method: method, headers: headers, body: payload || undefined })
      .then(function (r) {
        return r.text().then(function (t) {
          return { status: r.status, data: parse(t) };
        });
      })
      .catch(function (e) {
        return { status: 0, data: { error: String(e.message || e) } };
      });
  }
  var W = {};
  function gh(method, path, body) {
    return http(
      method,
      "https://api.github.com" + path,
      {
        Authorization: "Bearer " + W.gh.token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "cardon-defi-app",
      },
      body,
    );
  }
  function cf(method, path, body, token) {
    return http(method, "https://api.cloudflare.com/client/v4" + path, { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body);
  }
  function okGh(r, what) {
    if (r.status >= 200 && r.status < 300) return r;
    throw new Error(what + ": " + ((r.data && (r.data.message || r.data.error)) || "HTTP " + r.status));
  }
  function random() {
    var a = new Uint8Array(24);
    crypto.getRandomValues(a);
    return [].map
      .call(a, function (b) {
        return ("0" + b.toString(16)).slice(-2);
      })
      .join("");
  }

  /* ---------- Aviso legal ---------- */
  var AVISO = [
    [
      "Qué es",
      "Cardón DeFi es software libre y gratuito, en versión piloto. Es una herramienta que tú instalas en tu propia cuenta de nube y que opera con tu propia wallet.",
    ],
    [
      "Qué no es",
      "No es un exchange, un bróker, un custodio ni un servicio de inversión o de asesoría financiera, fiscal o legal. El desarrollador no recibe, guarda ni mueve tu dinero, y no tiene acceso a tus claves, saldos ni operaciones.",
    ],
    [
      "Riesgo",
      "Los criptoactivos son muy volátiles: puedes perder todo el dinero que uses. Las decisiones las proponen modelos de inteligencia artificial de terceros, que pueden equivocarse. Las protecciones reducen riesgos, pero no garantizan resultados.",
    ],
    [
      "Sin garantías",
      "El software se entrega «tal cual», sin garantía de ningún tipo. Puede tener errores. Las redes, los DEX, GitHub, Cloudflare y los proveedores de IA pueden fallar, cambiar o bloquear el servicio sin aviso.",
    ],
    [
      "Tu responsabilidad",
      "Tú decides instalarlo, con cuánto dinero y cuándo activar el dinero real. Eres responsable de guardar tu frase de respaldo, de proteger tus claves y de cumplir las leyes e impuestos de tu país.",
    ],
    [
      "Descargo",
      "En la máxima medida que permita la ley, el desarrollador y los colaboradores no responden por pérdidas, daños ni perjuicios derivados del uso o de la imposibilidad de uso del software.",
    ],
  ];
  function avisoHtml() {
    return AVISO.map(function (a) {
      return "<h4>" + a[0] + "</h4><p>" + a[1] + "</p>";
    }).join("");
  }
  function accepted() {
    return parse(get("cardon-aviso")).v === AVISO_VERSION;
  }

  /* ---------- Asistente ---------- */
  var overlay,
    body,
    step = 0;
  var STEPS = ["aviso", "inicio", "wallet", "github", "cloudflare", "ia", "instalar"];
  function open(at) {
    if (!overlay) {
      overlay = h(
        '<div id="setup" class="setup"><div class="setup-top"><b>Cardón <i>DeFi</i></b><span id="setup-count"></span><button id="setup-close" class="icon-btn" hidden>✕</button></div><div class="setup-bar"><i id="setup-progress"></i></div><div id="setup-body" class="setup-body"></div></div>',
      );
      document.body.appendChild(overlay);
      body = $("setup-body");
      $("setup-close").onclick = function () {
        overlay.hidden = true;
      };
    }
    overlay.hidden = false;
    go(at);
  }
  function go(name) {
    step = STEPS.indexOf(name);
    $("setup-count").textContent = step > 0 ? "Paso " + step + " de " + (STEPS.length - 1) : "";
    $("setup-progress").style.width = (step / (STEPS.length - 1)) * 100 + "%";
    $("setup-close").hidden = !accepted() || name === "aviso";
    body.innerHTML = "";
    body.scrollTop = 0;
    SCREENS[name]();
  }
  function screen(html) {
    body.innerHTML = html;
  }
  function nav(back, next, label) {
    var d = h('<div class="setup-nav"><button id="s-back">Atrás</button><button id="s-next" class="primary">' + (label || "Continuar") + "</button></div>");
    body.appendChild(d);
    if (back)
      $("s-back").onclick = function () {
        go(back);
      };
    else $("s-back").hidden = true;
    $("s-next").onclick = next;
    return $("s-next");
  }
  function note(id, text, cls) {
    var n = $(id);
    n.textContent = text;
    n.className = "setup-note " + (cls || "");
  }

  var SCREENS = {
    aviso: function () {
      screen(
        '<span class="eyebrow">ANTES DE EMPEZAR</span><h2>Aviso y descargo de responsabilidad</h2><div class="aviso">' +
          avisoHtml() +
          "</div>" +
          '<label class="check"><input id="av1" type="checkbox"> Leí y acepto este aviso y el descargo de responsabilidad del desarrollador.</label>' +
          '<label class="check"><input id="av2" type="checkbox"> Entiendo que puedo perder dinero y que nadie me garantiza ganancias.</label>',
      );
      var b = nav(
        null,
        function () {
          if (!$("av1").checked || !$("av2").checked) return;
          set("cardon-aviso", JSON.stringify({ v: AVISO_VERSION, ts: new Date().toISOString() }));
          if (get("cardon-api") || !PUB) overlay.hidden = true;
          else go("inicio");
        },
        "Aceptar y continuar",
      );
      b.disabled = true;
      $("av1").onchange = $("av2").onchange = function () {
        b.disabled = !($("av1").checked && $("av2").checked);
      };
    },
    inicio: function () {
      screen(
        '<span class="eyebrow">INSTALAR TU AGENTE</span><h2>Tu agente, en tu propia nube</h2>' +
          "<p>En unos 10 minutos tendrás un agente funcionando 24/7 en una cuenta que es solo tuya. Empieza en <b>simulación</b>, con dinero ficticio.</p>" +
          '<ol class="setup-list"><li><b>Wallet.</b> Se crea aquí, en tu teléfono.</li><li><b>GitHub</b> (gratis). Guarda el código de tu agente y lo instala.</li><li><b>Cloudflare</b> (gratis). Es donde tu agente vive y trabaja.</li><li><b>IA</b> (opcional). Funciona sin cuenta; puedes sumar más después.</li></ol>' +
          '<p class="muted">Tus claves van cifradas a tus propias cuentas. El desarrollador no las recibe.</p>' +
          '<details class="setup-more"><summary>Ya tengo un agente instalado</summary><label>Dirección de tu agente<input id="ex-url" placeholder="https://cardon-defi.TU-SUBDOMINIO.workers.dev" autocapitalize="off" spellcheck="false"></label><label>Token de administrador<input id="ex-token" type="password" autocomplete="off"></label><button id="ex-go" class="wide">Conectar</button><p id="ex-note" class="setup-note"></p></details>',
      );
      nav(
        null,
        function () {
          go("wallet");
        },
        "Empezar",
      );
      $("ex-go").onclick = function () {
        var url = $("ex-url").value.trim().replace(/\/+$/, ""),
          token = $("ex-token").value.trim();
        if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(url) || token.length < 8) return note("ex-note", "Revisa la dirección (https://…) y el token.", "bad");
        note("ex-note", "Probando…");
        session(url, token)
          .then(function () {
            finish(url, token);
          })
          .catch(function (e) {
            note("ex-note", "No pude conectar: " + e.message, "bad");
          });
      };
    },
    wallet: function () {
      var st = NATIVE ? native("status") : { error: "Solo disponible en la app Android" };
      screen(
        '<span class="eyebrow">WALLET</span><h2>Tu wallet</h2><p>Es la cuenta desde la que opera tu agente. La misma dirección sirve en Polygon y en Polkadot Hub. Se guarda cifrada en este teléfono.</p><div id="w-box"></div><p id="w-note" class="setup-note"></p>',
      );
      var next = nav("inicio", function () {
        if (W.wallet) go("github");
      });
      function show(address) {
        W.wallet = address;
        $("w-box").innerHTML = '<div class="setup-ok">Wallet lista</div><code class="address" id="w-addr"></code>';
        $("w-addr").textContent = address;
        next.disabled = false;
      }
      next.disabled = true;
      if (st.configured && st.address) return show(st.address);
      $("w-box").innerHTML =
        '<button id="w-new" class="primary wide">Crear una wallet nueva</button><details class="setup-more"><summary>Ya tengo una (importar)</summary><textarea id="w-secret" class="restore-seed" placeholder="12 o 24 palabras, o clave privada" autocapitalize="off" spellcheck="false"></textarea><button id="w-import" class="wide">Importar</button></details>';
      if (!NATIVE) note("w-note", st.error, "bad");
      $("w-new").onclick = function () {
        var r = native("create");
        if (!r.configured) return note("w-note", "No se pudo crear: " + (r.error || ""), "bad");
        $("w-box").innerHTML =
          '<div class="setup-warn"><b>Anota estas 12 palabras en papel, en orden.</b> Son la única forma de recuperar tu dinero si pierdes el teléfono. No las fotografíes ni las compartas: quien las tenga puede llevarse todo.</div><ol class="seed" id="w-seed"></ol><label class="check"><input id="w-saved" type="checkbox"> Ya las anoté y las guardé en un lugar seguro.</label>';
        String(r.mnemonic || "")
          .split(/\s+/)
          .forEach(function (w) {
            var li = document.createElement("li");
            li.textContent = w;
            $("w-seed").appendChild(li);
          });
        W.wallet = r.address;
        $("w-saved").onchange = function () {
          next.disabled = !$("w-saved").checked;
        };
      };
      $("w-import").onclick = function () {
        var r = native("importSecret", $("w-secret").value);
        $("w-secret").value = "";
        if (!r.configured) return note("w-note", "No se pudo importar: " + (r.error || ""), "bad");
        show(r.address);
      };
    },
    github: function () {
      screen(
        '<span class="eyebrow">GITHUB</span><h2>Conecta GitHub</h2><p>GitHub guardará una copia privada del código de tu agente y lo instalará en tu Cloudflare.</p>' +
          '<ol class="setup-list"><li>Si no tienes cuenta, <a href="https://github.com/signup">créala gratis</a> y confirma tu correo.</li><li>Abre <a href="https://github.com/settings/tokens/new?scopes=repo,workflow&description=Cardon%20DeFi">crear token</a>. Ya vienen marcadas las casillas <b>repo</b> y <b>workflow</b>.</li><li>En «Expiration» elige 90 días o más y toca <b>Generate token</b>.</li><li>Copia el token (empieza con <code>ghp_</code>) y pégalo aquí.</li></ol>' +
          '<label>Token de GitHub<input id="gh-token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="ghp_…"></label><p id="gh-note" class="setup-note"></p>',
      );
      if (W.gh) {
        note("gh-note", "Conectado como " + W.gh.login, "ok");
      }
      var next = nav(
        "wallet",
        function () {
          var token = $("gh-token").value.trim();
          if (!token && W.gh) return go("cloudflare");
          if (token.length < 20) return note("gh-note", "Pega el token completo.", "bad");
          next.disabled = true;
          note("gh-note", "Comprobando…");
          W.gh = { token: token };
          gh("GET", "/user").then(function (r) {
            next.disabled = false;
            if (r.status !== 200 || !r.data.login) {
              W.gh = null;
              return note(
                "gh-note",
                r.status === 401 ? "GitHub no reconoce ese token." : "No pude comprobarlo (" + (r.data.error || "HTTP " + r.status) + ").",
                "bad",
              );
            }
            W.gh.login = r.data.login;
            go("cloudflare");
          });
        },
        "Comprobar y continuar",
      );
    },
    cloudflare: function () {
      screen(
        '<span class="eyebrow">CLOUDFLARE</span><h2>Conecta Cloudflare</h2><p>Aquí vivirá tu agente. El plan gratuito alcanza.</p>' +
          '<ol class="setup-list"><li>Si no tienes cuenta, <a href="https://dash.cloudflare.com/sign-up">créala gratis</a> y confirma tu correo.</li><li>Entra a <a href="https://dash.cloudflare.com/?to=/:account/workers-and-pages">Workers &amp; Pages</a>. A la derecha verás <b>Account ID</b>: cópialo.</li><li>Abre <a href="https://dash.cloudflare.com/profile/api-tokens">API Tokens</a> → <b>Create Token</b> → plantilla <b>Edit Cloudflare Workers</b>.</li><li>En «Permissions» toca <b>Add more</b> y agrega <b>Account · D1 · Edit</b>.</li><li>En «Account Resources» elige tu cuenta y en «Zone Resources», <b>All zones</b>. Toca <b>Continue</b> y <b>Create Token</b>.</li><li>Copia el token y pégalo aquí. Solo se muestra una vez.</li></ol>' +
          '<label>Account ID<input id="cf-account" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="32 letras y números"></label><label>Token de Cloudflare<input id="cf-token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"></label><p id="cf-note" class="setup-note"></p>',
      );
      if (W.cf) {
        $("cf-account").value = W.cf.account;
        note("cf-note", "Cloudflare comprobado", "ok");
      }
      var next = nav(
        "github",
        function () {
          var account = $("cf-account").value.trim().toLowerCase(),
            token = $("cf-token").value.trim();
          if (!token && W.cf && W.cf.account === account) return go("ia");
          if (!/^[0-9a-f]{32}$/.test(account)) return note("cf-note", "El Account ID son 32 letras y números.", "bad");
          if (token.length < 20) return note("cf-note", "Pega el token completo.", "bad");
          next.disabled = true;
          note("cf-note", "Comprobando permisos…");
          Promise.all([
            cf("GET", "/accounts/" + account + "/workers/scripts", null, token),
            cf("GET", "/accounts/" + account + "/d1/database?per_page=10", null, token),
          ]).then(function (r) {
            next.disabled = false;
            if (r[0].status === 0) return note("cf-note", "Sin conexión con Cloudflare: " + (r[0].data.error || ""), "bad");
            if (r[0].status !== 200) return note("cf-note", "Cloudflare rechazó el token o el Account ID (permiso Workers Scripts).", "bad");
            if (r[1].status !== 200) return note("cf-note", "Al token le falta el permiso «Account · D1 · Edit». Edítalo o crea otro.", "bad");
            W.cf = { account: account, token: token };
            set("cardon-cf-account", account);
            go("ia");
          });
        },
        "Comprobar y continuar",
      );
    },
    ia: function () {
      screen(
        '<span class="eyebrow">INTELIGENCIA ARTIFICIAL</span><h2>La IA de tu agente</h2><p>Tu agente ya puede consultar una IA gratuita <b>sin cuenta</b>. Si quieres más velocidad y una segunda opinión, agrega una clave gratuita de Groq. Puedes hacerlo después en Configuración.</p>' +
          '<ol class="setup-list"><li>Abre <a href="https://console.groq.com/keys">console.groq.com/keys</a> e inicia sesión.</li><li>Toca <b>Create API Key</b>, ponle un nombre y cópiala (empieza con <code>gsk_</code>).</li></ol>' +
          '<label>Clave de Groq (opcional)<input id="ia-key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="gsk_…"></label><p id="ia-note" class="setup-note"></p>',
      );
      nav(
        "cloudflare",
        function () {
          var k = $("ia-key").value.trim();
          if (k && !/^gsk_[A-Za-z0-9]{20,}$/.test(k)) return note("ia-note", "Esa no parece una clave de Groq. Déjalo vacío para seguir sin ella.", "bad");
          W.groq = k;
          go("instalar");
        },
        "Continuar",
      );
    },
    instalar: function () {
      if (!W.wallet || !W.gh || !W.cf) return go(!W.wallet ? "wallet" : !W.gh ? "github" : "cloudflare");
      screen(
        '<span class="eyebrow">ÚLTIMO PASO</span><h2>Instalar tu agente</h2><dl class="setup-summary"><dt>Wallet</dt><dd id="r-wallet"></dd><dt>GitHub</dt><dd id="r-gh"></dd><dt>Cloudflare</dt><dd id="r-cf"></dd><dt>IA</dt><dd id="r-ia"></dd><dt>Modo</dt><dd>Simulación</dd></dl>' +
          '<p class="muted">Se creará el repositorio privado <b>' +
          REPO +
          "</b> en tu GitHub y el agente <b>" +
          WORKER +
          '</b> en tu Cloudflare. Tarda de 2 a 4 minutos; no cierres la app.</p><div class="setup-bar big"><i id="i-bar"></i></div><div id="i-log" class="setup-log"></div>',
      );
      $("r-wallet").textContent = W.wallet.slice(0, 8) + "…" + W.wallet.slice(-6);
      $("r-gh").textContent = W.gh.login;
      $("r-cf").textContent = W.cf.account.slice(0, 6) + "…";
      $("r-ia").textContent = W.groq ? "Gratuita + Groq" : "Gratuita, sin cuenta";
      var next = nav(
        "ia",
        function () {
          next.disabled = true;
          $("s-back").disabled = true;
          install().catch(function (e) {
            line("No se completó: " + (e.message || e), "bad");
            next.disabled = false;
            $("s-back").disabled = false;
            next.textContent = "Reintentar";
          });
        },
        "Instalar mi agente",
      );
    },
  };
  function line(text, cls) {
    var d = document.createElement("div");
    d.textContent = text;
    if (cls) d.className = cls;
    $("i-log").appendChild(d);
    d.scrollIntoView({ block: "end" });
    return d;
  }
  function bar(p) {
    $("i-bar").style.width = Math.max(2, Math.min(100, p)) + "%";
  }

  function install() {
    var owner = W.gh.login,
      repo = REPO,
      branch = "main",
      admin = random(),
      t0;
    $("i-log").innerHTML = "";
    bar(2);
    var l = line("Preparando tu repositorio privado…");
    return gh("GET", "/repos/" + owner + "/" + repo)
      .then(function (r) {
        if (r.status === 200) {
          branch = r.data.default_branch || "main";
          l.textContent = "El repositorio " + owner + "/" + repo + " ya existe: lo reutilizo";
          l.className = "ok";
          return;
        }
        return gh("POST", "/repos/" + (C.plantilla || "tradiabot/cardon-defi") + "/generate", {
          owner: owner,
          name: repo,
          private: true,
          description: "Mi agente Cardón DeFi",
        }).then(function (r) {
          okGh(r, "Crear el repositorio");
          branch = r.data.default_branch || "main";
          l.textContent = "Repositorio privado " + owner + "/" + repo + " creado";
          l.className = "ok";
          bar(10);
          var w = line("Esperando a que GitHub copie los archivos…"),
            n = 0;
          function ready() {
            return gh("GET", "/repos/" + owner + "/" + repo + "/contents/.github/workflows/instalar.yml?ref=" + branch).then(function (r) {
              if (r.status === 200) {
                w.textContent = "Archivos listos";
                w.className = "ok";
                return;
              }
              if (r.status === 401 || r.status === 403) okGh(r, "Leer el repositorio nuevo");
              if (n++ > 40) throw new Error("GitHub no terminó de copiar la plantilla en 2 minutos");
              w.textContent = "Esperando a que GitHub copie los archivos… (" + n * 3 + " s)";
              return wait(3000).then(ready);
            });
          }
          return ready();
        });
      })
      .then(function () {
        bar(18);
        var s = line("Cifrando y guardando tus claves en tu GitHub…");
        var secrets = { CLOUDFLARE_API_TOKEN: W.cf.token, CLOUDFLARE_ACCOUNT_ID: W.cf.account, ADMIN_TOKEN: admin, WALLET_ADDRESS: W.wallet };
        if (W.groq) secrets.GROQ_API_KEY = W.groq;
        return gh("GET", "/repos/" + owner + "/" + repo + "/actions/secrets/public-key")
          .then(function (r) {
            okGh(r, "Clave pública de GitHub");
            var names = Object.keys(secrets),
              i = 0;
            function put() {
              if (i >= names.length) return;
              var n = names[i++];
              return gh("PUT", "/repos/" + owner + "/" + repo + "/actions/secrets/" + n, {
                encrypted_value: window.agenteSellar(r.data.key, String(secrets[n])),
                key_id: r.data.key_id,
              }).then(function (x) {
                okGh(x, "Guardar " + n);
                bar(18 + (12 * i) / names.length);
                return put();
              });
            }
            return put();
          })
          .then(function () {
            s.textContent = "Claves guardadas cifradas";
            s.className = "ok";
          });
      })
      .then(function () {
        var s = line("Lanzando la instalación en tu Cloudflare…"),
          tries = 0;
        t0 = Date.now();
        function dispatch() {
          return gh("POST", "/repos/" + owner + "/" + repo + "/actions/workflows/instalar.yml/dispatches", { ref: branch }).then(function (r) {
            if (r.status === 204) return;
            if ((r.status === 404 || r.status === 422) && tries++ < 12) return wait(5000).then(dispatch);
            okGh(r, "Lanzar la instalación");
          });
        }
        function watch() {
          return gh("GET", "/repos/" + owner + "/" + repo + "/actions/workflows/instalar.yml/runs?per_page=3").then(function (r) {
            okGh(r, "Estado de la instalación");
            var run = (r.data.workflow_runs || []).filter(function (x) {
                return Date.parse(x.created_at) >= t0 - 60000;
              })[0],
              sec = Math.round((Date.now() - t0) / 1000);
            if (run && run.status === "completed") {
              if (run.conclusion === "success") return;
              throw new Error("la instalación falló en GitHub Actions. Detalle: " + run.html_url);
            }
            if (Date.now() - t0 > 12 * 60000) throw new Error("la instalación tarda demasiado; revisa la pestaña Actions de tu repositorio");
            s.textContent =
              "Instalando en tu Cloudflare… " + (run ? (run.status === "queued" ? "en cola" : "en curso") : "esperando a GitHub") + " (" + sec + " s)";
            bar(33 + Math.min(48, sec / 4));
            return wait(6000).then(watch);
          });
        }
        return dispatch()
          .then(function () {
            bar(33);
            return watch();
          })
          .then(function () {
            s.textContent = "Agente desplegado en tu Cloudflare";
            s.className = "ok";
            bar(84);
          });
      })
      .then(function () {
        var s = line("Leyendo la dirección de tu agente…");
        return gh("GET", "/repos/" + owner + "/" + repo + "/contents/cardon.json?ref=" + branch).then(function (r) {
          okGh(r, "cardon.json");
          var info = parse(atob(String(r.data.content).replace(/\s/g, "")));
          if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(info.url || "")) throw new Error("dirección del agente inválida");
          s.textContent = "Tu agente: " + info.url;
          s.className = "ok";
          bar(90);
          return info.url;
        });
      })
      .then(function (url) {
        var s = line("Probando la conexión…");
        return session(url, admin).then(function () {
          s.textContent = "Conexión segura comprobada";
          s.className = "ok";
          bar(100);
          line("¡Listo! Tu agente ya trabaja en simulación.", "ok");
          W.cf.token = "";
          W.gh.token = "";
          return wait(1200).then(function () {
            finish(url, admin);
          });
        });
      });
  }
  function session(url, token) {
    return fetch(url + "/api/v1/auth/session", { headers: { authorization: "Bearer " + token } })
      .then(function (r) {
        if (!r.ok) throw new Error("el agente respondió " + r.status);
        return r.json();
      })
      .then(function (d) {
        if (!d || d.valid !== true) throw new Error("el agente no aceptó el token");
      });
  }
  function finish(url, token) {
    set("cardon-api", url + "/api/v1");
    set("dexpilot-token", token);
    if (NATIVE && NATIVE.setCloud) NATIVE.setCloud(url);
    location.reload();
  }
  window.cardonSetup = function () {
    open(accepted() ? "inicio" : "aviso");
  };
  window.cardonAviso = function () {
    open("aviso");
  };

  /* ---------- Dinero real: clave de firma ---------- */
  window.onSigningKeyUpload = function (text) {
    var r = parse(text),
      n = $("key-note");
    if (!n) return;
    if (r.status === "UPLOADED") {
      n.textContent = "Clave guardada en tu Cloudflare. Ya puedes pasar cada mercado a dinero real en «Mercados».";
      n.className = "setup-note ok";
      $("key-token").value = "";
      if (typeof loadMarkets === "function") setTimeout(loadMarkets, 4000);
    } else {
      n.textContent =
        r.status === "REJECTED"
          ? "Cloudflare rechazó la clave (HTTP " + r.http + "). Revisa el Account ID y el token."
          : "No se subió: " + (r.error || "cancelado");
      n.className = "setup-note bad";
    }
  };
  window.cardonUploadKey = function () {
    var account = $("key-account").value.trim().toLowerCase(),
      token = $("key-token").value.trim();
    if (!NATIVE || !NATIVE.uploadSigningKey) return say("Solo disponible en la app Android");
    if (!/^[0-9a-f]{32}$/.test(account) || token.length < 20) return say("Escribe tu Account ID y tu token de Cloudflare");
    if (
      !confirm(
        "Vas a guardar la clave de firma de tu wallet en tu cuenta de Cloudflare para que tu agente opere con dinero real. Hazlo solo si ya probaste la simulación. ¿Continuar?",
      )
    )
      return;
    set("cardon-cf-account", account);
    var r = native("uploadSigningKey", account, token, WORKER);
    if (r.error) {
      $("key-note").textContent = "No se pudo iniciar: " + r.error;
      $("key-note").className = "setup-note bad";
    }
  };

  /* ---------- Actualizaciones: último lanzamiento en GitHub ---------- */
  var RELEASES = "https://api.github.com/repos/" + (C.plantilla || "tradiabot/cardon-defi") + "/releases/latest",
    FDROID_PAGE = "https://f-droid.org/packages/com.cardondefi.app/",
    UPD_EVERY = 12 * 3600 * 1000;
  function appInfo() {
    var r = NATIVE && NATIVE.appInfo ? native("appInfo") : {};
    return { version: r.version || C.version || "", installer: r.installer || "" };
  }
  function fromFdroid(installer) {
    return /fdroid|droidify|neostore|izzy/i.test(installer || "");
  }
  function versionParts(v) {
    return (String(v || "").replace(/^v/i, "").match(/\d+/g) || []).slice(0, 3).map(Number);
  }
  function isNewer(remote, local) {
    var a = versionParts(remote),
      b = versionParts(local);
    if (!a.length) return false;
    for (var i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    return false;
  }
  function autoUpdates() {
    var v = get("cardon-upd-auto");
    return v ? v === "1" : !fromFdroid(appInfo().installer);
  }
  function updNote(text, cls) {
    var n = $("upd-note");
    if (n) {
      n.textContent = text;
      n.className = "setup-note" + (cls ? " " + cls : "");
    }
  }
  /** manual: el usuario pulsó «Buscar ahora»; muestra el resultado aunque no haya novedad y aunque haya omitido esa versión. */
  function checkUpdates(manual) {
    var info = appInfo();
    set("cardon-upd-last", String(Date.now()));
    if (manual) updNote("Buscando…");
    return http("GET", RELEASES, { Accept: "application/vnd.github+json", "User-Agent": "cardon-defi-app" }).then(function (r) {
      var rel = r.data || {};
      if (r.status !== 200 || !rel.tag_name) {
        if (manual) updNote("No se pudo consultar GitHub" + (r.status ? " (HTTP " + r.status + ")" : "") + ". Revisa tu conexión.", "bad");
        return null;
      }
      if (!isNewer(rel.tag_name, info.version)) {
        if (manual) updNote("Tienes la última versión (" + info.version + ").", "ok");
        return null;
      }
      if (manual) updNote("Hay una versión nueva: " + rel.tag_name.replace(/^v/i, "") + ".", "ok");
      if (!manual && (get("cardon-upd-skip") === rel.tag_name || Number(get("cardon-upd-later")) > Date.now())) return null;
      showUpdate(rel, info);
      return rel;
    });
  }
  function showUpdate(rel, info) {
    var old = $("upd");
    if (old) old.remove();
    var tag = String(rel.tag_name),
      fd = fromFdroid(info.installer),
      apk = (rel.assets || []).filter(function (a) {
        return /\.apk$/i.test(a.name || "") && /^https:\/\/github\.com\//.test(a.browser_download_url || "");
      })[0],
      page = /^https:\/\/github\.com\//.test(rel.html_url || "") ? rel.html_url : "https://github.com/" + (C.plantilla || "tradiabot/cardon-defi") + "/releases/latest";
    var box = h(
      '<div id="upd" class="upd" role="dialog" aria-modal="true" aria-labelledby="upd-title"><div class="upd-card"><div class="upd-head"><span class="pill">NUEVA VERSIÓN</span><button id="upd-x" class="icon-btn" aria-label="Cerrar">✕</button></div><h2 id="upd-title">Cardón DeFi <span id="upd-v"></span></h2><p class="muted">Tienes la <b id="upd-cur"></b>.</p><div id="upd-notes" class="upd-notes"></div><p id="upd-how" class="muted"></p><a id="upd-get" class="upd-btn primary"></a><div class="upd-row"><button id="upd-later">Más tarde</button><button id="upd-skip">Omitir esta versión</button></div></div></div>',
    );
    document.body.appendChild(box);
    $("upd-v").textContent = tag.replace(/^v/i, "");
    $("upd-cur").textContent = info.version || "versión actual";
    var notes = String(rel.body || "")
      .replace(/\r/g, "")
      .replace(/^#+\s*/gm, "")
      .replace(/\*\*|`/g, "")
      .trim();
    $("upd-notes").textContent = notes.length > 700 ? notes.slice(0, 700) + "…" : notes || "Sin notas.";
    $("upd-notes").hidden = !notes;
    if (fd) {
      $("upd-how").textContent = "Instalaste la app desde F-Droid: actualízala desde allí. Puede tardar unos días en aparecer, porque F-Droid compila y firma cada versión.";
      $("upd-get").textContent = "Abrir en F-Droid";
      $("upd-get").href = FDROID_PAGE;
    } else {
      $("upd-how").textContent = "Se descarga en tu navegador; ábrela e instálala encima de la actual. Tus datos y tu agente se conservan.";
      $("upd-get").textContent = apk ? "Descargar la APK" : "Ver el lanzamiento";
      $("upd-get").href = apk ? apk.browser_download_url : page;
    }
    function close() {
      box.remove();
    }
    $("upd-x").onclick = close;
    $("upd-get").addEventListener("click", function () {
      setTimeout(close, 300);
    });
    $("upd-later").onclick = function () {
      set("cardon-upd-later", String(Date.now() + 24 * 3600 * 1000));
      close();
    };
    $("upd-skip").onclick = function () {
      set("cardon-upd-skip", tag);
      close();
    };
  }
  window.cardonCheckUpdates = function () {
    return checkUpdates(true);
  };
  window.cardonAutoUpdates = function (on) {
    set("cardon-upd-auto", on ? "1" : "0");
  };
  function autoCheck() {
    if (!PUB || !autoUpdates() || !accepted()) return;
    if (Date.now() - Number(get("cardon-upd-last") || 0) < UPD_EVERY) return;
    checkUpdates(false);
  }

  /* ---------- Paneles en Configuración ---------- */
  function mount() {
    var config = $("config");
    if (!config) return;
    var danger = config.querySelector(".danger-zone");
    var themes = h(
      '<div class="panel"><div class="panel-title">Colores de la app</div><div class="theme-grid">' +
        THEMES.map(function (t) {
          return (
            '<button class="theme-opt" data-theme="' +
            t.id +
            '" onclick="cardonTheme(\'' +
            t.id +
            '\')"><span class="theme-sw">' +
            t.sw
              .map(function (c) {
                return '<i style="background:' + c + '"></i>';
              })
              .join("") +
            "</span><b>" +
            t.name +
            "</b><small>" +
            t.hint +
            "</small></button>"
          );
        }).join("") +
        "</div></div>",
    );
    config.insertBefore(themes, config.querySelector(".panel"));
    applyTheme(get("cardon-theme") || "noche");
    if (!PUB) return;
    var real = h(
      '<div class="panel config-form"><div class="panel-title">Dinero real: clave de firma <span class="pill warn">OPCIONAL</span></div><p class="muted">Tu agente empieza en simulación. Para operar con dinero real necesita la clave de firma de tu wallet. Se envía de este teléfono a <b>tu</b> Cloudflare, protegida con tu huella; no pasa por GitHub ni por el desarrollador.</p><label>Account ID de Cloudflare<input id="key-account" autocomplete="off" autocapitalize="off" spellcheck="false"></label><label>Token de Cloudflare<input id="key-token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"></label><button class="wide" onclick="cardonUploadKey()">Guardar la clave en mi nube</button><p id="key-note" class="setup-note"></p></div>',
    );
    var cloud = h(
      '<div class="panel config-form"><div class="panel-title">Mi agente <span id="agent-state" class="pill warn">SIN INSTALAR</span></div><p id="agent-url" class="muted">Aún no has instalado tu agente.</p><button class="primary wide" onclick="cardonSetup()">Instalar o conectar mi agente</button><button class="wide" style="margin-top:8px" onclick="cardonAviso()">Ver el aviso legal</button></div>',
    );
    var donate = h(
      '<div class="panel" id="donar"><div class="panel-title"><span>Apoya al desarrollador</span><span class="pill">VOLUNTARIO</span></div><p class="muted">Cardón DeFi es gratis y abierto. Si te sirve, puedes invitarle un café al desarrollador. Envía cada moneda <b>solo por su propia red</b>.</p><div class="don">' +
        don(
          "usdc",
          "USDC · red Arbitrum",
          "0xAC43f9b0E7F0ae6386cfC8ef6BFf62CE9c3006A1",
          "Solo USDC en Arbitrum, mínimo 5 USDC. No envíes por Polygon, Ethereum ni otra red.",
        ) +
        don("bitcoin", "Bitcoin (BTC)", "bc1qd9j45f4t0jwyhjhqh2kvz2cr7k8xye460rr2y7", "") +
        don("monero", "Monero (XMR)", "447gTj6Hg6gaAEAUmjqfhqDZr1PziUTvbT4LYLpmLVnTNVFK6cqeqPfh6P4neMKLWX5jDXAr94fWHacJwDvjmCzBBH8wPBt", "") +
        '</div><p class="muted" style="margin:10px 0 0">¡Gracias! 🙏</p><p class="muted firma" id="firma">Hecho xhumanx + IA</p></div>',
    );
    var upd = h(
      '<div class="panel config-form"><div class="panel-title">Actualizaciones</div><p class="muted">Versión instalada: <b id="upd-installed"></b>. La app consulta los lanzamientos públicos de GitHub y te avisa cuando hay una nueva; no descarga ni instala nada sin que lo pidas.</p><label class="check"><input id="upd-auto" type="checkbox" onchange="cardonAutoUpdates(this.checked)"> Buscar actualizaciones al abrir la app</label><button class="wide" onclick="cardonCheckUpdates()">Buscar actualizaciones ahora</button><p id="upd-note" class="setup-note"></p></div>',
    );
    config.insertBefore(cloud, config.querySelector(".panel"));
    config.insertBefore(upd, cloud.nextSibling);
    $("upd-installed").textContent = appInfo().version || "—";
    $("upd-auto").checked = autoUpdates();
    config.insertBefore(real, danger);
    config.insertBefore(donate, danger);
    $("key-account").value = get("cardon-cf-account");
    var api = get("cardon-api");
    if (api) {
      $("agent-state").textContent = "INSTALADO";
      $("agent-state").className = "pill";
      $("agent-url").textContent = api.replace(/\/api\/v1$/, "");
    }
  }
  function don(icon, title, address, hint) {
    return (
      '<div class="don-card"><div class="don-head"><img src="donar/' +
      icon +
      '.svg" alt=""><b>' +
      title +
      '</b></div><img class="qr" src="donar/qr-' +
      icon +
      '.svg" alt="Código QR de ' +
      title +
      '"><code class="address">' +
      address +
      "</code>" +
      (hint ? '<p class="muted">' + hint + "</p>" : "") +
      '<button class="wide" onclick="copyText(\'' +
      address +
      "','Dirección')\">Copiar dirección</button></div>"
    );
  }
  function start() {
    mount();
    if (NATIVE && NATIVE.setCloud && (get("cardon-api") || C.api)) NATIVE.setCloud(get("cardon-api") || C.api);
    if (!PUB) return;
    if (!accepted()) open("aviso");
    else if (!get("cardon-api")) open("inicio");
    setTimeout(autoCheck, 3000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
