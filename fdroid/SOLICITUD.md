# Solicitud de inclusión en F-Droid

Título del merge request en https://gitlab.com/fdroid/fdroiddata:

    New app: Cardón DeFi (com.cardondefi.app)

Descripción (se pega tal cual, en inglés):

```
Cardón DeFi is a decentralized trading agent. The app installs the user's own
agent in the user's own GitHub and Cloudflare accounts (from the public template
https://github.com/tradiabot/cardon-defi) and then controls it: markets, paper/live
mode, limits, orders and logs. There is no central server run by the developer.

* Source: https://github.com/tradiabot/cardon-defi (MIT)
* Built from `app/android/app`, flavor `publica`, tag `v1.0.4-piloto`
* Only dependency: org.web3j:crypto (Apache-2.0). No Google services, no trackers, no ads.
* Anti-feature NonFreeNet: the agent runs on GitHub Actions and Cloudflare Workers
  accounts owned by the user; AI providers are optional.
* Optional update notice: checks the public GitHub releases API (no account, no token). It can be turned off
  in Config, is off by default for F-Droid installs and then points to the F-Droid page. It never downloads or installs anything.
* Fastlane metadata (en-US, es-ES) is in the source repository.
* `fdroid lint` passes; `fdroid scanner` reports no problems.

* [x] The app complies with the inclusion criteria
* [x] The original app author has been notified (I am the author)
* [x] All related fdroiddata and RFP issues have been referenced in this merge request
* [x] Builds with `fdroid build` (CI pipeline 2960780928: all 9 jobs passed)
```
