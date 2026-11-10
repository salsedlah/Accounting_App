import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type { Tx } from "@/db/client";
import * as schema from "@/db/schema";
import {
  accounts,
  auditLogs,
  businessFeatureOverrides,
  businesses,
  businessSubscriptions,
  cashTransactions,
  cashboxes,
  cloudBackups,
  cloudBackupSettings,
  customerAccounts,
  customers,
  expenses,
  inventoryBalances,
  inventoryLots,
  inventoryMovements,
  invoiceSequences,
  journalEntries,
  journalLines,
  memberships,
  notificationEvents,
  payments,
  productCategories,
  productUnits,
  products,
  purchaseItems,
  purchases,
  rolePermissions,
  roles,
  saleItems,
  sales,
  stockTransfers,
  stocktakingItems,
  stocktakingSessions,
  subscriptionHistory,
  subscriptionPayments,
  suppliers,
  supplierAccounts,
  units,
  users,
  unitConversions,
  warehouses,
} from "@/db/schema";
import { AppError, serializeBigInts } from "@/server/api";
import type { Session } from "@/server/auth";
import { cloudUserId } from "./cloud-sync";
import { downloadBackupObject, uploadBackupObject } from "@/server/supabase";

export const BUSINESS_BACKUP_FORMAT = "hisab-business-backup";
export const BUSINESS_BACKUP_VERSION = 1;

type Row = Record<string, unknown>;
type BackupData = {
  format: string;
  version: number;
  businessId: string;
  createdAt: string;
  tables: Record<string, Row[]>;
  metadata: Record<string, unknown>;
};

/** Tables that carry `business_id` and belong entirely to one business. */
const SCOPED_TABLES = [
  businessSubscriptions,
  businessFeatureOverrides,
  subscriptionPayments,
  subscriptionHistory,
  roles,
  memberships,
  warehouses,
  units,
  productCategories,
  suppliers,
  customers,
  cashboxes,
  accounts,
  products,
  inventoryMovements,
  inventoryBalances,
  inventoryLots,
  stockTransfers,
  stocktakingSessions,
  sales,
  purchases,
  payments,
  customerAccounts,
  supplierAccounts,
  cashTransactions,
  expenses,
  journalEntries,
  invoiceSequences,
  auditLogs,
  notificationEvents,
] as const;

type ChildSpec = {
  table: PgTable;
  parent: PgTable;
  foreignKey: unknown;
  parentKey: unknown;
  businessKey: unknown;
};

const CHILD_TABLES: ChildSpec[] = [
  { table: rolePermissions, parent: roles, foreignKey: rolePermissions.roleId, parentKey: roles.id, businessKey: roles.businessId },
  { table: productUnits, parent: products, foreignKey: productUnits.productId, parentKey: products.id, businessKey: products.businessId },
  { table: unitConversions, parent: products, foreignKey: unitConversions.productId, parentKey: products.id, businessKey: products.businessId },
  { table: stocktakingItems, parent: stocktakingSessions, foreignKey: stocktakingItems.sessionId, parentKey: stocktakingSessions.id, businessKey: stocktakingSessions.businessId },
  { table: saleItems, parent: sales, foreignKey: saleItems.saleId, parentKey: sales.id, businessKey: sales.businessId },
  { table: purchaseItems, parent: purchases, foreignKey: purchaseItems.purchaseId, parentKey: purchases.id, businessKey: purchases.businessId },
  { table: journalLines, parent: journalEntries, foreignKey: journalLines.entryId, parentKey: journalEntries.id, businessKey: journalEntries.businessId },
];

/** Dependency-safe order used when inserting a restored business. */
const INSERT_ORDER: PgTable[] = [
  businessSubscriptions,
  businessFeatureOverrides,
  subscriptionPayments,
  subscriptionHistory,
  roles,
  rolePermissions,
  memberships,
  warehouses,
  units,
  productCategories,
  suppliers,
  customers,
  cashboxes,
  accounts,
  products,
  productUnits,
  unitConversions,
  inventoryMovements,
  inventoryBalances,
  inventoryLots,
  stockTransfers,
  stocktakingSessions,
  stocktakingItems,
  sales,
  saleItems,
  purchases,
  purchaseItems,
  payments,
  customerAccounts,
  supplierAccounts,
  cashTransactions,
  expenses,
  journalEntries,
  journalLines,
  invoiceSequences,
  auditLogs,
  notificationEvents,
];

/** Reverse dependency order used before inserting restored rows. */
const DELETE_ORDER: PgTable[] = [
  notificationEvents,
  auditLogs,
  invoiceSequences,
  journalEntries,
  expenses,
  cashTransactions,
  supplierAccounts,
  customerAccounts,
  payments,
  purchases,
  sales,
  stocktakingSessions,
  stockTransfers,
  inventoryLots,
  inventoryBalances,
  inventoryMovements,
  products,
  customers,
  suppliers,
  productCategories,
  units,
  warehouses,
  accounts,
  cashboxes,
  memberships,
  roles,
  subscriptionHistory,
  subscriptionPayments,
  businessFeatureOverrides,
  businessSubscriptions,
];

