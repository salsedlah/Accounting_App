import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  cloudBackupSettings,
  cloudBackups,
  syncChanges,
  syncCursors,
  syncOperations,
} from "@/db/schema";
import { AuthError, requireSession, type Session } from "@/server/auth";
import { serializeBigInts } from "@/server/api";

/**
 * Returns the verified Supabase Auth id for the session.
 *
 * Cloud sync, cloud backups and every cloud-owned row require a *verified*
 * Supabase identity. A local user id is never accepted as a substitute: a
 * legacy password login must be linked to Supabase Auth first. Callers that
 * only need to know whether cloud is available should use
 * `hasVerifiedCloudIdentity`.
 */
export function cloudUserId(session: Session): string {
  if (!session.authUserId || session.businessId === "platform") {
    throw new AuthError(
      "يجب ربط الحساب بـ Supabase Auth قبل استخدام المزامنة أو النسخ السحابي.",
      403,
    );
  }
  return session.authUserId;
}

export function hasVerifiedCloudIdentity(session: Session): boolean {
  return Boolean(session.authUserId) && session.businessId !== "platform";
}

/** Session guard for every cloud endpoint. */
export async function requireCloudSession(): Promise<Session> {
  const session = await requireSession();
  if (!hasVerifiedCloudIdentity(session)) {
    throw new AuthError(
      "يجب ربط الحساب بـ Supabase Auth قبل استخدام المزامنة أو النسخ السحابي.",
      403,
    );
  }
  return session;
}

export type CloudSettings = typeof cloudBackupSettings.$inferSelect;

export async function ensureCloudSettings(tx: Tx, session: Session): Promise<CloudSettings> {
  const userId = cloudUserId(session);
  const [inserted] = await tx
    .insert(cloudBackupSettings)
    .values({ businessId: session.businessId, userId })
    .onConflictDoNothing({ target: cloudBackupSettings.businessId })
    .returning();
  if (inserted) return inserted;
  const [existing] = await tx
    .select()
    .from(cloudBackupSettings)
    .where(eq(cloudBackupSettings.businessId, session.businessId))
    .limit(1);
  if (!existing) throw new Error("تعذر تهيئة إعدادات النسخ والمزامنة");
  if (!existing.userId) {
    const [updated] = await tx
      .update(cloudBackupSettings)
      .set({ userId })
      .where(eq(cloudBackupSettings.id, existing.id))
      .returning();
    return updated;
  }
  return existing;
}

export async function updateCloudSettings(
  tx: Tx,
  session: Session,
  patch: { autoSync?: boolean; autoBackup?: boolean; backupIntervalHours?: number },
): Promise<CloudSettings> {
  await ensureCloudSettings(tx, session);
  const values: Record<string, unknown> = { updatedAt: new Date(), userId: cloudUserId(session) };
  if (patch.autoSync !== undefined) values.autoSync = patch.autoSync;
  if (patch.autoBackup !== undefined) values.autoBackup = patch.autoBackup;
  if (patch.backupIntervalHours !== undefined) {
    values.backupIntervalHours = Math.max(1, Math.min(24 * 30, Math.round(patch.backupIntervalHours)));
  }
  const [updated] = await tx
    .update(cloudBackupSettings)
    .set(values)
    .where(eq(cloudBackupSettings.businessId, session.businessId))
    .returning();
  return updated;
}

export async function latestChangeId(tx: Tx, businessId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<string>`coalesce(max(${syncChanges.id}), 0)` })
    .from(syncChanges)
    .where(eq(syncChanges.businessId, businessId));
  return Number(row?.max ?? 0);
}

export async function getSyncCursor(tx: Tx, businessId: string, deviceId?: string | null) {
  if (!deviceId) return null;
  const [row] = await tx
    .select()
    .from(syncCursors)
    .where(and(eq(syncCursors.businessId, businessId), eq(syncCursors.deviceId, deviceId)))
    .limit(1);
  return row ?? null;
}

