import { getTableName, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { Tx } from "@/db/client";
import * as dbSchema from "@/db/schema";
import { AppError } from "@/server/api";

const APP_TABLES = [
  dbSchema.businesses, dbSchema.users, dbSchema.roles, dbSchema.permissions,
  dbSchema.rolePermissions, dbSchema.memberships, dbSchema.warehouses, dbSchema.units,
  dbSchema.productCategories, dbSchema.suppliers, dbSchema.customers, dbSchema.products,
  dbSchema.productUnits, dbSchema.unitConversions, dbSchema.inventoryMovements,
  dbSchema.inventoryBalances, dbSchema.inventoryLots, dbSchema.stockTransfers,
  dbSchema.stocktakingSessions, dbSchema.stocktakingItems, dbSchema.sales, dbSchema.saleItems,
  dbSchema.purchases, dbSchema.purchaseItems, dbSchema.payments, dbSchema.customerAccounts,
  dbSchema.supplierAccounts, dbSchema.cashboxes, dbSchema.cashTransactions, dbSchema.expenses,
  dbSchema.accounts, dbSchema.journalEntries, dbSchema.journalLines, dbSchema.invoiceSequences,
  dbSchema.auditLogs, dbSchema.syncOperations, dbSchema.notificationEvents,
] as const;

function serialize(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

export async function createDatabaseBackup(tx: Tx) {
  importOrder();
  const data: Record<string, unknown[]> = {};
  for (const table of APP_TABLES) {
    data[getTableName(table)] = await tx.select().from(table as never) as unknown[];
  }
  return {
    format: "hisab-database-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    tables: JSON.parse(JSON.stringify(data, serialize)) as Record<string, unknown[]>,
  };
}

function importOrder() {
  type AppTable = (typeof APP_TABLES)[number];
  const pending = new Map<string, AppTable>();
  for (const table of APP_TABLES) pending.set(getTableName(table), table);
  const dependencies = new Map<string, Set<string>>();
  for (const [name, table] of pending) {
    const parents = new Set<string>();
    for (const foreignKey of getTableConfig(table).foreignKeys) {
      const parent = getTableName(foreignKey.reference().foreignTable);
      if (pending.has(parent)) parents.add(parent);
    }
    dependencies.set(name, parents);
  }
  const order: (typeof APP_TABLES)[number][] = [];
  while (pending.size) {
    const ready = [...pending.keys()].filter((name) =>
      [...(dependencies.get(name) ?? [])].every((parent) => !pending.has(parent)),
    );
    if (!ready.length) throw new AppError("تعذر تحديد ترتيب استعادة الجداول.");
    for (const name of ready) {
      order.push(pending.get(name)!);
      pending.delete(name);
    }
  }
  return order;
}

export async function restoreDatabaseBackup(tx: Tx, raw: unknown) {
  if (!raw || typeof raw !== "object") throw new AppError("ملف النسخة الاحتياطية غير صالح");
  const backup = raw as { format?: unknown; version?: unknown; tables?: unknown };
  if (backup.format !== "hisab-database-backup" || backup.version !== 1 || !backup.tables || typeof backup.tables !== "object") {
    throw new AppError("صيغة النسخة الاحتياطية غير مدعومة");
  }
  const tables = backup.tables as Record<string, unknown>;
  const expected = APP_TABLES.map(getTableName);
  if (expected.some((name) => !Array.isArray(tables[name]))) {
    throw new AppError("النسخة غير مكتملة؛ لم يتم تغيير قاعدة البيانات");
  }
  for (const name of Object.keys(tables)) {
    if (!expected.includes(name as (typeof expected)[number])) {
      throw new AppError("تحتوي النسخة على جداول غير معروفة؛ لم يتم تغيير قاعدة البيانات");
    }
  }

  const quoted = expected.map((name) => `public."${name}"`).join(", ");
  await tx.execute(sql.raw(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`));
  for (const table of importOrder()) {
    const name = getTableName(table);
    const rows = tables[name] as Record<string, unknown>[];
    if (!rows.length) continue;
    await tx.insert(table as never).values(rows as never);
  }
  return {
    restoredTables: expected.length,
    restoredRows: expected.reduce((sum, name) => sum + (tables[name] as unknown[]).length, 0),
  };
}
