package com.defipoldot.trading;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebSettings;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.widget.TextView;
import android.graphics.Color;
import android.view.ViewGroup;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;
import org.json.JSONArray;
import org.web3j.crypto.Credentials;
import org.web3j.crypto.ECKeyPair;
import org.web3j.crypto.Bip32ECKeyPair;
import org.web3j.crypto.MnemonicUtils;
import org.web3j.crypto.RawTransaction;
import org.web3j.crypto.TransactionEncoder;
import org.web3j.utils.Numeric;

import java.math.BigInteger;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.concurrent.Executor;
import java.security.SecureRandom;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public class MainActivity extends Activity {
    private static final String KEY_ALIAS = "defi_pol_dot_wallet_v1";
    private static final String AUTH_KEY_ALIAS = "defi_pol_dot_trading_auth_v1";
    private static final String PREFS = "secure_wallet";
    private static final String BLOB = "encrypted_wallet";
    private static final String POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";
    private static final String POLKADOT_HUB_RPC = "https://eth-rpc.polkadot.io";
    private static final String POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
    private static final String POLYGON_WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
    private static final String QUICKSWAP_V2_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
    private static final String POLYGON_USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
    private static final String HUB_USDC = "0x0000053900000000000000000000000001200000";
    private static final String HUB_USDT = "0x000007C000000000000000000000000001200000";
    private static final BigInteger MIN_POL_GAS_RESERVE_WEI = new BigInteger("200000000000000000");
    // Bloqueo de la app: obligatorio con dinero real activo, opcional si no. Pide huella o el PIN/patrón del teléfono.
    private static final String LOCK_PREFS = "app_lock";
    private static final long LOCK_AFTER_MS = 60_000;
    private static final int UNLOCK_REQUEST = 4310;
    private android.view.View lockView;
    private boolean locked, pendingPrompt, prompting;
    private long hiddenAt;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestNotificationPermission();
        startNativeSupervisor();
        WebView web = new WebView(this);
        web.setBackgroundColor(Color.rgb(10, 15, 13));
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
        web.clearCache(true);
        web.getSettings().setAllowFileAccess(true);
        WalletBridge bridge = new WalletBridge(this);
        bridge.setWebView(web);
        web.addJavascriptInterface(bridge, "AndroidWallet");
        web.setWebViewClient(new WebViewClient() {
            // Enlaces de noticias (https) se abren en el navegador: la app nunca navega fuera de su pantalla.
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openExternal(request.getUrl().toString());
            }
            @SuppressWarnings("deprecation")
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openExternal(url);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError();
            }
        });
        // Sin WebChromeClient, confirm() y prompt() de la interfaz devuelven «cancelar» sin mostrar nada:
        // los botones que piden confirmación (pasar a dinero real, apagar, editar una orden…) parecían muertos.
        web.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override public boolean onJsAlert(WebView view, String url, String message, android.webkit.JsResult result) {
                return dialog(message, null, result, null, false);
            }
            @Override public boolean onJsConfirm(WebView view, String url, String message, android.webkit.JsResult result) {
                return dialog(message, null, result, null, true);
            }
            @Override public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, android.webkit.JsPromptResult result) {
                return dialog(message, defaultValue == null ? "" : defaultValue, result, result, true);
            }
        });
        android.widget.FrameLayout root = new android.widget.FrameLayout(this);
        root.addView(web, new ViewGroup.LayoutParams(-1, -1));
        lockView = buildLockView();
        root.addView(lockView, new ViewGroup.LayoutParams(-1, -1));
        setContentView(root, new ViewGroup.LayoutParams(-1, -1));
        applySecure();
        if (lockRequired() && deviceSecure()) lock(); else lockView.setVisibility(android.view.View.GONE);
        web.loadUrl("file:///android_asset/web/index.html");
    }

    @Override protected void onStart() {
        super.onStart();
        if (hiddenAt > 0 && android.os.SystemClock.elapsedRealtime() - hiddenAt > LOCK_AFTER_MS && lockRequired() && deviceSecure()) lock();
        hiddenAt = 0;
    }

    @Override protected void onResume() {
        super.onResume();
        if (locked && pendingPrompt && !prompting) { pendingPrompt = false; getWindow().getDecorView().post(this::promptUnlock); }
    }

    @Override protected void onStop() {
        super.onStop();
        // La pantalla de PIN del sistema también detiene la app: eso no cuenta como salir.
        if (!prompting) hiddenAt = android.os.SystemClock.elapsedRealtime();
    }

    @Override public void onBackPressed() {
        if (locked) moveTaskToBack(true); else super.onBackPressed();
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != UNLOCK_REQUEST) return;
        prompting = false;
        if (resultCode == RESULT_OK) unlock();
    }

    SharedPreferences lockPrefs() { return getSharedPreferences(LOCK_PREFS, MODE_PRIVATE); }
    boolean lockRequired() { SharedPreferences p = lockPrefs(); return p.getBoolean("live", false) || p.getBoolean("manual", false); }
    boolean deviceSecure() {
        android.app.KeyguardManager km = (android.app.KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        return km != null && km.isDeviceSecure();
    }
    boolean isLocked() { return locked; }

    /** Sin capturas ni vista previa en «recientes» mientras el bloqueo esté activo. */
    void applySecure() {
        if (lockRequired()) getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
        else getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
    }

    private android.view.View buildLockView() {
        android.widget.LinearLayout box = new android.widget.LinearLayout(this);
        box.setOrientation(android.widget.LinearLayout.VERTICAL);
        box.setGravity(android.view.Gravity.CENTER);
        box.setBackgroundColor(Color.rgb(10, 15, 13));
        int pad = (int) (32 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad, pad, pad);
        box.setClickable(true);
        TextView title = new TextView(this);
        title.setText("🔒 " + getApplicationInfo().loadLabel(getPackageManager()) + " está bloqueada");
        title.setTextColor(Color.rgb(232, 240, 236));
        title.setTextSize(20);
        title.setGravity(android.view.Gravity.CENTER);
        TextView text = new TextView(this);
        text.setText("Desbloquéala con tu huella o con el PIN, patrón o contraseña del teléfono.");
        text.setTextColor(Color.rgb(150, 166, 158));
        text.setTextSize(15);
        text.setGravity(android.view.Gravity.CENTER);
        text.setPadding(0, pad / 2, 0, pad);
        android.widget.Button button = new android.widget.Button(this);
        button.setText("Desbloquear");
        button.setOnClickListener(v -> promptUnlock());
        box.addView(title);
        box.addView(text);
        box.addView(button);
        return box;
    }

    private void lock() {
        locked = true;
        pendingPrompt = true;
        lockView.setVisibility(android.view.View.VISIBLE);
        if (hasWindowFocus() && !prompting) { pendingPrompt = false; promptUnlock(); }
    }

    private void unlock() {
        locked = false;
        pendingPrompt = false;
        lockView.setVisibility(android.view.View.GONE);
    }

    private void promptUnlock() {
        if (prompting) return;
        if (!deviceSecure()) { unlock(); return; }
        CharSequence name = getApplicationInfo().loadLabel(getPackageManager());
        prompting = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            BiometricPrompt.Builder builder = new BiometricPrompt.Builder(this).setTitle("Desbloquear " + name).setSubtitle("Huella, rostro o PIN del teléfono");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) builder.setAllowedAuthenticators(android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_WEAK | android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL);
            else builder.setDeviceCredentialAllowed(true);
            builder.build().authenticate(new CancellationSignal(), getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) { prompting = false; unlock(); }
                @Override public void onAuthenticationError(int code, CharSequence message) { prompting = false; }
            });
            return;
        }
        // Android 6 a 9: pantalla de PIN/patrón del sistema (muchos teléfonos aceptan ahí la huella).
        android.app.KeyguardManager km = (android.app.KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        Intent intent = km.createConfirmDeviceCredentialIntent("Desbloquear " + name, "Usa el PIN, patrón o contraseña del teléfono");
        if (intent == null) { prompting = false; unlock(); return; }
        startActivityForResult(intent, UNLOCK_REQUEST);
    }

    /** Diálogo nativo para alert/confirm/prompt de la interfaz. `input` no nulo = pide un texto. */
    private boolean dialog(String message, String input, android.webkit.JsResult result, android.webkit.JsPromptResult promptResult, boolean cancellable) {
        if (isFinishing()) { result.cancel(); return true; }
        try {
            final android.widget.EditText field = input == null ? null : new android.widget.EditText(this);
            android.app.AlertDialog.Builder builder = new android.app.AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert).setMessage(message);
            if (field != null) {
                field.setText(input);
                field.setSelectAllOnFocus(true);
                field.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
                android.widget.FrameLayout box = new android.widget.FrameLayout(this);
                int pad = (int) (20 * getResources().getDisplayMetrics().density);
                box.setPadding(pad, 0, pad, 0);
                box.addView(field);
                builder.setView(box);
            }
            builder.setPositiveButton("Aceptar", (d, w) -> { if (field != null && promptResult != null) promptResult.confirm(field.getText().toString()); else result.confirm(); });
            if (cancellable) builder.setNegativeButton("Cancelar", (d, w) -> result.cancel());
            builder.setOnCancelListener(d -> result.cancel());
            builder.show();
        } catch (Exception error) { result.cancel(); }
        return true;
    }

    private boolean openExternal(String url) {
        if (url == null || !url.startsWith("https://")) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)));
        } catch (Exception ignored) {
            // sin navegador instalado: no se navega dentro de la app
        }
        return true;
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 4201);
        }
    }

    private void startNativeSupervisor() {
        Intent intent = new Intent(this, NativeSupervisorService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent);
        else startService(intent);
    }

    private void showError() {
        TextView error = new TextView(this);
        error.setText("No se pudo cargar la interfaz local. Reinicia la aplicación.");
        error.setTextColor(Color.rgb(255, 112, 128));
        error.setTextSize(16);
        error.setPadding(32, 64, 32, 32);
        error.setBackgroundColor(Color.rgb(10, 15, 13));
        setContentView(error);
    }

    public static class WalletBridge {
        private final Context context;
        private final Activity activity;
        private WebView webView;
        WalletBridge(Activity activity) { this.activity = activity; this.context = activity.getApplicationContext(); }
        void setWebView(WebView webView) { this.webView = webView; }

        /** Versión instalada y tienda de origen: el aviso de actualizaciones no ofrece la APK de GitHub a quien instaló desde F-Droid (otra firma). */
        @JavascriptInterface public String appInfo() {
            try {
                android.content.pm.PackageManager pm = context.getPackageManager();
                android.content.pm.PackageInfo info = pm.getPackageInfo(context.getPackageName(), 0);
                String installer = pm.getInstallerPackageName(context.getPackageName());
                return new JSONObject().put("version", info.versionName).put("installer", installer == null ? "" : installer).toString();
            } catch (Exception error) {
                return error(error.getClass().getSimpleName());
            }
        }

        /** Estado del bloqueo para Configuración. */
        @JavascriptInterface public String lockInfo() {
            try {
                MainActivity a = (MainActivity) activity;
                SharedPreferences p = a.lockPrefs();
                return new JSONObject().put("live", p.getBoolean("live", false)).put("manual", p.getBoolean("manual", false))
                    .put("required", a.lockRequired()).put("available", a.deviceSecure()).put("locked", a.isLocked()).toString();
            } catch (Exception error) { return error(error); }
        }

        /** La interfaz avisa si hay mercados con dinero real (solo tras leerlos bien del agente). */
        @JavascriptInterface public void setLiveMoney(boolean live) {
            MainActivity a = (MainActivity) activity;
            a.lockPrefs().edit().putBoolean("live", live).apply();
            a.runOnUiThread(a::applySecure);
        }

        @JavascriptInterface public String setLockManual(boolean on) {
            MainActivity a = (MainActivity) activity;
            a.lockPrefs().edit().putBoolean("manual", on).apply();
            a.runOnUiThread(a::applySecure);
            return lockInfo();
        }

        @JavascriptInterface public String authorizeTrading(String message) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return error("BIOMETRIC_API_REQUIRED");
            try {
                KeyPair pair = getAuthKeyPair();
                Signature signer = Signature.getInstance("SHA256withECDSA");
                signer.initSign(pair.getPrivate());
                BiometricPrompt.Builder promptBuilder = new BiometricPrompt.Builder(activity)
                    .setTitle("Autorizar trading local")
                    .setSubtitle("Usa huella, rostro o PIN del dispositivo")
                    .setDescription("No se comparte la seed ni se autoriza una operación concreta");
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) promptBuilder.setAllowedAuthenticators(android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG | android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL);
                else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) promptBuilder.setDeviceCredentialAllowed(true);
                else promptBuilder.setNegativeButton("CANCELAR", context.getMainExecutor(), (dialog, which) -> sendBiometricResult(error("BIOMETRIC_CANCELLED")));
                BiometricPrompt prompt = promptBuilder.build();
                prompt.authenticate(new BiometricPrompt.CryptoObject(signer), new CancellationSignal(), context.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                    @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        try {
                            Signature crypto = result.getCryptoObject() != null && result.getCryptoObject().getSignature() != null ? result.getCryptoObject().getSignature() : signer;
                            crypto.update(message.getBytes(StandardCharsets.UTF_8));
                            String signature = Base64.encodeToString(crypto.sign(), Base64.NO_WRAP);
                            String publicKey = Base64.encodeToString(pair.getPublic().getEncoded(), Base64.NO_WRAP);
                            sendBiometricResult(new JSONObject().put("status", "AUTHORIZED").put("message", message).put("signature_der_b64", signature).put("public_key_der_b64", publicKey).toString());
                        } catch (Exception error) { sendBiometricResult(error(error)); }
                    }
                    @Override public void onAuthenticationError(int code, CharSequence message) { sendBiometricResult(error("BIOMETRIC_ERROR_" + code)); }
                });
                return new JSONObject().put("status", "BIOMETRIC_PENDING").toString();
            } catch (Exception error) { return error(error); }
        }

        private KeyPair getAuthKeyPair() throws Exception {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
            if (!store.containsAlias(AUTH_KEY_ALIAS)) {
                KeyPairGenerator generator = KeyPairGenerator.getInstance("EC", "AndroidKeyStore");
                android.security.keystore.KeyGenParameterSpec.Builder builder = new android.security.keystore.KeyGenParameterSpec.Builder(AUTH_KEY_ALIAS, android.security.keystore.KeyProperties.PURPOSE_SIGN).setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1")).setDigests(android.security.keystore.KeyProperties.DIGEST_SHA256).setUserAuthenticationRequired(true);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) builder.setUserAuthenticationParameters(0, android.security.keystore.KeyProperties.AUTH_BIOMETRIC_STRONG | android.security.keystore.KeyProperties.AUTH_DEVICE_CREDENTIAL);
                else builder.setUserAuthenticationValidityDurationSeconds(-1);
                generator.initialize(builder.build()); generator.generateKeyPair();
            }
            return new KeyPair(store.getCertificate(AUTH_KEY_ALIAS).getPublicKey(), (java.security.PrivateKey) store.getKey(AUTH_KEY_ALIAS, null));
        }

        /**
         * Inicio de sesión en DEX Pilot: tras huella, rostro o PIN, firma con la wallet local el reto del servidor
         * (mensaje personal EIP-191, que nunca puede ser una transacción). Solo firma retos de inicio de sesión.
         */
        @JavascriptInterface public String walletLogin(String message) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return error("BIOMETRIC_API_REQUIRED");
            try {
                if (message == null || !message.startsWith("DEX Pilot \u00b7 iniciar sesi\u00f3n en la app \u00b7 ") || message.length() > 300) return error("LOGIN_MESSAGE_INVALID");
                JSONObject wallet = readWallet();
                if (wallet == null) return error("WALLET_NOT_CONFIGURED");
                BiometricPrompt.Builder promptBuilder = new BiometricPrompt.Builder(activity)
                    .setTitle("Iniciar sesi\u00f3n en Card\u00f3n DeFi")
                    .setSubtitle("Usa huella, rostro o PIN del dispositivo")
                    .setDescription("Tu wallet firma un mensaje de acceso. No mueve fondos ni comparte la seed.");
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) promptBuilder.setAllowedAuthenticators(android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG | android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL);
                else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) promptBuilder.setDeviceCredentialAllowed(true);
                else promptBuilder.setNegativeButton("CANCELAR", context.getMainExecutor(), (dialog, which) -> sendLoginResult(error("BIOMETRIC_CANCELLED")));
                promptBuilder.build().authenticate(new CancellationSignal(), context.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                    @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        try {
                            JSONObject stored = readWallet();
                            Credentials credentials = Credentials.create(ECKeyPair.create(new BigInteger(stored.getString("privateKey"), 16)));
                            org.web3j.crypto.Sign.SignatureData sig = org.web3j.crypto.Sign.signPrefixedMessage(message.getBytes(StandardCharsets.UTF_8), credentials.getEcKeyPair());
                            byte[] out = new byte[65];
                            System.arraycopy(sig.getR(), 0, out, 0, 32); System.arraycopy(sig.getS(), 0, out, 32, 32); out[64] = sig.getV()[0];
                            sendLoginResult(new JSONObject().put("status", "SIGNED").put("message", message).put("signature", Numeric.toHexString(out)).put("address", normalizeAddress(credentials.getAddress())).toString());
                        } catch (Exception error) { sendLoginResult(error(error)); }
                    }
                    @Override public void onAuthenticationError(int code, CharSequence text) { sendLoginResult(error("BIOMETRIC_ERROR_" + code)); }
                });
                return new JSONObject().put("status", "BIOMETRIC_PENDING").toString();
            } catch (Exception error) { return error(error); }
        }

        /** Guarda la dirección del agente para el servicio que vigila su estado. Solo https. */
        @JavascriptInterface public void setCloud(String base) {
            String value = base == null ? "" : base.trim().replaceAll("/api/v1/?$", "").replaceAll("/+$", "");
            if (!value.isEmpty() && !value.matches("https://[A-Za-z0-9.-]+")) return;
            context.getSharedPreferences(NativeSupervisorService.CLOUD_PREFS, Context.MODE_PRIVATE).edit().putString("base", value).apply();
        }

        /**
         * Petición HTTPS sin las restricciones de origen del WebView, solo hacia GitHub y Cloudflare:
         * el instalador las necesita para crear la nube del usuario. Responde en window.onNativeHttp(id, status, texto).
         */
        @JavascriptInterface public void http(String id, String method, String url, String headersJson, String body) {
            new Thread(() -> {
                int status = 0;
                String text;
                try {
                    if (url == null || !(url.startsWith("https://api.github.com/") || url.startsWith("https://api.cloudflare.com/client/v4/"))) throw new IllegalArgumentException("destino no permitido");
                    final int[] code = {0};
                    text = request(method, url, new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson), body, s -> code[0] = s);
                    status = code[0];
                } catch (Exception error) {
                    text = "{\"error\":" + JSONObject.quote(error.getClass().getSimpleName() + ": " + error.getMessage()) + "}";
                }
                final String js = "window.onNativeHttp&&window.onNativeHttp(" + JSONObject.quote(id) + "," + status + "," + JSONObject.quote(text) + ")";
                if (webView != null) webView.post(() -> webView.evaluateJavascript(js, null));
            }).start();
        }

        private interface StatusSink { void accept(int status); }

        private String request(String method, String url, JSONObject headers, String body, StatusSink sink) throws Exception {
            HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
            try {
                connection.setRequestMethod(method);
                connection.setConnectTimeout(20000);
                connection.setReadTimeout(30000);
                for (java.util.Iterator<String> it = headers.keys(); it.hasNext(); ) { String key = it.next(); connection.setRequestProperty(key, headers.getString(key)); }
                if (body != null && !body.isEmpty()) {
                    connection.setDoOutput(true);
                    try (OutputStream out = connection.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
                }
                int status = connection.getResponseCode();
                sink.accept(status);
                InputStream in = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                if (in != null) { byte[] chunk = new byte[8192]; for (int n; (n = in.read(chunk)) > 0; ) buffer.write(chunk, 0, n); in.close(); }
                return buffer.toString("UTF-8");
            } finally { connection.disconnect(); }
        }

        /**
         * Dinero real: tras huella, rostro o PIN, sube la clave de firma de la wallet como secreto del Worker del usuario,
         * directo del teléfono a su Cloudflare. La clave nunca pasa por la interfaz web, por GitHub ni por terceros.
         * Responde en window.onSigningKeyUpload(json).
         */
        @JavascriptInterface public String uploadSigningKey(String accountId, String token, String script) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return error("BIOMETRIC_API_REQUIRED");
            try {
                if (accountId == null || !accountId.matches("[0-9a-f]{32}")) return error("CLOUDFLARE_ACCOUNT_INVALID");
                if (script == null || !script.matches("[a-z0-9-]{1,63}")) return error("SCRIPT_INVALID");
                if (token == null || token.length() < 20 || token.length() > 200) return error("CLOUDFLARE_TOKEN_INVALID");
                if (readWallet() == null) return error("WALLET_NOT_CONFIGURED");
                BiometricPrompt.Builder promptBuilder = new BiometricPrompt.Builder(activity)
                    .setTitle("Activar dinero real")
                    .setSubtitle("Usa huella, rostro o PIN del dispositivo")
                    .setDescription("La clave de firma de tu wallet se guardar\u00e1 como secreto en tu propia cuenta de Cloudflare para que tu agente pueda operar.");
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) promptBuilder.setAllowedAuthenticators(android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG | android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL);
                else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) promptBuilder.setDeviceCredentialAllowed(true);
                else promptBuilder.setNegativeButton("CANCELAR", context.getMainExecutor(), (dialog, which) -> sendKeyUploadResult(error("BIOMETRIC_CANCELLED")));
                promptBuilder.build().authenticate(new CancellationSignal(), context.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                    @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        new Thread(() -> {
                            try {
                                JSONObject stored = readWallet();
                                String key = stored.getString("privateKey").replaceFirst("(?i)^0x", "");
                                while (key.length() < 64) key = "0" + key;
                                JSONObject headers = new JSONObject().put("Authorization", "Bearer " + token).put("Content-Type", "application/json");
                                String payload = new JSONObject().put("name", "WALLET_PRIVATE_KEY").put("text", "0x" + key).put("type", "secret_text").toString();
                                final int[] status = {0};
                                String text = request("PUT", "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/workers/scripts/" + script + "/secrets", headers, payload, s -> status[0] = s);
                                boolean ok = status[0] >= 200 && status[0] < 300 && new JSONObject(text).optBoolean("success");
                                sendKeyUploadResult(new JSONObject().put("status", ok ? "UPLOADED" : "REJECTED").put("http", status[0]).put("address", stored.optString("address")).toString());
                            } catch (Exception error) { sendKeyUploadResult(error(error)); }
                        }).start();
                    }
                    @Override public void onAuthenticationError(int code, CharSequence text) { sendKeyUploadResult(error("BIOMETRIC_ERROR_" + code)); }
                });
                return new JSONObject().put("status", "BIOMETRIC_PENDING").toString();
            } catch (Exception error) { return error(error); }
        }

        private void sendKeyUploadResult(String result) { if (webView != null) webView.post(() -> webView.evaluateJavascript("window.onSigningKeyUpload&&window.onSigningKeyUpload(" + JSONObject.quote(result) + ");", null)); }

        private void sendLoginResult(String result) { if (webView != null) webView.post(() -> webView.evaluateJavascript("window.onWalletLogin(" + JSONObject.quote(result) + ");", null)); }

        private void sendBiometricResult(String result) { if (webView != null) webView.post(() -> webView.evaluateJavascript("window.onBiometricAuthorization(" + JSONObject.quote(result) + ");", null)); }

        @JavascriptInterface public String status() {
            try {
                JSONObject stored = readWallet();
                if (stored == null) return json(false, null, null);
                return json(true, normalizeAddress(stored.optString("address")), null);
            } catch (Exception error) { return error(error); }
        }

        @JavascriptInterface public String engineStatus() {
            try {
                SharedPreferences prefs = context.getSharedPreferences(NativeSupervisorService.PREFS, Context.MODE_PRIVATE);
                return new JSONObject()
                    .put("running", true)
                    .put("backend_online", prefs.getBoolean("backend_online", false))
                    .put("mode", prefs.getString("mode", "STARTING"))
                    .put("detail", prefs.getString("detail", "Supervisor local iniciando"))
                    .put("checked_at", prefs.getLong("checked_at", 0))
                    .put("execution", "SAFE_HOLD_ONLY")
                    .toString();
            } catch (Exception error) { return error(error); }
        }

        @JavascriptInterface public String restartEngine() {
            try {
                Intent intent = new Intent(context, NativeSupervisorService.class);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
                else context.startService(intent);
                return new JSONObject().put("status", "STARTED").put("execution", "SAFE_HOLD_ONLY").toString();
            } catch (Exception error) { return error(error); }
        }

        @JavascriptInterface public String create() {
            try {
                if (readWallet() != null) return error("WALLET_ALREADY_EXISTS");
                byte[] entropy = new byte[16];
                new SecureRandom().nextBytes(entropy);
                String mnemonic = MnemonicUtils.generateMnemonic(entropy);
                Credentials credentials = credentialsFromMnemonic(mnemonic);
                String address = normalizeAddress(credentials.getAddress());
                persist(address, credentials.getEcKeyPair().getPrivateKey().toString(16), mnemonic);
                return json(true, address, mnemonic);
            } catch (Exception error) { return error(error); }
        }

        @JavascriptInterface public String importSecret(String secret) {
            try {
                if (readWallet() != null) return error("WALLET_ALREADY_EXISTS");
                return restoreSecret(secret, null);
            } catch (Exception error) { return error(error); }
        }

        @JavascriptInterface public String replaceSecret(String secret, String confirmation) {
            try {
                if (!"RESTORE LOCAL".equals(confirmation)) return error("RESTORE_CONFIRMATION_REQUIRED");
                JSONObject previous = readWallet();
                return restoreSecret(secret, previous == null ? null : previous.optString("address"));
            } catch (Exception error) { return error(error); }
        }

        private String restoreSecret(String secret, String previousAddress) throws Exception {
            String value = secret == null ? "" : secret.trim().replaceAll("\\s+", " ");
            String address;
            if (value.matches("(?i)^(0x)?[0-9a-f]{64}$")) {
                String key = value.replaceFirst("(?i)^0x", "");
                Credentials credentials = Credentials.create(ECKeyPair.create(new BigInteger(key, 16)));
                address = normalizeAddress(credentials.getAddress());
                persist(address, key, null);
            } else {
                if (value.split("\\s+").length < 12) return error("SEED_OR_PRIVATE_KEY_REQUIRED");
                Credentials credentials = credentialsFromMnemonic(value);
                address = normalizeAddress(credentials.getAddress());
                persist(address, credentials.getEcKeyPair().getPrivateKey().toString(16), value);
            }
            if (previousAddress != null && !normalizeAddress(previousAddress).equalsIgnoreCase(address)) deleteWalletFile(previousAddress);
            return json(true, address, null);
        }

        @JavascriptInterface public String previewTransfer(String asset, String amount, String to) {
            try { return transferPreview(asset, amount, to).toString(); }
            catch (Exception error) { return error(error); }
        }

        @JavascriptInterface public String sendTransfer(String asset, String amount, String to, String confirmation) {
            try {
                if (!"SEND REAL".equals(confirmation)) return error("REAL_TRANSFER_CONFIRMATION_REQUIRED");
                JSONObject preview = transferPreview(asset, amount, to);
                if (!"READY".equals(preview.optString("status"))) return preview.toString();
                JSONObject wallet = readWallet();
                Credentials credentials = Credentials.create(ECKeyPair.create(new BigInteger(wallet.getString("privateKey"), 16)));
                RawTransaction raw = RawTransaction.createTransaction(
                    new BigInteger(preview.getString("nonce"), 16),
                    new BigInteger(preview.getString("gas_price_wei"), 16),
                    new BigInteger(preview.getString("gas_limit"), 16),
                    preview.getString("to_contract_or_recipient"),
                    new BigInteger(preview.getString("value_wei").substring(2), 16),
                    preview.getString("data"));
                byte[] signed = TransactionEncoder.signMessage(raw, preview.getLong("chain_id"), credentials);
                String txHash = rpc(preview.getString("rpc"), "eth_sendRawTransaction", new JSONArray().put(Numeric.toHexString(signed))).getString("result");
                return new JSONObject().put("status", "SUBMITTED").put("tx_hash", txHash).put("chain_id", preview.getLong("chain_id")).put("asset", asset).put("to", to).put("amount", amount).put("local_signing", true).put("read_only", false).toString();
            } catch (Exception error) { return error(error); }
        }

        @JavascriptInterface public String previewSwap(String assetIn, String amount, String slippageBps) {
            try { return swapPreview(assetIn, amount, slippageBps).toString(); }
            catch (Exception error) { return error(error); }
        }

        @JavascriptInterface public String sendSwap(String assetIn, String amount, String slippageBps, String confirmation) {
            try {
                if (!"SWAP REAL".equals(confirmation)) return error("REAL_SWAP_CONFIRMATION_REQUIRED");
                JSONObject preview = swapPreview(assetIn, amount, slippageBps);
                if (!"READY".equals(preview.optString("status"))) return preview.toString();
                JSONObject wallet = readWallet();
                Credentials credentials = Credentials.create(ECKeyPair.create(new BigInteger(wallet.getString("privateKey"), 16)));
                RawTransaction raw = RawTransaction.createTransaction(new BigInteger(preview.getString("nonce"), 16), new BigInteger(preview.getString("gas_price_wei"), 16), new BigInteger(preview.getString("gas_limit"), 16), QUICKSWAP_V2_ROUTER, new BigInteger(preview.getString("value_wei").substring(2), 16), preview.getString("data"));
                byte[] signed = TransactionEncoder.signMessage(raw, preview.getLong("chain_id"), credentials);
                String hash = rpc(POLYGON_RPC, "eth_sendRawTransaction", new JSONArray().put(Numeric.toHexString(signed))).getString("result");
                return new JSONObject().put("status", "SUBMITTED").put("tx_hash", hash).put("asset_in", assetIn).put("amount", amount).put("local_signing", true).toString();
            } catch (Exception error) { return error(error); }
        }

        @JavascriptInterface public String transactionStatus(String asset, String txHash) {
            try {
                if (txHash == null || !txHash.matches("0x[0-9a-fA-F]{64}")) return error("TX_HASH_REQUIRED");
                Network network = networkFor(asset);
                JSONObject response = rpc(network.rpc, "eth_getTransactionReceipt", new JSONArray().put(txHash));
                JSONObject result = response.get("result") == JSONObject.NULL ? null : response.getJSONObject("result");
                if (result == null) return new JSONObject().put("status", "PENDING").put("tx_hash", txHash).toString();
                String status = "0x1".equalsIgnoreCase(result.optString("status")) ? "CONFIRMED" : "FAILED";
                return new JSONObject().put("status", status).put("tx_hash", txHash).put("block_number", result.optString("blockNumber")).put("gas_used", result.optString("gasUsed")).toString();
            } catch (Exception error) { return error(error); }
        }

        private Credentials credentialsFromMnemonic(String mnemonic) {
            if (!MnemonicUtils.validateMnemonic(mnemonic)) throw new IllegalArgumentException("INVALID_MNEMONIC");
            byte[] seed = MnemonicUtils.generateSeed(mnemonic, "");
            Bip32ECKeyPair master = Bip32ECKeyPair.generateKeyPair(seed);
            int hardened = Bip32ECKeyPair.HARDENED_BIT;
            int[] path = {44 | hardened, 60 | hardened, 0 | hardened, 0, 0};
            return Credentials.create(Bip32ECKeyPair.deriveKeyPair(master, path));
        }

        private void persist(String address, String privateKey, String mnemonic) throws Exception {
            JSONObject data = new JSONObject().put("address", address).put("privateKey", privateKey);
            if (mnemonic != null) data.put("mnemonic", mnemonic);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getKey());
            byte[] encrypted = cipher.doFinal(data.toString().getBytes(StandardCharsets.UTF_8));
            String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
            String body = Base64.encodeToString(encrypted, Base64.NO_WRAP);
            String blob = iv + "." + body;
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(BLOB, blob).apply();
            File folder = new File(context.getFilesDir(), "wallets");
            if (!folder.exists() && !folder.mkdirs()) throw new IllegalStateException("WALLET_FOLDER_CREATE_FAILED");
            File file = new File(folder, address.toLowerCase().replace("0x", "") + ".wallet");
            try (FileOutputStream output = new FileOutputStream(file, false)) { output.write(blob.getBytes(StandardCharsets.UTF_8)); }
        }

        private void deleteWalletFile(String address) {
            if (address == null || address.isBlank()) return;
            File file = new File(new File(context.getFilesDir(), "wallets"), normalizeAddress(address).toLowerCase().replace("0x", "") + ".wallet");
            if (file.exists()) file.delete();
        }

        private JSONObject transferPreview(String asset, String amountText, String recipient) throws Exception {
            JSONObject wallet = readWallet();
            if (wallet == null) return errorObject("WALLET_NOT_CONFIGURED");
            if (!isEvmAddress(recipient)) return errorObject("EVM_RECIPIENT_REQUIRED");
            Network network = networkFor(asset);
            BigInteger amount = units(amountText, network.decimals);
            String address = wallet.getString("address");
            String chainHex = rpc(network.rpc, "eth_chainId", new JSONArray()).getString("result");
            long chainId = Long.parseLong(chainHex.substring(2), 16);
            if (chainId != network.chainId) return errorObject("WRONG_CHAIN_ID_" + chainId);
            String nonce = rpc(network.rpc, "eth_getTransactionCount", new JSONArray().put(address).put("pending")).getString("result");
            String gasPrice = rpc(network.rpc, "eth_gasPrice", new JSONArray()).getString("result");
            String contractOrRecipient = network.contract == null ? recipient : network.contract;
            String data = network.contract == null ? "0x" : "0xa9059cbb" + word(recipient) + word(amount.toString(16));
            String value = network.contract == null ? hex(amount) : "0x0";
            JSONObject call = new JSONObject().put("from", address).put("to", contractOrRecipient).put("value", value).put("data", data);
            String estimate = rpc(network.rpc, "eth_estimateGas", new JSONArray().put(call)).getString("result");
            BigInteger gasLimit = new BigInteger(estimate.substring(2), 16).multiply(BigInteger.valueOf(12)).divide(BigInteger.TEN);
            BigInteger fee = new BigInteger(gasPrice.substring(2), 16).multiply(gasLimit);
            BigInteger nativeBalance = new BigInteger(rpc(network.rpc, "eth_getBalance", new JSONArray().put(address).put("latest")).getString("result").substring(2), 16);
            if (nativeBalance.compareTo(fee) < 0) return errorObject("INSUFFICIENT_NATIVE_FOR_GAS").put("fee_native_wei", fee.toString(16));
            if (network.contract != null) {
                String rawToken = rpc(network.rpc, "eth_call", new JSONArray().put(new JSONObject().put("to", network.contract).put("data", "0x70a08231" + word(address))).put("latest")).getString("result");
                if (new BigInteger(rawToken.substring(2), 16).compareTo(amount) < 0) return errorObject("INSUFFICIENT_" + asset);
            } else if (nativeBalance.compareTo(amount.add(fee)) < 0) return errorObject("INSUFFICIENT_" + asset + "_FOR_AMOUNT_AND_GAS");
            return new JSONObject().put("status", "READY").put("asset", asset).put("amount", amountText).put("recipient", recipient).put("rpc", network.rpc).put("chain_id", chainId).put("nonce", nonce).put("gas_price_wei", gasPrice).put("gas_limit", hex(gasLimit)).put("fee_native_wei", hex(fee)).put("to_contract_or_recipient", contractOrRecipient).put("value_wei", value).put("data", data).put("local_signing", true).put("requires_confirmation", "SEND REAL");
        }

        private JSONObject swapPreview(String assetIn, String amountText, String slippageText) throws Exception {
            if (!"POL".equals(assetIn)) return errorObject("ONLY_POL_TO_USDC_ENABLED_IN_PHASE_1");
            JSONObject wallet = readWallet();
            if (wallet == null) return errorObject("WALLET_NOT_CONFIGURED");
            BigInteger amount = units(amountText, 18);
            int slippage = Integer.parseInt(slippageText);
            if (amount.signum() <= 0 || slippage < 1 || slippage > 500) return errorObject("INVALID_SWAP_PARAMETERS");
            String owner = wallet.getString("address");
            String path = word(POLYGON_WPOL) + word(POLYGON_USDC);
            String quoteData = "0xd06ca61f" + word(amount) + word(64) + word(2) + path;
            String quoteRaw = rpc(POLYGON_RPC, "eth_call", new JSONArray().put(new JSONObject().put("to", QUICKSWAP_V2_ROUTER).put("data", quoteData)).put("latest")).getString("result");
            BigInteger quoted = new BigInteger(quoteRaw.substring(2 + 64 + 64 + 64, 2 + 64 + 64 + 128), 16);
            BigInteger minimum = quoted.multiply(BigInteger.valueOf(10000L - slippage)).divide(BigInteger.valueOf(10000));
            long deadline = System.currentTimeMillis() / 1000L + 600;
            String data = "0x7ff36ab5" + word(minimum) + word(128) + word(owner) + word(deadline) + word(2) + path;
            String nonce = rpc(POLYGON_RPC, "eth_getTransactionCount", new JSONArray().put(owner).put("pending")).getString("result");
            String gasPrice = rpc(POLYGON_RPC, "eth_gasPrice", new JSONArray()).getString("result");
            JSONObject call = new JSONObject().put("from", owner).put("to", QUICKSWAP_V2_ROUTER).put("value", hex(amount)).put("data", data);
            BigInteger gasLimit = new BigInteger(rpc(POLYGON_RPC, "eth_estimateGas", new JSONArray().put(call)).getString("result").substring(2), 16).multiply(BigInteger.valueOf(12)).divide(BigInteger.TEN);
            BigInteger fee = new BigInteger(gasPrice.substring(2), 16).multiply(gasLimit);
            BigInteger nativeBalance = new BigInteger(rpc(POLYGON_RPC, "eth_getBalance", new JSONArray().put(owner).put("latest")).getString("result").substring(2), 16);
            if (nativeBalance.compareTo(amount.add(fee)) < 0) return errorObject("INSUFFICIENT_POL_FOR_AMOUNT_AND_GAS").put("fee_native_wei", hex(fee));
            if (nativeBalance.subtract(amount.add(fee)).compareTo(MIN_POL_GAS_RESERVE_WEI) < 0) return errorObject("POL_GAS_RESERVE_WOULD_BE_BREACHED").put("fee_native_wei", hex(fee));
            return new JSONObject().put("status", "READY").put("asset_in", "POL").put("asset_out", "USDC").put("amount_in_wei", amount.toString()).put("quoted_out_wei", quoted.toString()).put("minimum_out_wei", minimum.toString()).put("slippage_bps", slippage).put("rpc", POLYGON_RPC).put("chain_id", 137).put("nonce", nonce).put("gas_price_wei", gasPrice).put("gas_limit", hex(gasLimit)).put("fee_native_wei", hex(fee)).put("value_wei", hex(amount)).put("data", data).put("local_signing", true).put("requires_confirmation", "SWAP REAL");
        }

        private JSONObject rpc(String endpoint, String method, JSONArray params) throws Exception {
            HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
            connection.setRequestMethod("POST"); connection.setConnectTimeout(15000); connection.setReadTimeout(20000); connection.setDoOutput(true); connection.setRequestProperty("content-type", "application/json");
            byte[] body = new JSONObject().put("jsonrpc", "2.0").put("id", 1).put("method", method).put("params", params).toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            InputStream input = connection.getResponseCode() >= 400 ? connection.getErrorStream() : connection.getInputStream();
            ByteArrayOutputStream result = new ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int read;
            while (input != null && (read = input.read(buffer)) >= 0) result.write(buffer, 0, read);
            JSONObject response = new JSONObject(result.toString(StandardCharsets.UTF_8));
            if (response.has("error")) throw new IllegalStateException(response.getJSONObject("error").optString("message", "RPC_ERROR"));
            return response;
        }

        private Network networkFor(String asset) {
            if ("POL".equals(asset)) return new Network(POLYGON_RPC, 137, 18, null);
            if ("DOT".equals(asset)) return new Network(POLKADOT_HUB_RPC, 420420419, 18, null);
            if ("USDC_POLYGON".equals(asset)) return new Network(POLYGON_RPC, 137, 6, POLYGON_USDC);
            if ("USDC_HUB".equals(asset) || "USDC".equals(asset)) return new Network(POLKADOT_HUB_RPC, 420420419, 6, HUB_USDC);
            if ("USDt".equals(asset)) return new Network(POLKADOT_HUB_RPC, 420420419, 6, HUB_USDT);
            if ("USDT".equals(asset)) return new Network(POLYGON_RPC, 137, 6, POLYGON_USDT);
            throw new IllegalArgumentException("UNSUPPORTED_ASSET");
        }

        private static class Network { final String rpc; final long chainId; final int decimals; final String contract; Network(String rpc, long chainId, int decimals, String contract) { this.rpc = rpc; this.chainId = chainId; this.decimals = decimals; this.contract = contract; } }
        private static boolean isEvmAddress(String value) { return value != null && value.matches("0x[0-9a-fA-F]{40}"); }
        private static String word(String value) {
            String clean = value == null ? "" : value.replaceFirst("(?i)^0x", "").toLowerCase();
            if (clean.length() > 64) throw new IllegalArgumentException("ABI_WORD_TOO_LONG");
            return "0".repeat(64 - clean.length()) + clean;
        }
        private static String word(BigInteger value) {
            String clean = value.toString(16).toLowerCase();
            if (clean.length() > 64) throw new IllegalArgumentException("ABI_WORD_TOO_LONG");
            return "0".repeat(64 - clean.length()) + clean;
        }
        private static String word(long value) { return word(BigInteger.valueOf(value)); }
        private static BigInteger units(String value, int decimals) { BigDecimal decimal = new BigDecimal(value); return decimal.movePointRight(decimals).setScale(0, RoundingMode.UNNECESSARY).toBigIntegerExact(); }
        private static String hex(BigInteger value) { return "0x" + value.toString(16); }
        private JSONObject errorObject(String message) throws Exception { return new JSONObject().put("status", "BLOCKED").put("error", message).put("local_signing", true); }

        private JSONObject readWallet() throws Exception {
            String blob = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(BLOB, null);
            if (blob == null) {
                File folder = new File(context.getFilesDir(), "wallets");
                File[] files = folder.listFiles((directory, name) -> name.endsWith(".wallet"));
                if (files != null && files.length > 0) {
                    try (FileInputStream input = new FileInputStream(files[0]); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                        byte[] buffer = new byte[1024]; int read;
                        while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
                        blob = output.toString(StandardCharsets.UTF_8);
                    }
                }
            }
            if (blob == null || !blob.contains(".")) return null;
            String[] parts = blob.split("\\.", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            JSONObject wallet = new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
            wallet.put("address", normalizeAddress(wallet.optString("address")));
            migrateWalletFile(wallet.optString("address"), blob);
            return wallet;
        }

        private void migrateWalletFile(String address, String blob) {
            try {
                File folder = new File(context.getFilesDir(), "wallets");
                if (!folder.exists() && !folder.mkdirs()) return;
                File file = new File(folder, address.toLowerCase().replace("0x", "") + ".wallet");
                if (!file.exists()) try (FileOutputStream output = new FileOutputStream(file, false)) { output.write(blob.getBytes(StandardCharsets.UTF_8)); }
            } catch (Exception ignored) { }
        }

        private static String normalizeAddress(String value) {
            String clean = value == null ? "" : value.trim();
            while (clean.regionMatches(true, 0, "0x", 0, 2)) clean = clean.substring(2);
            return "0x" + clean;
        }

        private SecretKey getKey() throws Exception {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (!store.containsAlias(KEY_ALIAS)) {
                KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
                generator.generateKey();
            }
            return (SecretKey) store.getKey(KEY_ALIAS, null);
        }

        private String json(boolean configured, String address, String mnemonic) throws Exception {
            JSONObject result = new JSONObject().put("configured", configured).put("address", address == null ? JSONObject.NULL : address).put("local_only", true).put("signing_enabled", configured);
            if (mnemonic != null) result.put("backup_phrase_once", mnemonic);
            return result.toString();
        }

        private String error(Exception error) { return error(error.getMessage() == null ? "WALLET_ERROR" : error.getMessage()); }
        private String error(String message) { try { return new JSONObject().put("configured", false).put("error", message).toString(); } catch (Exception ignored) { return "{\"error\":\"WALLET_ERROR\"}"; } }
    }
}