function tableName(table: PgTable): string {
  return getTableConfig(table).name;
}

function businessColumn(table: PgTable): unknown {
  const column = (table as unknown as Record<string, unknown>).businessId;
  if (!column) throw new AppError(`الجدول ${tableName(table)} لا يحتوي business_id`);
  return column;
}

/** Deterministic JSON with sorted object keys, used for checksums. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function checksumOf(data: unknown): string {
  return createHash("sha256").update(stableStringify(data)).digest("hex");
}

/**
 * Checksum of the durable backup content. `createdAt` and other volatile
 * fields are excluded so re-collecting an unchanged business produces the same
 * checksum, which is what makes duplicate detection work.
 */
export function backupChecksum(data: BackupData): string {
  return checksumOf({
    format: data.format,
    version: data.version,
    businessId: data.businessId,
    tables: data.tables,
  });
}

async function selectScoped(tx: Tx, table: PgTable, businessId: string): Promise<Row[]> {
  return (await tx
    .select()
    .from(table as never)
    .where(eq(businessColumn(table) as never, businessId))) as unknown as Row[];
}

async function selectChild(tx: Tx, spec: ChildSpec, businessId: string): Promise<Row[]> {
  const parents = (await tx
    .select({ id: spec.parentKey as never })
    .from(spec.parent as never)
    .where(eq(spec.businessKey as never, businessId))) as unknown as Array<{ id: string }>;
  if (!parents.length) return [];
  return (await tx
    .select()
    .from(spec.table as never)
    .where(inArray(spec.foreignKey as never, parents.map((row) => row.id)))) as unknown as Row[];
}

async function selectUsers(tx: Tx, businessId: string): Promise<Row[]> {
  const rows = await tx
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      isActive: users.isActive,
      createdAt: users.createdAt,
    })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(eq(memberships.businessId, businessId));
  const unique = new Map<string, Row>();
  for (const row of rows) unique.set(row.id, row as unknown as Row);
  return [...unique.values()];
}

export async function collectBusinessData(tx: Tx, businessId: string): Promise<BackupData> {
  const [business] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
  if (!business) throw new AppError("المنشأة غير موجودة", 404);

  const tables: Record<string, Row[]> = { businesses: [business as unknown as Row] };
  const counts: Record<string, number> = {};
  for (const table of SCOPED_TABLES) {
    const rows = await selectScoped(tx, table, businessId);
    tables[tableName(table)] = rows;
    counts[tableName(table)] = rows.length;
  }
  for (const spec of CHILD_TABLES) {
    const rows = await selectChild(tx, spec, businessId);
    tables[tableName(spec.table)] = rows;
    counts[tableName(spec.table)] = rows.length;
  }
  const userRows = await selectUsers(tx, businessId);
  tables.users = userRows;
  counts.users = userRows.length;

  const totalRows = Object.values(tables).reduce((sum, rows) => sum + rows.length, 0);
  return {
    format: BUSINESS_BACKUP_FORMAT,
    version: BUSINESS_BACKUP_VERSION,
    businessId,
    createdAt: new Date().toISOString(),
    tables,
    metadata: {
      businessName: business.name,
      totalRows,
      counts,
      // Never include passwords, password hashes, or auth tokens in a backup.
      excludes: ["users.password_hash", "users.auth_user_id", "auth tokens"],
    },
  };
}

