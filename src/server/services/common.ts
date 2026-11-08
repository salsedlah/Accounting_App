import { and, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  auditLogs,
  businesses,
  cashboxes,
  customerAccounts,
  customers,
  membershipPermissionOverrides,
  memberships,
  supplierAccounts,
  warehouses,
} from "@/db/schema";
import { AppError } from "@/server/api";
import { can, type Permission } from "@/lib/constants";

export type BusinessRow = typeof businesses.$inferSelect;

export async function memberCan(tx: Tx, session: { userId: string; businessId: string; role: string }, permission: Permission): Promise<boolean> {
  const [membership] = await tx.select({ id: memberships.id }).from(memberships)
    .where(and(eq(memberships.businessId, session.businessId), eq(memberships.userId, session.userId))).limit(1);
  if (!membership) return false;
  const [override] = await tx.select({ allowed: membershipPermissionOverrides.allowed }).from(membershipPermissionOverrides)
    .where(and(eq(membershipPermissionOverrides.membershipId, membership.id), eq(membershipPermissionOverrides.permissionKey, permission))).limit(1);
  return override?.allowed ?? can(session.role, permission);
}

export async function loadBusiness(tx: Tx, businessId: string): Promise<BusinessRow> {
  const [row] = await tx.select().from(businesses).where(eq(businesses.id, businessId));
  if (!row) throw new AppError("المنشأة غير موجودة", 404);
  return row;
}

export async function defaultWarehouse(tx: Tx, businessId: string, preferredId?: string | null) {
  if (preferredId) {
    const [row] = await tx
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.id, preferredId), eq(warehouses.businessId, businessId)));
    if (!row) throw new AppError("المستودع غير موجود", 404);
    return row;
  }
  const [row] = await tx
    .select()
    .from(warehouses)
    .where(and(eq(warehouses.businessId, businessId), eq(warehouses.isActive, true)))
    .orderBy(desc(warehouses.isDefault))
    .limit(1);
  if (!row) throw new AppError("لا يوجد مستودع فعال", 409);
  return row;
}

export async function defaultCashbox(tx: Tx, businessId: string, preferredId?: string | null) {
  if (preferredId) {
    const [row] = await tx
      .select()
      .from(cashboxes)
      .where(and(eq(cashboxes.id, preferredId), eq(cashboxes.businessId, businessId)));
    if (!row) throw new AppError("الصندوق غير موجود", 404);
    return row;
  }
  const [row] = await tx
    .select()
    .from(cashboxes)
    .where(and(eq(cashboxes.businessId, businessId), eq(cashboxes.isActive, true)))
    .orderBy(desc(cashboxes.isDefault))
    .limit(1);
  if (!row) throw new AppError("لا يوجد صندوق فعال", 409);
  return row;
}

export async function customerOutstanding(
  tx: Tx,
  businessId: string,
  customerId: string,
): Promise<bigint> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${customerAccounts.amountMinor}), 0)` })
    .from(customerAccounts)
    .where(
      and(
        eq(customerAccounts.businessId, businessId),
        eq(customerAccounts.customerId, customerId),
      ),
    );
  return BigInt(row?.total ?? "0");
}

export async function supplierOutstanding(
  tx: Tx,
  businessId: string,
  supplierId: string,
): Promise<bigint> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${supplierAccounts.amountMinor}), 0)` })
    .from(supplierAccounts)
    .where(
      and(
        eq(supplierAccounts.businessId, businessId),
        eq(supplierAccounts.supplierId, supplierId),
      ),
    );
  return BigInt(row?.total ?? "0");
}

export async function loadCustomer(tx: Tx, businessId: string, customerId: string) {
  const [row] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.businessId, businessId)));
  if (!row) throw new AppError("العميل غير موجود", 404);
  return row;
}

export async function touchCustomer(tx: Tx, customerId: string, at = new Date()) {
  await tx.update(customers).set({ lastTransactionAt: at }).where(eq(customers.id, customerId));
}

export async function writeAudit(
  tx: Tx,
  input: {
    businessId: string;
    userId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    before?: unknown;
    after?: unknown;
    ip?: string | null;
  },
) {
  await tx.insert(auditLogs).values({
    businessId: input.businessId,
    userId: input.userId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    before: (input.before ?? null) as never,
    after: (input.after ?? null) as never,
    ip: input.ip ?? null,
  });
}
