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

async function createRuntime(): Promise<Runtime> {
  const url = process.env.DATABASE_URL?.trim();

  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const caPath = process.env.SUPABASE_CA_CERT_PATH?.trim();
    const isSupabase = /supabase\.(co|com)/i.test(url);
    let connectionString = url;
    let ssl: Pool["options"]["ssl"];
    if (isSupabase) {
      if (!caPath) {
        throw new Error("اضبط SUPABASE_CA_CERT_PATH إلى ملف شهادة Supabase CA قبل الاتصال.");
      }
      const parsedUrl = new URL(url);
      parsedUrl.searchParams.delete("sslmode");
      connectionString = parsedUrl.toString();
      ssl = {
        ca: fs.readFileSync(path.resolve(process.cwd(), caPath), "utf8"),
        rejectUnauthorized: true,
      };
    }
    const pool = new Pool({ connectionString, max: 10, ...(ssl ? { ssl } : {}) });
    const db = drizzleNode(pool, { schema });
    await migrateNode(db, { migrationsFolder: MIGRATIONS });
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
    globalThis.__hisab_runtime = createRuntime();
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
  if (globalThis.__hisab_runtime) {
    const runtime = await globalThis.__hisab_runtime;
    await runtime.close();
    globalThis.__hisab_runtime = undefined;
  }
}