export async function getSyncStatus(tx: Tx, session: Session, deviceId?: string | null) {
  const settings = await ensureCloudSettings(tx, session);
  const [cursor, maxChangeId, pending, latestBackup] = await Promise.all([
    getSyncCursor(tx, session.businessId, deviceId),
    latestChangeId(tx, session.businessId),
    tx
      .select({ count: sql<string>`count(*)` })
      .from(syncOperations)
      .where(
        and(
          eq(syncOperations.businessId, session.businessId),
          sql`${syncOperations.status} in ('pending','processing','failed')`,
        ),
      ),
    tx
      .select({
        id: cloudBackups.id,
        kind: cloudBackups.kind,
        status: cloudBackups.status,
        createdAt: cloudBackups.createdAt,
        sizeBytes: cloudBackups.sizeBytes,
      })
      .from(cloudBackups)
      .where(eq(cloudBackups.businessId, session.businessId))
      .orderBy(sql`${cloudBackups.createdAt} desc`)
      .limit(1),
  ]);
  return {
    serverTime: new Date().toISOString(),
    businessId: session.businessId,
    userId: cloudUserId(session),
    authUserId: session.authUserId ?? null,
    deviceId: deviceId ?? null,
    settings: {
      autoSync: settings.autoSync,
      autoBackup: settings.autoBackup,
      backupIntervalHours: settings.backupIntervalHours,
      lastSyncAt: settings.lastSyncAt,
      lastBackupAt: settings.lastBackupAt,
      lastError: settings.lastError,
      updatedAt: settings.updatedAt,
    },
    cursor: cursor
      ? {
          deviceId: cursor.deviceId,
          lastChangeId: Number(cursor.lastChangeId),
          lastSyncedAt: cursor.lastSyncedAt,
        }
      : null,
    latestChangeId: maxChangeId,
    pendingOperations: Number(pending[0]?.count ?? 0),
    latestBackup: latestBackup[0] ?? null,
  };
}

export async function pullChanges(
  tx: Tx,
  session: Session,
  input: { since: number; limit: number },
) {
  const since = Math.max(0, Math.floor(input.since));
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit)));
  const rows = await tx
    .select()
    .from(syncChanges)
    .where(and(eq(syncChanges.businessId, session.businessId), gt(syncChanges.id, since)))
    .orderBy(asc(syncChanges.id))
    .limit(limit);
  const changes = rows.map((row) => ({
    id: row.id,
    table: row.tableName,
    recordId: row.recordId,
    operation: row.operation,
    payload: serializeBigInts(row.payload),
    changedAt: row.changedAt,
    deviceId: row.deviceId,
  }));
  const nextCursor = changes.length ? changes[changes.length - 1].id : since;
  return {
    changes,
    nextCursor,
    hasMore: changes.length === limit,
    serverTime: new Date().toISOString(),
  };
}

export async function acknowledgeCursor(
  tx: Tx,
  session: Session,
  input: { deviceId: string; lastChangeId: number },
) {
  await ensureCloudSettings(tx, session);
  const lastChangeId = BigInt(Math.max(0, Math.floor(input.lastChangeId)));
  const now = new Date();
  await tx
    .insert(syncCursors)
    .values({
      businessId: session.businessId,
      userId: cloudUserId(session),
      deviceId: input.deviceId,
      lastChangeId,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [syncCursors.businessId, syncCursors.deviceId],
      set: {
        userId: cloudUserId(session),
        lastChangeId,
        lastSyncedAt: now,
        updatedAt: now,
      },
    });
  await tx
    .update(cloudBackupSettings)
    .set({ lastSyncAt: now, lastError: null, updatedAt: now })
    .where(eq(cloudBackupSettings.businessId, session.businessId));
  return { ok: true, lastChangeId: Number(lastChangeId), lastSyncedAt: now };
}

export async function markSyncError(tx: Tx, session: Session, message: string) {
  await ensureCloudSettings(tx, session);
  const safe = message.slice(0, 500);
  await tx
    .update(cloudBackupSettings)
    .set({ lastError: safe, updatedAt: new Date() })
    .where(eq(cloudBackupSettings.businessId, session.businessId));
}

