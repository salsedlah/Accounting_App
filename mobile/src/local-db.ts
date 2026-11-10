import * as SQLite from "expo-sqlite";
import type { SQLiteBindValue } from "expo-sqlite";

export type QueuedRequest = {
  id: string;
  method: string;
  path: string;
  body: string;
  createdAt: string;
  status: "pending" | "failed";
  error: string | null;
};

export type CloudChange = {
  id: number;
  table: string;
  recordId: string;
  operation: "insert" | "update" | "delete" | string;
  payload: unknown;
  changedAt?: string | null;
  deviceId?: string | null;
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let schemaPromise: Promise<void> | null = null;
let activeScope = "";

function scopedCacheKey(key: string): string {
  return activeScope ? `${activeScope}|${key}` : key;
}

async function database(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) databasePromise = SQLite.openDatabaseAsync("hisab-mobile.db");
  const db = await databasePromise;
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.execAsync(`
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
      CREATE TABLE IF NOT EXISTS sync_records (
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload TEXT,
        change_id INTEGER NOT NULL DEFAULT 0,
        changed_at TEXT,
        device_id TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (table_name, record_id)
      );
      CREATE TABLE IF NOT EXISTS sync_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_scope_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scoped_sync_meta (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE IF NOT EXISTS scoped_sync_records (
        scope TEXT NOT NULL,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload TEXT,
        change_id INTEGER NOT NULL DEFAULT 0,
        changed_at TEXT,
        device_id TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, table_name, record_id)
      );
    `);
      const outboxColumns = await db.getAllAsync<{ name: string }>("PRAGMA table_info(outbox)");
      if (!outboxColumns.some((column) => column.name === "scope")) {
        await db.execAsync("ALTER TABLE outbox ADD COLUMN scope TEXT NOT NULL DEFAULT ''");
      }
    })();
  }
  await schemaPromise;
  return db;
}

/**
 * Keep local cache, sync state, and queued writes isolated per business/user.
 * Rows from the app's earlier unscoped schema are copied once to the first
 * authenticated account; the source rows are retained for rollback safety.
 */
