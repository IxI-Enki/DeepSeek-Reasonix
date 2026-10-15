// A D1-shaped wrapper over node:sqlite, so tests run the real SQL (partial unique
// indexes, upserts, transactional batches) instead of a hand-written stub.
type Row = Record<string, unknown>;

interface Sqlite {
  exec(sql: string): void;
  prepare(sql: string): { all(...p: unknown[]): Row[]; get(...p: unknown[]): Row | undefined; run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } };
}

class Statement {
  constructor(private readonly db: Sqlite, readonly sql: string, private readonly params: unknown[] = []) {}
  bind(...params: unknown[]) {
    // D1 refuses more than 100 bound parameters in one statement; SQLite itself allows far more,
    // so without this a query that fails in production passes here.
    if (params.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${params.length} bound, 100 allowed)`);
    return new Statement(this.db, this.sql, params);
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[], success: true };
  }
  async run() {
    return this.exec();
  }
  exec() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export async function memoryD1(...scripts: string[]): Promise<D1Database> {
  const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (path: string) => Sqlite };
  const db = new DatabaseSync(":memory:");
  for (const script of scripts) db.exec(script);
  return {
    prepare: (sql: string) => new Statement(db, sql),
    async batch(statements: Statement[]) {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => s.exec());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
}
