import { createRequire } from 'node:module';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

class Statement {
  constructor(private db: DatabaseSync, private sql: string, private params: unknown[] = []) {}
  bind(...params: unknown[]) { return new Statement(this.db, this.sql, params); }
  private stmt() { return this.db.prepare(this.sql); }
  async first<T>() { return (this.stmt().get(...(this.params as never[])) ?? null) as T | null; }
  async all<T>() { return { results: this.stmt().all(...(this.params as never[])) as T[], success: true, meta: {} }; }
  async run() { const r = this.stmt().run(...(this.params as never[])); return { success: true, results: [], meta: { changes: Number(r.changes) } }; }
}

export function createD1(path: string) {
  const db = new DatabaseSync(path);
  return {
    raw: db,
    prepare: (sql: string) => new Statement(db, sql),
    async batch(statements: Statement[]) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
