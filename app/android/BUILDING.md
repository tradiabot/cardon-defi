# Compilar la app

Requisitos: JDK 17 o superior y el SDK de Android (plataforma 34, build-tools 34.0.0). El contenedor es una Activity con un WebView que carga la interfaz desde `app/src/main/assets/web/`.

```bash
./gradlew assemblePublicaRelease              # APK sin firmar (la que compila F-Droid)
./gradlew assemblePublicaRelease -PfirmaLocal # firmada con la llave de depuración de tu equipo
```

Tras cambiar `app/web/`, cópialo a `app/android/app/src/main/assets/web/`.

La edición `personal` es para una compilación propia que ya apunte a tu agente: crea `app/src/personal/assets/web/config.js` (no se versiona) con `window.CARDON = { publica: false, api: 'https://TU-AGENTE.workers.dev/api/v1' }`.
