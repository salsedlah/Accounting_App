import path from "node:path";
import fs from "node:fs";
import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migrateNode } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import * as schema from "@/db/schema";

export type DB = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

type Runtime = {
  db: DB;
  close: () => Promise<void>;
  kind: "postgres" | "pglite";
};

declare global {
  // eslint-disable-next-line no-var
  var __hisab_runtime: Promise<Runtime> | undefined;
}

const MIGRATIONS = path.join(process.cwd(), "drizzle");

/**
 * Drizzle's migrator takes no lock, so several lambdas cold-starting at once
 * can race each other on the same pending migration and one of them fails with
 * "relation already exists". Retry with a backoff so the losing request still
 * succeeds instead of surfacing a 500.
 */
async function runMigrations(db: NodePgDatabase<typeof schema>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await migrateNode(db, { migrationsFolder: MIGRATIONS });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function createRuntime(): Promise<Runtime> {
  const url = process.env.DATABASE_URL?.trim();

  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const caPath = process.env.SUPABASE_CA_CERT_PATH?.trim();
    const caInline = process.env.SUPABASE_CA_CERT?.trim();
    const isSupabase = /supabase\.(co|com)/i.test(url);
    let connectionString = url;
    let ssl: Pool["options"]["ssl"];
    if (isSupabase) {
      const ca = caInline
        ? caInline.replace(/\\n/g, "\n")
        : caPath
          ? fs.readFileSync(path.resolve(process.cwd(), caPath), "utf8")
          : "";
      if (!ca) {
        throw new Error("اضبط SUPABASE_CA_CERT أو SUPABASE_CA_CERT_PATH إلى شهادة Supabase CA قبل الاتصال.");
      }
      const parsedUrl = new URL(url);
      parsedUrl.searchParams.delete("sslmode");
      connectionString = parsedUrl.toString();
      ssl = {
        ca,
        rejectUnauthorized: true,
      };
    }
    const pool = new Pool({ connectionString, max: 10, ...(ssl ? { ssl } : {}) });
    const db = drizzleNode(pool, { schema });
    await runMigrations(db);
    return {
      db,
      kind: "postgres",
      close: async () => {
        await pool.end();
      },
    };
  }

  const dataDir = url?.startsWith("file:") ? url.slice(5) : path.join(process.cwd(), "data", "pg");
  const client = new PGlite(dataDir);
  await client.waitReady;
  const db = drizzlePglite(client, { schema }) as unknown as DB;
  await migratePglite(db as never, { migrationsFolder: MIGRATIONS });
  return {
    db,
    kind: "pglite",
    close: async () => {
      await client.close();
    },
  };
}

export function getRuntime(): Promise<Runtime> {
  if (!globalThis.__hisab_runtime) {
    const pending = createRuntime().catch((error) => {
      // A cold-start failure (migration lock, transient pooler error) must not
      // poison this instance for its whole lifetime: drop the cached promise so
      // the next request retries from scratch.
      if (globalThis.__hisab_runtime === pending) {
        globalThis.__hisab_runtime = undefined;
      }
      throw error;
    });
    globalThis.__hisab_runtime = pending;
  }
  return globalThis.__hisab_runtime;
}

export async function getDb(): Promise<DB> {
  return (await getRuntime()).db;
}

export async function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const db = await getDb();
  return db.transaction(fn);
}

export async function closeDb(): Promise<void> {
  const pending = globalThis.__hisab_runtime;
  // Readiness and seed are bound to the runtime/database that produced them.
  // Clearing them prevents a later database (for example a test file or an
  // embedded switch) from inheriting a resolved promise with no seeded rows.
  globalThis.__hisab_ready = undefined;
  globalThis.__hisab_seed = undefined;
  if (pending) {
    globalThis.__hisab_runtime = undefined;
    const runtime = await pending.catch(() => undefined);
    if (runtime) await runtime.close();
  }
}
