import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";

try {
  process.loadEnvFile?.(".env");
} catch {
  /* The environment may already be configured by the caller. */
}

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, normalize(nested)]),
    );
  }
  return value;
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error("Unexpected database identifier");
  return `"${value}"`;
}

async function main() {
  const connectionString = process.env.DATABASE_URL?.trim();
  const caPath = process.env.SUPABASE_CA_CERT_PATH?.trim();
  if (!connectionString || !/^postgres(ql)?:\/\//i.test(connectionString)) {
    throw new Error("DATABASE_URL must point to the Supabase PostgreSQL database.");
  }
  if (!caPath) throw new Error("SUPABASE_CA_CERT_PATH must point to the Supabase CA certificate.");

  const parsed = new URL(connectionString);
  if (!/supabase\.(co|com)$/i.test(parsed.hostname)) {
    throw new Error("This import is restricted to a Supabase database URL.");
  }
  parsed.searchParams.delete("sslmode");

  const local = new PGlite(path.resolve(process.cwd(), "data", "pg"));
  const remote = new Client({
    connectionString: parsed.toString(),
    ssl: {
      ca: fs.readFileSync(path.resolve(process.cwd(), caPath), "utf8"),
      rejectUnauthorized: true,
    },
    connectionTimeoutMillis: 15_000,
  });

  try {
    await local.waitReady;
    await remote.connect();

    const localTablesResult = await local.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name",
    );
    const remoteTablesResult = await remote.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name",
    );
    const localTables = localTablesResult.rows.map((row) => row.table_name);
    const remoteTables = new Set(remoteTablesResult.rows.map((row) => row.table_name));
    const missing = localTables.filter((table) => !remoteTables.has(table));
    if (missing.length) throw new Error(`Remote schema is missing ${missing.length} application tables.`);

    for (const table of localTables) {
      const result = await remote.query<{ count: string }>(
        `select count(*)::text as count from public.${identifier(table)}`,
      );
      if (BigInt(result.rows[0].count) !== 0n) {
        throw new Error("Import stopped: Supabase already contains application rows; refusing to merge or overwrite.");
      }
    }

    const dependencies = new Map(localTables.map((table) => [table, new Set<string>()]));
    const foreignKeys = await remote.query<{ child: string; parent: string }>(
      `select child.relname as child, parent.relname as parent
       from pg_constraint fk
       join pg_class child on child.oid = fk.conrelid
       join pg_namespace child_ns on child_ns.oid = child.relnamespace
       join pg_class parent on parent.oid = fk.confrelid
       join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
       where fk.contype = 'f' and child_ns.nspname = 'public' and parent_ns.nspname = 'public'`,
    );
    for (const { child, parent } of foreignKeys.rows) dependencies.get(child)?.add(parent);

    const order: string[] = [];
    const remaining = new Set(localTables);
    while (remaining.size) {
      const ready = [...remaining].filter(
        (table) => [...(dependencies.get(table) ?? [])].every((parent) => !remaining.has(parent)),
      );
      if (!ready.length) throw new Error("Import stopped: application tables have a foreign-key cycle.");
      for (const table of ready) {
        order.push(table);
        remaining.delete(table);
      }
    }

    const rowsByTable = new Map<string, Record<string, unknown>[]>();
    let totalRows = 0;
    for (const table of order) {
      const result = await local.query<Record<string, unknown>>(`select * from public.${identifier(table)}`);
      const rows = result.rows;
      rowsByTable.set(table, rows);
      totalRows += rows.length;
    }

    await remote.query("begin");
    try {
      for (const table of order) {
        const rows = rowsByTable.get(table) ?? [];
        if (!rows.length) continue;
        const columns = Object.keys(rows[0]);
        const columnSql = columns.map(identifier).join(", ");
        for (const row of rows) {
          const values = columns.map((column) => normalize(row[column]));
          const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
          await remote.query(
            `insert into public.${identifier(table)} (${columnSql}) values (${placeholders})`,
            values,
          );
        }
      }
      await remote.query("commit");
    } catch (error) {
      await remote.query("rollback");
      throw error;
    }

    console.log(`Imported ${totalRows} rows across ${order.length} tables. The local database was left unchanged.`);
  } finally {
    await Promise.all([local.close(), remote.end().catch(() => undefined)]);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Import failed.");
  process.exitCode = 1;
});
