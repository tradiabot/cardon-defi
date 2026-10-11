# Android build profile

Este shell usa Gradle 8.11.1, Android Gradle Plugin 8.7.2, compile/target SDK 34, Java 21 y assets web locales dentro de `app/src/main/assets/web/`. SDK 34 se usa por compatibilidad con el `aapt2` ARM64 disponible en este entorno. La Activity es un WebView local equivalente al shell de una app Capacitor.

El backend no se empaqueta en el APK. Para conectar la app a un backend se puede cambiar `window.DEFI_API_BASE` antes de empaquetar o inyectarlo desde el host; el frontend conserva el fallback mock offline.

La Activity incluye el puente local `AndroidWallet` para crear/importar cuentas EVM y cifrar sus secretos con Android Keystore. Ese puente no transmite claves al backend. La versión `0.5.0` muestra explícitamente si la interfaz está ejecutándose dentro del APK o en navegador.