function coerceRow(table: PgTable, raw: Row): Row {
  const row: Row = { ...raw };
  for (const [key, value] of Object.entries(table as unknown as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const column = value as { dataType?: string; columnType?: string };
    if (!column.dataType) continue;
    const current = row[key];
    if (current === null || current === undefined) continue;
    if (column.dataType === "bigint" && typeof current !== "bigint") {
      row[key] = BigInt(String(current));
    } else if (column.dataType === "date" && String(column.columnType).includes("Timestamp") && !(current instanceof Date)) {
      row[key] = new Date(String(current));
    }
  }
  return row;
}

async function insertTableRows(tx: Tx, table: PgTable, rows: Row[] | undefined): Promise<number> {
  if (!rows?.length) return 0;
  const values = rows.map((row) => coerceRow(table, row));
  await tx
    .insert(table as never)
    .values(values as never)
    .onConflictDoNothing();
  return values.length;
}

async function deleteScoped(tx: Tx, table: PgTable, businessId: string): Promise<void> {
  await tx
    .delete(table as never)
    .where(eq(businessColumn(table) as never, businessId));
}

async function deleteChild(tx: Tx, spec: ChildSpec, businessId: string): Promise<void> {
  const parents = (await tx
    .select({ id: spec.parentKey as never })
    .from(spec.parent as never)
    .where(eq(spec.businessKey as never, businessId))) as unknown as Array<{ id: string }>;
  if (!parents.length) return;
  await tx
    .delete(spec.table as never)
    .where(inArray(spec.foreignKey as never, parents.map((row) => row.id)));
}

async function restoreBusinessRow(tx: Tx, session: Session, data: BackupData): Promise<void> {
  const row = data.tables.businesses?.[0];
  if (!row) throw new AppError("النسخة لا تحتوي بيانات المنشأة");
  await tx
    .update(businesses)
    .set({
      name: String(row.name ?? "نشاطي"),
      legalName: (row.legalName as string | null) ?? null,
      phone: (row.phone as string | null) ?? null,
      address: (row.address as string | null) ?? null,
      currency: String(row.currency ?? "YER"),
      currencyScale: Number(row.currencyScale ?? 2),
      taxEnabled: Boolean(row.taxEnabled),
      taxRateBp: Number(row.taxRateBp ?? 0),
      valuationMethod: (row.valuationMethod as "weighted_average" | "fifo") ?? "weighted_average",
      offlineSellLimitMilli:
        typeof row.offlineSellLimitMilli === "bigint"
          ? row.offlineSellLimitMilli
          : BigInt(String(row.offlineSellLimitMilli ?? "0")),
      ownerAuthUserId:
        session.authUserId ??
        (typeof row.ownerAuthUserId === "string" ? row.ownerAuthUserId : null),
    })
    .where(eq(businesses.id, session.businessId));
}

async function restoreUsers(tx: Tx, rows: Row[] | undefined): Promise<void> {
  if (!rows?.length) return;
  const { hashPassword } = await import("@/server/auth");
  // A random unusable password for users that do not already exist locally.
  const disabledHash = await hashPassword(`disabled-${Date.now()}-${Math.random()}`);
  const values = rows.map((row) => ({
    id: String(row.id),
    email: String(row.email),
    name: String(row.name ?? row.email ?? "مستخدم"),
    passwordHash: disabledHash,
    isActive: row.isActive === undefined ? true : Boolean(row.isActive),
    createdAt: row.createdAt ? new Date(String(row.createdAt)) : new Date(),
  }));
  await tx.insert(users).values(values).onConflictDoNothing();
}

async function restoreSubscriptions(tx: Tx, rows: Row[] | undefined): Promise<void> {
  if (!rows?.length) return;
  const plans = await tx.select({ id: schema.subscriptionPlans.id }).from(schema.subscriptionPlans);
  const knownPlans = new Set(plans.map((plan) => plan.id));
  const values = rows.map((row) => {
    const coerced = coerceRow(businessSubscriptions, row);
    const planId = typeof coerced.planId === "string" && knownPlans.has(coerced.planId) ? coerced.planId : null;
    return { ...coerced, planId };
  });
  await tx.insert(businessSubscriptions).values(values as never).onConflictDoNothing();
}

export type CreateBackupResult = {
  backup: typeof cloudBackups.$inferSelect;
  duplicate: boolean;
};

export async function createBusinessBackup(
  tx: Tx,
  session: Session,
  kind: "manual" | "auto" | "safety" = "manual",
): Promise<CreateBackupResult> {
  const data = await collectBusinessData(tx, session.businessId);
  const json = JSON.stringify(serializeBigInts(data));
  const checksum = backupChecksum(data);
  const sizeBytes = BigInt(Buffer.byteLength(json, "utf8"));
  const [existing] = await tx
    .select()
    .from(cloudBackups)
    .where(and(eq(cloudBackups.businessId, session.businessId), eq(cloudBackups.checksum, checksum)))
    .limit(1);
  if (existing) {
    const now = new Date();
    await tx
      .update(cloudBackupSettings)
      .set({ lastBackupAt: now, lastError: null, updatedAt: now })
      .where(eq(cloudBackupSettings.businessId, session.businessId));
    return { backup: existing, duplicate: true };
  }

  const storagePath = `${session.businessId}/${Date.now()}-${kind}-${checksum.slice(0, 12)}.json`;
  const uploaded = await uploadBackupObject(storagePath, json);

  const [backup] = await tx
    .insert(cloudBackups)
    .values({
      businessId: session.businessId,
      userId: cloudUserId(session),
      createdByUserId: session.userId,
      kind,
      status: "ready",
      formatVersion: BUSINESS_BACKUP_VERSION,
      sizeBytes,
      checksum,
      storagePath: uploaded?.storagePath ?? null,
      data: serializeBigInts(data) as never,
      metadata: {
        businessName: data.metadata.businessName,
        totalRows: data.metadata.totalRows,
        counts: data.metadata.counts,
        storage: uploaded ? "supabase-storage" : "postgres-jsonb",
      } as never,
    })
    .returning();

  const now = new Date();
  await tx
    .update(cloudBackupSettings)
    .set({ lastBackupAt: now, lastError: null, updatedAt: now })
    .where(eq(cloudBackupSettings.businessId, session.businessId));

  // Keep a bounded history; safety backups are retained separately.
  await tx.execute(sql`
    delete from ${cloudBackups}
    where ${cloudBackups.id} in (
      select ${cloudBackups.id} from ${cloudBackups}
      where ${cloudBackups.businessId} = ${session.businessId}
        and ${cloudBackups.kind} = 'auto'
      order by ${cloudBackups.createdAt} desc
      offset 50
    )
  `);

  return { backup, duplicate: false };
}

export async function listBusinessBackups(tx: Tx, businessId: string, limit = 100) {
  return tx
    .select({
      id: cloudBackups.id,
      businessId: cloudBackups.businessId,
      userId: cloudBackups.userId,
      kind: cloudBackups.kind,
      status: cloudBackups.status,
      formatVersion: cloudBackups.formatVersion,
      sizeBytes: cloudBackups.sizeBytes,
      checksum: cloudBackups.checksum,
      storagePath: cloudBackups.storagePath,
      metadata: cloudBackups.metadata,
      error: cloudBackups.error,
      createdAt: cloudBackups.createdAt,
      restoredAt: cloudBackups.restoredAt,
      createdByName: users.name,
    })
    .from(cloudBackups)
    .leftJoin(users, eq(users.id, cloudBackups.createdByUserId))
    .where(eq(cloudBackups.businessId, businessId))
    .orderBy(desc(cloudBackups.createdAt))
    .limit(Math.max(1, Math.min(500, limit)));
}

export async function loadBusinessBackup(
  tx: Tx,
  businessId: string,
  backupId: string,
): Promise<{ backup: typeof cloudBackups.$inferSelect; data: BackupData }> {
  const [backup] = await tx
    .select()
    .from(cloudBackups)
    .where(and(eq(cloudBackups.id, backupId), eq(cloudBackups.businessId, businessId)))
    .limit(1);
  if (!backup) throw new AppError("النسخة الاحتياطية غير موجودة", 404);
  let data = backup.data as unknown as BackupData | null;
  if (!data && backup.storagePath) {
    const raw = await downloadBackupObject(backup.storagePath);
    if (raw) data = JSON.parse(raw) as BackupData;
  }
  if (!data) throw new AppError("تعذر تحميل محتوى النسخة الاحتياطية", 409);
  if (data.format !== BUSINESS_BACKUP_FORMAT || data.version !== BUSINESS_BACKUP_VERSION) {
    throw new AppError("صيغة النسخة الاحتياطية غير مدعومة", 422);
  }
  if (data.businessId !== businessId) {
    throw new AppError("هذه النسخة لا تنتمي إلى النشاط الحالي", 403);
  }
  const expected = backup.checksum;
  const actual = backupChecksum(data);
  if (expected && actual !== expected) {
    throw new AppError("فشل التحقق من سلامة النسخة الاحتياطية", 409);
  }
  return { backup, data };
}

export type RestoreBackupResult = {
  restoredTables: number;
  restoredRows: number;
  safetyBackupId: string | null;
};

export async function restoreBusinessBackup(
  tx: Tx,
  session: Session,
  backupId: string,
  options: { safetyBackupId?: string | null } = {},
): Promise<RestoreBackupResult> {
  const { backup, data } = await loadBusinessBackup(tx, session.businessId, backupId);

  for (const spec of CHILD_TABLES) await deleteChild(tx, spec, session.businessId);
  for (const table of DELETE_ORDER) await deleteScoped(tx, table, session.businessId);

  await restoreBusinessRow(tx, session, data);
  await restoreUsers(tx, data.tables.users);
  await restoreSubscriptions(tx, data.tables["business_subscriptions"]);

  let restoredTables = 0;
  let restoredRows = 0;
  for (const table of INSERT_ORDER) {
    if (table === businessSubscriptions) continue;
    const name = tableName(table);
    const count = await insertTableRows(tx, table, data.tables[name]);
    if (count) {
      restoredTables += 1;
      restoredRows += count;
    }
  }

  await tx
    .update(cloudBackups)
    .set({ restoredAt: new Date() })
    .where(eq(cloudBackups.id, backup.id));
  await tx
    .update(cloudBackupSettings)
    .set({ lastError: null, updatedAt: new Date() })
    .where(eq(cloudBackupSettings.businessId, session.businessId));

  return {
    restoredTables,
    restoredRows,
    safetyBackupId: options.safetyBackupId ?? null,
  };
}