export async function touchSync(
  tx: Tx,
  session: Session,
  deviceId?: string | null,
): Promise<CloudSettings> {
  const settings = await ensureCloudSettings(tx, session);
  const now = new Date();
  const [updated] = await tx
    .update(cloudBackupSettings)
    .set({ lastSyncAt: now, lastError: null, updatedAt: now })
    .where(eq(cloudBackupSettings.id, settings.id))
    .returning();
  if (deviceId) {
    const [cursor] = await tx
      .select({ lastChangeId: syncCursors.lastChangeId })
      .from(syncCursors)
      .where(and(eq(syncCursors.businessId, session.businessId), eq(syncCursors.deviceId, deviceId)))
      .limit(1);
    await tx
      .insert(syncCursors)
      .values({
        businessId: session.businessId,
        userId: cloudUserId(session),
        deviceId,
        lastChangeId: cursor?.lastChangeId ?? 0n,
        lastSyncedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [syncCursors.businessId, syncCursors.deviceId],
        set: { lastSyncedAt: now, updatedAt: now, userId: cloudUserId(session) },
      });
  }
  return updated;
}

export async function recordChange(
  tx: Tx,
  session: Session,
  input: {
    tableName: string;
    recordId: string;
    operation: "insert" | "update" | "delete";
    payload?: unknown;
    deviceId?: string | null;
  },
) {
  const [row] = await tx
    .insert(syncChanges)
    .values({
      businessId: session.businessId,
      userId: cloudUserId(session),
      tableName: input.tableName,
      recordId: input.recordId,
      operation: input.operation,
      payload: serializeBigInts(input.payload ?? null) as never,
      deviceId: input.deviceId ?? null,
    })
    .returning({ id: syncChanges.id });
  return row;
}

const OPERATION_TABLES: Record<string, string> = {
  "sale.create": "sales",
  "purchase.create": "purchases",
  "expense.create": "expenses",
  "payment.create": "payments",
  "customer.create": "customers",
  "supplier.create": "suppliers",
  "product.create": "products",
  "debt.create": "customer_accounts",
  "inventory.adjust": "inventory_movements",
  "cashbox.manual": "cash_transactions",
  "stocktaking.create": "stocktaking_sessions",
};

/**
 * Records a change for a successfully pushed mobile operation. Database
 * triggers also record changes for writes made by the web app; this function
 * makes sure mobile-originated operations have an explicit change entry even
 * when a trigger is unavailable on an older database.
 */
export async function recordOperationChange(
  tx: Tx,
  session: Session,
  type: string,
  summary: unknown,
  deviceId?: string | null,
) {
  const tableName = OPERATION_TABLES[type];
  if (!tableName) return null;
  const payload = (summary && typeof summary === "object" ? summary : {}) as Record<string, unknown>;
  const candidate = operationRecordId(payload);
  if (!candidate) return null;
  return recordChange(tx, session, {
    tableName,
    recordId: candidate,
    operation: "insert",
    payload: summary,
    deviceId,
  });
}

const NESTED_RECORD_KEYS = [
  "sale",
  "purchase",
  "expense",
  "payment",
  "product",
  "customer",
  "supplier",
  "stocktake",
  "debt",
  "movement",
  "account",
  "transfer",
] as const;

const DIRECT_RECORD_KEYS = [
  "id",
  "entryId",
  "movementId",
  "accountId",
  "transferId",
  "sessionId",
] as const;

/**
 * Extracts the created record id from the many shapes the business services
 * return. Some return the row itself, others wrap it (`{ purchase: { id } }`)
 * and a few return only an operation-specific id.
 */
function operationRecordId(payload: Record<string, unknown>): string | null {
  for (const key of DIRECT_RECORD_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value) return value;
  }
  for (const key of NESTED_RECORD_KEYS) {
    const nested = payload[key];
    if (!nested || typeof nested !== "object") continue;
    const id = (nested as Record<string, unknown>).id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

export function isBackupDue(settings: CloudSettings, now = new Date()): boolean {
  if (!settings.autoBackup) return false;
  if (!settings.lastBackupAt) return true;
  const intervalMs = Math.max(1, settings.backupIntervalHours) * 60 * 60 * 1000;
  return now.getTime() - new Date(settings.lastBackupAt).getTime() >= intervalMs;
}
