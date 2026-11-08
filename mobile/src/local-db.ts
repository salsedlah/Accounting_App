import * as SQLite from "expo-sqlite";

export type QueuedRequest = {
  id: string;
  method: string;
  path: string;
  body: string;
  createdAt: string;
  status: "pending" | "failed";
  error: string | null;
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let schemaPromise: Promise<void> | null = null;

async function database(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) databasePromise = SQLite.openDatabaseAsync("hisab-mobile.db");
  const db = await databasePromise;
  if (!schemaPromise) {
    schemaPromise = db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cached_responses (
        cache_key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'failed')),
        error TEXT
      );
    `);
  }
  await schemaPromise;
  return db;
}

export async function writeCache(key: string, value: unknown): Promise<void> {
  const db = await database();
  await db.runAsync(
    `INSERT INTO cached_responses (cache_key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    JSON.stringify(value),
    new Date().toISOString(),
  );
}

export async function readCache<T>(key: string): Promise<{ value: T; updatedAt: string } | null> {
  const db = await database();
  const row = await db.getFirstAsync<{ value: string; updated_at: string }>(
    "SELECT value, updated_at FROM cached_responses WHERE cache_key = ?",
    key,
  );
  if (!row) return null;
  return { value: JSON.parse(row.value) as T, updatedAt: row.updated_at };
}

export async function enqueueRequest(input: {
  id: string;
  method: string;
  path: string;
  body: unknown;
}): Promise<void> {
  const db = await database();
  await db.runAsync(
    `INSERT INTO outbox (id, method, path, body, created_at, status, error)
     VALUES (?, ?, ?, ?, ?, 'pending', NULL)`,
    input.id,
    input.method,
    input.path,
    JSON.stringify(input.body),
    new Date().toISOString(),
  );
}

export async function listQueuedRequests(): Promise<QueuedRequest[]> {
  const db = await database();
  return db.getAllAsync<QueuedRequest>(
    "SELECT id, method, path, body, created_at AS createdAt, status, error FROM outbox ORDER BY created_at",
  );
}

export async function pendingRequestCount(): Promise<number> {
  const db = await database();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM outbox WHERE status IN ('pending', 'failed')",
  );
  return row?.count ?? 0;
}

export async function removeQueuedRequest(id: string): Promise<void> {
  const db = await database();
  await db.runAsync("DELETE FROM outbox WHERE id = ?", id);
}

export async function markQueuedRequestFailed(id: string, error: string): Promise<void> {
  const db = await database();
  await db.runAsync(
    "UPDATE outbox SET status = 'failed', error = ? WHERE id = ?",
    error,
    id,
  );
}

export async function retryFailedRequests(): Promise<void> {
  const db = await database();
  await db.runAsync(
    "UPDATE outbox SET status = 'pending', error = NULL WHERE status = 'failed'",
  );
}
