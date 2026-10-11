export async function getKv<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}

export function putKv(db: D1Database, key: string, value: unknown, now: number): D1PreparedStatement {
  return db
    .prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, JSON.stringify(value), now);
}

export async function acquireLock(db: D1Database, now: number, ttlMs: number, key = 'lock'): Promise<boolean> {
  const result = await db
    .prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, '1', ?) ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at WHERE kv.updated_at < ?")
    .bind(key, now, now - ttlMs)
    .run();
  return result.meta.changes > 0;
}

export async function releaseLock(db: D1Database, key = 'lock'): Promise<void> {
  await db.prepare('UPDATE kv SET updated_at = 0 WHERE key = ?').bind(key).run();
}

export async function priceSeries(db: D1Database, symbol: string, limit: number): Promise<{ ts: number; usd: number }[]> {
  const { results } = await db
    .prepare('SELECT ts, usd FROM prices WHERE symbol = ? ORDER BY ts DESC LIMIT ?')
    .bind(symbol, limit)
    .all<{ ts: number; usd: number }>();
  return results.reverse();
}

export async function tradeStats(db: D1Database, dayStart: number, mode: 'PAPER' | 'LIVE', symbol = 'POL'): Promise<{ today: number; lastTs: number | null }> {
  const row = await db
    .prepare("SELECT SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS today, MAX(ts) AS last FROM trades WHERE mode = ? AND symbol = ? AND status != 'ERROR_ENVIO'")
    .bind(dayStart, mode, symbol)
    .first<{ today: number | null; last: number | null }>();
  return { today: row?.today ?? 0, lastTs: row?.last ?? null };
}
