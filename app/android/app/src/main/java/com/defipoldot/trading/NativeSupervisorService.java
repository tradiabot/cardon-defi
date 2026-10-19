package com.defipoldot.trading;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public class NativeSupervisorService extends Service {
    public static final String PREFS = "native_supervisor";
    /** Dirección del agente del usuario; la app la guarda al instalar o conectar su nube. */
    static final String CLOUD_PREFS = "cardon_cloud";
    private String base() { return getSharedPreferences(CLOUD_PREFS, MODE_PRIVATE).getString("base", ""); }
    private static final String CHANNEL_ID = "defi_supervisor";
    private static final String TRADES_CHANNEL_ID = "dexpilot_trades";
    private static final String ISSUES_CHANNEL_ID = "dexpilot_issues";
    private static final int ISSUES_NOTIFICATION_ID = 1043;
    /** Un problema avisa solo si sigue ahí después de un ciclo completo (5 min) más margen: los fallos de red sueltos se arreglan solos. */
    private static final long ISSUE_PERSIST_MS = 6 * 60_000L;
    private static final int NOTIFICATION_ID = 1042;
    private static final int TRADE_NOTIFICATION_BASE = 20000;
    private static final int SEEN_LIMIT = 200;
    private static final Set<String> NOTIFY_STATUSES = new LinkedHashSet<>(Arrays.asList("PENDIENTE", "CONFIRMADA", "FALLIDA", "DESCONOCIDA", "SIMULADA"));
    private final Handler handler = new Handler();
    private final Runnable cycle = new Runnable() {
        @Override public void run() {
            new Thread(() -> {
                checkBackend();
                checkTrades();
            }).start();
            handler.postDelayed(this, 60000L);
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        createChannels();
        startForeground(NOTIFICATION_ID, statusNotification("Conectando con tu bot (Cloudflare)"));
        handler.post(cycle);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    private static final class Response {
        final int code;
        final String body;
        Response(int code, String body) { this.code = code; this.body = body; }
    }

    private Response get(String path) throws Exception {
        String base = base();
        if (base.isEmpty()) throw new IllegalStateException("SIN_NUBE");
        HttpURLConnection connection = (HttpURLConnection) new URL(base + path).openConnection();
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(8000);
        connection.setRequestMethod("GET");
        try {
            int code = connection.getResponseCode();
            InputStream stream = code < 400 ? connection.getInputStream() : connection.getErrorStream();
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            if (stream != null) {
                byte[] chunk = new byte[4096];
                int n;
                while ((n = stream.read(chunk)) > 0 && buffer.size() < 262144) buffer.write(chunk, 0, n);
                stream.close();
            }
            return new Response(code, buffer.size() == 0 ? "{}" : buffer.toString("UTF-8"));
        } finally {
            connection.disconnect();
        }
    }

    private void checkBackend() {
        boolean online = false;
        String detail;
        try {
            Response r = get("/api/health");
            JSONObject health = new JSONObject(r.body);
            online = r.code == 200 && health.optBoolean("ok");
            checkIssues(health.optJSONArray("issues"));
            JSONArray problems = health.optJSONArray("problems");
            detail = online
                ? "Bot activo en Cloudflare · modo " + health.optString("mode", "?").toUpperCase(Locale.ROOT)
                : "Bot en Cloudflare con aviso: " + (problems != null && problems.length() > 0 ? problems.optString(0) : "HTTP " + r.code);
        } catch (Exception error) {
            detail = base().isEmpty() ? "Instala tu agente desde la app para empezar" : "Sin conexión con tu bot (Cloudflare): " + error.getClass().getSimpleName();
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putBoolean("backend_online", online)
            .putString("mode", online ? "CLOUD_OK" : "CLOUD_ALERT")
            .putString("detail", detail)
            .putLong("checked_at", System.currentTimeMillis())
            .apply();
        manager().notify(NOTIFICATION_ID, statusNotification(detail));
    }

    /**
     * Avisa (una vez) de cada problema del «médico» del bot que dure más de un ciclo. Cuando desaparece,
     * se olvida, y si vuelve a pasar se avisa otra vez.
     */
    private void checkIssues(JSONArray issues) {
        if (issues == null) return;
        try {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            JSONObject seen = new JSONObject(prefs.getString("issues_seen", "{}"));
            JSONObject next = new JSONObject();
            long now = System.currentTimeMillis();
            List<String> fresh = new ArrayList<>();
            boolean red = false;
            for (int i = 0; i < issues.length(); i++) {
                JSONObject x = issues.getJSONObject(i);
                String key = x.optString("market", "") + ":" + x.optString("code");
                JSONObject old = seen.optJSONObject(key);
                long first = old != null ? old.optLong("first", now) : now;
                boolean notified = old != null && old.optBoolean("notified");
                if (!notified && now - first >= ISSUE_PERSIST_MS) {
                    String market = x.isNull("market") ? "" : x.optString("market") + ": ";
                    fresh.add(market + x.optString("detail"));
                    red |= "rojo".equals(x.optString("level"));
                    notified = true;
                }
                next.put(key, new JSONObject().put("first", first).put("notified", notified));
            }
            prefs.edit().putString("issues_seen", next.toString()).apply();
            if (!fresh.isEmpty()) notifyIssues(fresh, red);
        } catch (Exception ignored) {
            // Respuesta rara del bot: se reintenta en el siguiente minuto.
        }
    }

    private void notifyIssues(List<String> lines, boolean red) {
        String title = (red ? "Tu bot tiene errores" : "Tu bot necesita revisión") + " (" + lines.size() + ")";
        String text = android.text.TextUtils.join("\n", lines) + "\nAbre Config → Estado en tiempo real → Buscar y corregir.";
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, ISSUES_CHANNEL_ID)
            : new Notification.Builder(this).setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        manager().notify(ISSUES_NOTIFICATION_ID, builder
            .setContentTitle(title)
            .setContentText(lines.get(0))
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentIntent(openApp())
            .setAutoCancel(true)
            .setShowWhen(true)
            .build());
    }

    private void checkTrades() {
        try {
            Response r = get("/api/trades?limit=10");
            if (r.code != 200) return;
            JSONArray trades = new JSONObject(r.body).optJSONArray("trades");
            if (trades == null) return;
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            List<String> seen = new ArrayList<>(Arrays.asList(prefs.getString("seen_trades", "").split(",")));
            boolean firstRun = !prefs.getBoolean("trades_initialized", false);
            for (int i = trades.length() - 1; i >= 0; i--) {
                JSONObject t = trades.getJSONObject(i);
                String status = t.optString("status");
                String key = t.optLong("id") + ":" + status;
                if (seen.contains(key)) continue;
                seen.add(key);
                if (!firstRun && NOTIFY_STATUSES.contains(status)) notifyTrade(t, status);
            }
            while (seen.size() > SEEN_LIMIT) seen.remove(0);
            prefs.edit().putString("seen_trades", android.text.TextUtils.join(",", seen)).putBoolean("trades_initialized", true).apply();
        } catch (Exception ignored) {
            // La próxima consulta (60 s) lo reintenta; el estado de conexión ya lo informa checkBackend.
        }
    }

    private void notifyTrade(JSONObject t, String status) {
        boolean buy = "BUY".equals(t.optString("side"));
        double in = t.optDouble("amount_in", 0), out = t.optDouble("amount_out", 0), price = t.optDouble("price_usd", 0);
        String verb = buy ? "Compra" : "Venta";
        String state;
        switch (status) {
            case "PENDIENTE": state = "enviada"; break;
            case "CONFIRMADA": state = "confirmada"; break;
            case "SIMULADA": state = "simulada"; break;
            case "FALLIDA": state = "FALLIDA"; break;
            default: state = "sin confirmar · revisa la app"; break;
        }
        String symbol = t.optString("symbol", "POL");
        String amounts = buy
            ? String.format(Locale.ROOT, "%.2f USDC → %.4f %s", in, out, symbol)
            : String.format(Locale.ROOT, "%.4f %s → %.2f USDC", in, symbol, out);
        StringBuilder text = new StringBuilder(amounts).append(String.format(Locale.ROOT, " · precio %.5f", price));
        if (!buy && "CONFIRMADA".equals(status) && !t.isNull("realized_pnl_usd")) {
            text.append(String.format(Locale.ROOT, " · P/L %+.3f USD", t.optDouble("realized_pnl_usd")));
        }
        String reason = t.optString("reason", "");
        if ("STOP_LOSS".equals(reason)) text.append(" · stop-loss");
        else if (reason.startsWith("Orden #")) text.append(" · ").append(reason.split(" · ")[0]);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, TRADES_CHANNEL_ID)
            : new Notification.Builder(this).setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        Notification n = builder
            .setContentTitle(verb + " " + state)
            .setContentText(text.toString())
            .setStyle(new Notification.BigTextStyle().bigText(text.toString()))
            .setSmallIcon(buy ? android.R.drawable.arrow_down_float : android.R.drawable.arrow_up_float)
            .setContentIntent(openApp())
            .setAutoCancel(true)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            .build();
        manager().notify(TRADE_NOTIFICATION_BASE + (int) (t.optLong("id") % 10000), n);
    }

    private PendingIntent openApp() {
        Intent intent = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private NotificationManager manager() {
        return (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel status = new NotificationChannel(CHANNEL_ID, "Estado del bot", NotificationManager.IMPORTANCE_LOW);
            status.setDescription("Estado de tu bot en Cloudflare");
            NotificationChannel trades = new NotificationChannel(TRADES_CHANNEL_ID, "Compras y ventas", NotificationManager.IMPORTANCE_HIGH);
            trades.setDescription("Aviso cada vez que el bot compra o vende");
            trades.enableVibration(true);
            NotificationChannel issues = new NotificationChannel(ISSUES_CHANNEL_ID, "Errores del bot", NotificationManager.IMPORTANCE_HIGH);
            issues.setDescription("Aviso cuando un mercado sigue con errores o necesita revisión");
            manager().createNotificationChannel(status);
            manager().createNotificationChannel(trades);
            manager().createNotificationChannel(issues);
        }
    }

    private Notification statusNotification(String content) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        return builder.setContentTitle("Card\u00f3n DeFi")
            .setContentText(content)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentIntent(openApp())
            .setOngoing(true)
            .build();
    }

    @Override public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
