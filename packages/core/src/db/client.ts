/**
 * SQLite via bun:sqlite, WAL mode on. Single shared connection.
 * The DB file lives at <repo>/data/mise.db; override with MISE_DB_PATH
 * (tests point it at ':memory:' or a temp file).
 */
import { Database } from 'bun:sqlite';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { join, dirname } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import * as schema from './schema';

export type DB = BunSQLiteDatabase<typeof schema>;

let _db: DB | null = null;
let _sqlite: Database | null = null;

function repoRoot(): string {
  // packages/core/src/db → repo root is four levels up.
  return join(import.meta.dir, '..', '..', '..', '..');
}

export function dbPath(): string {
  return process.env.MISE_DB_PATH ?? join(repoRoot(), 'data', 'mise.db');
}

export function getDb(): DB {
  if (_db) return _db;
  const path = dbPath();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  _sqlite = new Database(path, { create: true });
  _sqlite.exec('PRAGMA journal_mode = WAL;');
  _sqlite.exec('PRAGMA foreign_keys = ON;');
  _db = drizzle(_sqlite, { schema });
  migrate(_sqlite);
  return _db;
}

/** For tests: swap in a fresh in-memory DB and get it back. */
export function resetDbForTests(): DB {
  _sqlite?.close();
  _sqlite = new Database(':memory:');
  _sqlite.exec('PRAGMA foreign_keys = ON;');
  _db = drizzle(_sqlite, { schema });
  migrate(_sqlite);
  return _db;
}

/** Run raw SQL in a transaction (used by tools' commit mode). Drizzle's own
 *  transaction API is preferred; this exists for migrations. */
function migrate(sqlite: Database) {
  const dir = join(repoRoot(), 'packages', 'core', 'drizzle');
  if (!existsSync(dir)) return;
  sqlite.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  const applied = new Set(
    (sqlite.query('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  );
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    sqlite.exec('BEGIN');
    try {
      // drizzle-kit separates statements with this marker.
      for (const stmt of sql.split('--> statement-breakpoint')) {
        const s = stmt.trim();
        if (s) sqlite.exec(s);
      }
      sqlite.exec(`INSERT INTO _migrations (name, applied_at) VALUES (?, datetime('now'))`, [f] as any);
      sqlite.exec('COMMIT');
    } catch (e) {
      sqlite.exec('ROLLBACK');
      throw e;
    }
  }
}

export { schema };
