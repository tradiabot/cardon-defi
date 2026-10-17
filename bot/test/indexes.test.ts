import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ensureReadIndexes } from '../src/db';

// node:sqlite se carga en tiempo de ejecución: Vite no resuelve ese módulo integrado.
interface DatabaseSync { exec(sql: string): void; prepare(sql: string): { all(): unknown[] } }
const { DatabaseSync } = createRequire(`${process.cwd()}/`)('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };

// D1 mínimo sobre SQLite real: batch de sentencias sin parámetros.
function fakeD1(sql: DatabaseSync) {
  let batches = 0;
  const db = {
    prepare: (q: string) => ({ q }),
    batch: async (stmts: { q: string }[]) => { batches++; stmts.forEach(s => sql.exec(s.q)); return []; },
  };
  return { db: db as unknown as D1Database, batches: () => batches };
}

describe('índices de lectura (límite diario de D1)', () => {
  it('la poda de precios y el conteo de operaciones usan índice, y se crean una sola vez por proceso', async () => {
    const sql = new DatabaseSync(':memory:');
    for (const f of readdirSync('migrations').filter((f: string) => f < '0006').sort()) sql.exec(readFileSync(`migrations/${f}`, 'utf8'));
    const plan = (q: string) => JSON.stringify(sql.prepare(`EXPLAIN QUERY PLAN ${q}`).all());
    expect(plan('DELETE FROM prices WHERE ts < 1')).toMatch(/SCAN prices/);
    const { db, batches } = fakeD1(sql);
    await ensureReadIndexes(db);
    await ensureReadIndexes(db);
    expect(batches()).toBe(1);
    expect(plan('DELETE FROM prices WHERE ts < 1')).toMatch(/USING INDEX prices_ts/);
    expect(plan("SELECT MAX(ts) FROM trades WHERE mode = 'LIVE' AND symbol = 'POL' AND status != 'ERROR_ENVIO'")).toMatch(/USING INDEX trades_mode_symbol_ts/);
  });
});