export async function setLocalScope(session: { businessId: string; userId: string } | null): Promise<void> {
  const nextScope = session
    ? `${session.businessId.trim()}:${session.userId.trim()}`
    : "";
  if (!nextScope || nextScope.endsWith(":")) {
    activeScope = "";
    return;
  }
  if (activeScope === nextScope) return;

  const db = await database();
  const migration = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM local_scope_meta WHERE key = 'legacy_scope_claimed'",
  );
  if (!migration) {
    await db.withTransactionAsync(async () => {
      const oldCaches = await db.getAllAsync<{ cache_key: string; value: string; updated_at: string }>(
        "SELECT cache_key, value, updated_at FROM cached_responses WHERE cache_key NOT LIKE '%|%'",
      );
      for (const row of oldCaches) {
        await db.runAsync(
          `INSERT OR IGNORE INTO cached_responses (cache_key, value, updated_at) VALUES (?, ?, ?)`,
          `${nextScope}|${row.cache_key}`,
          row.value,
          row.updated_at,
        );
      }

      await db.runAsync("UPDATE outbox SET scope = ? WHERE scope = ''", nextScope);
      const oldRecords = await db.getAllAsync<{
        table_name: string; record_id: string; operation: string; payload: string | null;
        change_id: number; changed_at: string | null; device_id: string | null; deleted: number; updated_at: string;
      }>("SELECT * FROM sync_records");
      for (const row of oldRecords) {
        await db.runAsync(
          `INSERT OR IGNORE INTO scoped_sync_records
            (scope, table_name, record_id, operation, payload, change_id, changed_at, device_id, deleted, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          nextScope,
          row.table_name,
          row.record_id,
          row.operation,
          row.payload,
          row.change_id,
          row.changed_at,
          row.device_id,
          row.deleted,
          row.updated_at,
        );
      }
      const oldMeta = await db.getAllAsync<{ key: string; value: string | null; updated_at: string }>(
        "SELECT key, value, updated_at FROM sync_meta",
      );
      for (const row of oldMeta) {
        await db.runAsync(
          `INSERT OR IGNORE INTO scoped_sync_meta (scope, key, value, updated_at) VALUES (?, ?, ?, ?)`,
          nextScope,
          row.key,
          row.value,
          row.updated_at,
        );
      }
      await db.runAsync(
        "INSERT INTO local_scope_meta (key, value) VALUES ('legacy_scope_claimed', ?) ON CONFLICT(key) DO NOTHING",
        nextScope,
      );
    });
  }
  activeScope = nextScope;
}

export async function writeCache(key: string, value: unknown): Promise<void> {
  const db = await database();
  await db.runAsync(
    `INSERT INTO cached_responses (cache_key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    scopedCacheKey(key),
    JSON.stringify(value),
    new Date().toISOString(),
  );
}

export async function readCache<T>(key: string): Promise<{ value: T; updatedAt: string } | null> {
  const db = await database();
  const row = await db.getFirstAsync<{ value: string; updated_at: string }>(
    "SELECT value, updated_at FROM cached_responses WHERE cache_key = ?",
    scopedCacheKey(key),
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
    `INSERT OR IGNORE INTO outbox (id, method, path, body, created_at, status, error, scope)
     VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?)`,
    input.id,
    input.method,
    input.path,
    JSON.stringify(input.body),
    new Date().toISOString(),
    activeScope,
  );
}

export async function listQueuedRequests(): Promise<QueuedRequest[]> {
  const db = await database();
  return db.getAllAsync<QueuedRequest>(
    "SELECT id, method, path, body, created_at AS createdAt, status, error FROM outbox WHERE scope = ? ORDER BY created_at",
    activeScope,
  );
}

export async function pendingRequestCount(): Promise<number> {
  const db = await database();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM outbox WHERE scope = ? AND status IN ('pending', 'failed')",
    activeScope,
  );
  return row?.count ?? 0;
}

export async function removeQueuedRequest(id: string): Promise<void> {
  const db = await database();
  await db.runAsync("DELETE FROM outbox WHERE id = ? AND scope = ?", id, activeScope);
}

export async function markQueuedRequestFailed(id: string, error: string): Promise<void> {
  const db = await database();
  await db.runAsync(
    "UPDATE outbox SET status = 'failed', error = ? WHERE id = ? AND scope = ?",
    error,
    id,
    activeScope,
  );
}

export async function retryFailedRequests(): Promise<void> {
  const db = await database();
  await db.runAsync(
    "UPDATE outbox SET status = 'pending', error = NULL WHERE scope = ? AND status = 'failed'",
    activeScope,
  );
}

export async function getSyncMeta(key: string): Promise<string | null> {
  const db = await database();
  const row = await db.getFirstAsync<{ value: string | null }>(
    "SELECT value FROM scoped_sync_meta WHERE scope = ? AND key = ?",
    activeScope,
    key,
  );
  return row?.value ?? null;
}

export async function setSyncMeta(key: string, value: string | null): Promise<void> {
  const db = await database();
  await db.runAsync(
    `INSERT INTO scoped_sync_meta (scope, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    activeScope,
    key,
    value,
    new Date().toISOString(),
  );
}

export async function getPullCursor(): Promise<number> {
  return Number.parseInt((await getSyncMeta("pull_cursor")) ?? "0", 10) || 0;
}

export async function setPullCursor(value: number): Promise<void> {
  await setSyncMeta("pull_cursor", String(Math.max(0, Math.floor(value))));
}

/**
 * Applies server changes to the local mirror. Rows are ordered by the
 * monotonic change id, so replaying a page is idempotent and an older change
 * can never overwrite a newer one.
 */
export async function applyCloudChanges(
  changes: CloudChange[],
): Promise<{ applied: number; conflicts: number }> {
  if (changes.length === 0) return { applied: 0, conflicts: 0 };
  const db = await database();
  let applied = 0;
  let conflicts = 0;
  await db.withTransactionAsync(async () => {
    for (const change of changes) {
      if (!change.table || !change.recordId) continue;
      const existing = await db.getFirstAsync<{ change_id: number }>(
        "SELECT change_id FROM scoped_sync_records WHERE scope = ? AND table_name = ? AND record_id = ?",
        activeScope,
        change.table,
        change.recordId,
      );
      if (existing && existing.change_id > change.id) continue;
      const pending = await db.getFirstAsync<{ id: string }>(
        "SELECT id FROM outbox WHERE scope = ? AND status IN ('pending', 'failed') AND body LIKE ? LIMIT 1",
        activeScope,
        `%${change.recordId}%`,
      );
      if (pending) {
        conflicts += 1;
        // Keep the local operation authoritative until it is pushed.
        continue;
      }
      await db.runAsync(
        `INSERT INTO scoped_sync_records
           (scope, table_name, record_id, operation, payload, change_id, changed_at, device_id, deleted, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, table_name, record_id) DO UPDATE SET
           operation = excluded.operation,
           payload = excluded.payload,
           change_id = excluded.change_id,
           changed_at = excluded.changed_at,
           device_id = excluded.device_id,
           deleted = excluded.deleted,
           updated_at = excluded.updated_at`,
        activeScope,
        change.table,
        change.recordId,
        change.operation,
        change.payload === undefined ? null : JSON.stringify(change.payload),
        change.id,
        change.changedAt ?? null,
        change.deviceId ?? null,
        change.operation === "delete" ? 1 : 0,
        new Date().toISOString(),
      );
      applied += 1;
    }
    await setSyncMeta("last_pull_at", new Date().toISOString());
  });
  return { applied, conflicts };
}

export async function clearCloudRecords(): Promise<void> {
  const db = await database();
  await db.runAsync("DELETE FROM scoped_sync_records WHERE scope = ?", activeScope);
}

export async function listCachedApiPaths(): Promise<string[]> {
  const db = await database();
  const rows = await db.getAllAsync<{ cache_key: string }>(
    "SELECT cache_key FROM cached_responses WHERE cache_key LIKE ? ORDER BY cache_key",
    `${activeScope}|/api/%`,
  );
  return rows.map((row) => row.cache_key.slice(activeScope.length + 1));
}

const BACKUP_TABLES = [
  "cached_responses", "outbox", "sync_records", "sync_meta",
  "scoped_sync_meta", "scoped_sync_records", "local_scope_meta",
] as const;
const REQUIRED_BACKUP_TABLES = ["cached_responses", "outbox", "sync_records", "sync_meta"] as const;
const RESTORE_TABLES = [
  "cached_responses", "outbox", "sync_records", "sync_meta",
  "scoped_sync_meta", "scoped_sync_records",
] as const;

/** Return a consistent SQLite snapshot for local backup/export. */
export async function serializeLocalDatabase(): Promise<Uint8Array> {
  if (!activeScope) throw new Error("سجّل الدخول أولاً لإنشاء نسخة لهذا الحساب.");
  const db = await database();
  const snapshot = await db.serializeAsync();
  const backup = await SQLite.deserializeDatabaseAsync(snapshot);
  try {
    await backup.withTransactionAsync(async () => {
      await backup.runAsync("DELETE FROM cached_responses WHERE cache_key NOT LIKE ?", `${activeScope}|%`);
      await backup.runAsync("DELETE FROM outbox WHERE scope <> ?", activeScope);
      await backup.runAsync("DELETE FROM sync_records");
      await backup.runAsync("DELETE FROM sync_meta");
      await backup.runAsync("DELETE FROM scoped_sync_records WHERE scope <> ?", activeScope);
      await backup.runAsync("DELETE FROM scoped_sync_meta WHERE scope <> ?", activeScope);
      await backup.runAsync("DELETE FROM local_scope_meta");
      await backup.runAsync(
        "INSERT INTO local_scope_meta (key, value) VALUES ('backup_scope', ?)",
        activeScope,
      );
      await backup.execAsync(`CREATE TABLE IF NOT EXISTS backup_scope (scope TEXT NOT NULL)`);
      await backup.runAsync("DELETE FROM backup_scope");
      await backup.runAsync("INSERT INTO backup_scope (scope) VALUES (?)", activeScope);
    });
    return await backup.serializeAsync();
  } finally {
    await backup.closeAsync();
  }
}

/**
 * Restore a snapshot created by this app. The incoming SQLite file is opened
 * in memory and validated first; only then are the app's existing rows
 * replaced in a single transaction. A failed insert rolls the whole restore
 * back, and the caller creates a safety copy before invoking this function.
 */
export async function restoreLocalDatabase(serialized: Uint8Array): Promise<void> {
  const source = await SQLite.deserializeDatabaseAsync(serialized);
  try {
    const integrity = await source.getFirstAsync<{ integrity_check: string }>("PRAGMA integrity_check");
    if (integrity?.integrity_check !== "ok") throw new Error("ملف النسخة غير سليم.");

    const tables = await source.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    const tableSet = new Set(tables.map((table) => table.name));
    for (const table of REQUIRED_BACKUP_TABLES) {
      if (!tableSet.has(table)) throw new Error("النسخة لا تخص تطبيق حساب أو لا تحتوي قاعدة البيانات كاملة.");
    }
    if (!tableSet.has("backup_scope")) throw new Error("النسخة قديمة أو لا تحتوي نطاق الحساب.");
    const backupScope = await source.getFirstAsync<{ scope: string }>("SELECT scope FROM backup_scope LIMIT 1");
    if (!backupScope?.scope || backupScope.scope !== activeScope) {
      throw new Error("هذه النسخة تخص حساباً آخر. سجّل الدخول بالحساب الذي أنشأها ثم أعد المحاولة.");
    }

    const snapshots = new Map<string, Array<Record<string, unknown>>>();
    for (const table of BACKUP_TABLES) {
      snapshots.set(
        table,
        tableSet.has(table)
          ? await source.getAllAsync<Record<string, unknown>>(`SELECT * FROM "${table}"`)
          : [],
      );
    }

    const target = await database();
    await target.withTransactionAsync(async () => {
      for (const table of RESTORE_TABLES) {
        if (table === "cached_responses") {
          await target.runAsync("DELETE FROM cached_responses WHERE cache_key LIKE ?", `${activeScope}|%`);
        } else if (table === "outbox") {
          await target.runAsync("DELETE FROM outbox WHERE scope = ?", activeScope);
        } else if (table === "scoped_sync_meta" || table === "scoped_sync_records") {
          await target.runAsync(`DELETE FROM "${table}" WHERE scope = ?`, activeScope);
        } else {
          continue;
        }
        const rows = snapshots.get(table) ?? [];
        for (const row of rows) {
          const columns = Object.keys(row);
          if (columns.length === 0) continue;
          const placeholders = columns.map(() => "?").join(", ");
          const values = columns.map((column) => {
            const value = row[column];
            if (value === undefined || value === null) return null;
            if (typeof value === "string" || typeof value === "number") return value;
            if (typeof value === "boolean") return value ? 1 : 0;
            if (value instanceof Uint8Array) return value;
            return JSON.stringify(value);
          });
          await target.runAsync(
            `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${placeholders})`,
            ...(values as SQLiteBindValue[]),
          );
        }
      }
    });
  } finally {
    await source.closeAsync();
  }
}

/** Import the scoped JSON backups produced by the existing Flutter version. */
export async function restoreFlutterJsonBackup(payload: unknown): Promise<void> {
  if (!isPlainRecord(payload) || payload.format !== "hisab-mobile-backup" ||
      (payload.version !== 1 && payload.version !== 2) ||
      !Array.isArray(payload.cache) || !Array.isArray(payload.outbox)) {
    throw new Error("ملف النسخة غير صالح أو غير مدعوم.");
  }
  if (!activeScope) throw new Error("سجّل الدخول بالحساب المطلوب قبل استعادة النسخة.");
  const payloadScope = typeof payload.scope === "string" ? payload.scope : "";
  if (payloadScope && payloadScope !== activeScope) {
    throw new Error("هذه النسخة تخص حساباً آخر. سجّل الدخول بالحساب الذي أنشأها ثم أعد المحاولة.");
  }

  const db = await database();
  await db.withTransactionAsync(async () => {
    await db.runAsync("DELETE FROM cached_responses WHERE cache_key LIKE ?", `${activeScope}|%`);
    await db.runAsync("DELETE FROM outbox WHERE scope = ?", activeScope);
    await db.runAsync("DELETE FROM scoped_sync_records WHERE scope = ?", activeScope);
    await db.runAsync("DELETE FROM scoped_sync_meta WHERE scope = ?", activeScope);

    for (const raw of payload.cache as unknown[]) {
      if (!isPlainRecord(raw)) continue;
      const rawKey = typeof raw.cache_key === "string" ? raw.cache_key : "";
      if (!rawKey) continue;
      const keyScopePrefix = `${payloadScope}|`;
      const key = payloadScope && rawKey.startsWith(keyScopePrefix)
        ? rawKey
        : rawKey.includes("|")
          ? null
          : `${activeScope}|${rawKey}`;
      if (!key) throw new Error("ملف النسخة يحتوي بيانات مخزنة لحساب مختلف.");
      const value = typeof raw.value === "string" ? raw.value : JSON.stringify(raw.value);
      await db.runAsync(
        "INSERT OR REPLACE INTO cached_responses (cache_key, value, updated_at) VALUES (?, ?, ?)",
        key,
        value,
        typeof raw.updated_at === "string" ? raw.updated_at : new Date().toISOString(),
      );
    }

    for (const raw of payload.outbox as unknown[]) {
      if (!isPlainRecord(raw) || typeof raw.id !== "string" || typeof raw.path !== "string") continue;
      await db.runAsync(
        `INSERT OR REPLACE INTO outbox (id, method, path, body, created_at, status, error, scope)
         VALUES (?, 'POST', ?, ?, ?, ?, ?, ?)`,
        raw.id,
        raw.path,
        JSON.stringify(raw.body ?? {}),
        typeof raw.created_at === "string" ? raw.created_at : new Date().toISOString(),
        raw.status === "failed" ? "failed" : "pending",
        typeof raw.error === "string" ? raw.error : null,
        activeScope,
      );
    }

    for (const raw of (Array.isArray(payload.syncRecords) ? payload.syncRecords : []) as unknown[]) {
      if (!isPlainRecord(raw) || typeof raw.table_name !== "string" || typeof raw.record_id !== "string") continue;
      await db.runAsync(
        `INSERT OR REPLACE INTO scoped_sync_records
          (scope, table_name, record_id, operation, payload, change_id, changed_at, device_id, deleted, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        activeScope,
        raw.table_name,
        raw.record_id,
        typeof raw.operation === "string" ? raw.operation : "update",
        raw.payload == null ? null : JSON.stringify(raw.payload),
        typeof raw.change_id === "number" ? raw.change_id : 0,
        typeof raw.changed_at === "string" ? raw.changed_at : null,
        typeof raw.device_id === "string" ? raw.device_id : null,
        raw.deleted === true || raw.deleted === 1 ? 1 : 0,
        typeof raw.updated_at === "string" ? raw.updated_at : new Date().toISOString(),
      );
    }

    for (const raw of (Array.isArray(payload.syncMeta) ? payload.syncMeta : []) as unknown[]) {
      if (!isPlainRecord(raw) || typeof raw.key !== "string") continue;
      await db.runAsync(
        `INSERT OR REPLACE INTO scoped_sync_meta (scope, key, value, updated_at) VALUES (?, ?, ?, ?)`,
        activeScope,
        raw.key,
        raw.value == null ? null : String(raw.value),
        typeof raw.updated_at === "string" ? raw.updated_at : new Date().toISOString(),
      );
    }
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
