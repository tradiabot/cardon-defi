<p align="center"><img src="brand/logo-lockup.svg" alt="Cardón DeFi" width="420"></p>

**Agente de Trading Descentralizado · Decentralized Trading Agent** — versión piloto

El cardón es el gran cactus del desierto: resistente, valioso y fuerte ante las inclemencias. Cardón DeFi es un agente que opera en exchanges descentralizados con **tu propia wallet y desde tu propia nube**. Nadie más custodia tu dinero ni tus claves, y no existe un servidor central.

- Sitio: https://tradiabot.github.io/cardon/
- Descarga de la app (Android): [última versión](https://github.com/tradiabot/cardon-defi/releases/latest)
- [Aviso legal y descargo de responsabilidad](AVISO-LEGAL.md) · [English](#english)

> **No es asesoría financiera ni garantiza ganancias.** Puedes perder dinero. Todo empieza en simulación.

## Qué hace

- Opera pares contra USDC en **Polygon** (Uniswap V3, directo al contrato) y en **Polkadot Hub** (pool nativo DOT/USDC), con la misma dirección `0x`.
- Varias IAs votan cada decisión. Las reglas duras (ganancia mínima, topes diarios, reservas, coste máximo) viven en el código del agente, no en la IA.
- Corre 24/7 en el plan gratuito de Cloudflare Workers. La app Android lo instala y lo controla.
- Cada mercado empieza en simulación; tú decides cuándo pasar a dinero real.

## Instalar (desde la app)

Instala la APK y sigue el asistente. Te pedirá, paso a paso y con enlaces:

| Paso | Qué necesitas | Para qué |
|---|---|---|
| 1. Wallet | Nada: se crea en el teléfono (anota las 12 palabras) | Es la cuenta de tu agente |
| 2. GitHub | Cuenta gratuita y un token con permisos **repo** y **workflow** | Guarda una copia privada del código y lo instala |
| 3. Cloudflare | Cuenta gratuita, tu **Account ID** y un token **Edit Cloudflare Workers** con el permiso extra **Account · D1 · Edit** | Es donde vive tu agente |
| 4. IA | Opcional: clave gratuita de Groq | Funciona sin cuenta; con Groq hay una segunda opinión |

Al terminar, la app crea el repositorio privado `cardon-nube` en tu GitHub (copia de esta plantilla), guarda tus claves **cifradas** como secretos de ese repositorio y lanza [`instalar.yml`](.github/workflows/instalar.yml), que despliega el agente `cardon-defi` en tu Cloudflare.

### Dónde quedan tus claves

| Clave | Dónde vive | Quién más la ve |
|---|---|---|
| Frase de respaldo y clave de la wallet | Tu teléfono, cifrada con Android Keystore | Nadie |
| Tokens de GitHub y Cloudflare | Secretos de tu repositorio privado; la app no los conserva | Nadie |
| Clave de firma (solo si activas dinero real) | Secreto de tu Worker en tu Cloudflare; va directo del teléfono, tras tu huella, sin pasar por GitHub | Nadie |

## Instalar a mano (sin la app)

```bash
cd bot
npm ci
cp wrangler.plantilla.toml wrangler.toml     # sustituye __ACCOUNT_ID__, __WALLET_ADDRESS__ y __PANEL_URL__
npx wrangler d1 create cardon_defi           # copia el id a __D1_ID__
npx wrangler d1 migrations apply cardon_defi --remote
npx wrangler deploy
npx wrangler secret put ADMIN_TOKEN          # una contraseña larga inventada por ti
npx wrangler secret put GROQ_API_KEY         # opcional
```

Si la primera subida falla por el enlace `SELF`, quita el bloque `[[services]]`, despliega, vuelve a ponerlo y despliega otra vez. Los secretos nunca van en archivos del repositorio.

## Estructura

| Carpeta | Contenido |
|---|---|
| `bot/` | El agente: Worker de Cloudflare (TypeScript, D1, Durable Object como reloj) |
| `app/web/` | Interfaz de la app (HTML y JavaScript sin dependencias) |
| `app/android/` | Contenedor Android: WebView, wallet local y puentes nativos |
| `.github/workflows/instalar.yml` | El instalador que corre en el GitHub de cada persona |
| `brand/` | Logos, iconos y el script que los genera |

## Desarrollo

```bash
cd bot && npm ci && npm test                       # pruebas del agente
cd app/android && ./gradlew assemblePublicaRelease # compilar la app (ver app/android/BUILDING.md)
```

Tras cambiar `app/web/`, cópialo a `app/android/app/src/main/assets/web/` antes de compilar.

## F-Droid

El proyecto está preparado para F-Droid: licencia MIT, sin dependencias privativas, compilación estándar con Gradle, fichas en `fastlane/metadata/android/` y la receta en [`fdroid/com.cardondefi.app.yml`](fdroid/com.cardondefi.app.yml). Aún no está incluido: falta enviar esa receta a [fdroiddata](https://gitlab.com/fdroid/fdroiddata) y pasar su revisión. F-Droid compila y firma con su propia llave, así que su APK y la de GitHub no se actualizan entre sí.

## Estado del piloto

- Probado con dinero real por su autor en Polygon y Polkadot Hub, con montos pequeños.
- El instalador automático es nuevo: si falla, el detalle queda en la pestaña **Actions** de tu repositorio `cardon-nube`. Abre un *issue* con ese error (sin pegar claves).
- Los límites empiezan en 2 USDC por orden y 8 operaciones al día; se cambian en la app (Configuración → Reglas duras).
- Hydration está solo en simulación.

## Apoyar

Cardón DeFi es gratis. Si te sirve, en la app (Configuración → Apoya al desarrollador) están las direcciones para donar.

---

## English

Cardón DeFi is a decentralized trading agent, in pilot stage, that trades on DEXs with **your own wallet from your own cloud**. There is no central server and nobody else holds your funds or keys.

Install the Android APK from the [latest release](https://github.com/tradiabot/cardon-defi/releases/latest) and follow the wizard (the app is in Spanish for now). You need a free GitHub account with a token (`repo` + `workflow` scopes), a free Cloudflare account with your Account ID and an *Edit Cloudflare Workers* token plus *Account · D1 · Edit*, and optionally a free Groq key. The app creates a private copy of this template in your GitHub and deploys the agent to your Cloudflare. Everything starts in simulation.

Not financial advice. No profit is guaranteed. See the [disclaimer](AVISO-LEGAL.md#disclaimer-english). MIT licensed.
