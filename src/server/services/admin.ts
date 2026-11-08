import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db/client";
import {
  auditLogs,
  businesses,
  inventoryMovements,
  memberships,
  productCategories,
  units,
  users,
  warehouses,
} from "@/db/schema";
import { PERMISSIONS, ROLE_LABELS, ROLE_PERMISSIONS, can } from "@/lib/constants";
import { parseQty } from "@/lib/quantity";
import { AppError } from "@/server/api";
import { hashPassword, type Session } from "@/server/auth";
import { loadBusiness, memberCan, writeAudit } from "./common";

export const memberSchema = z.object({
  name: z.string().min(1).max(150),
  email: z.string().email(),
  password: z.string().min(8).max(200),
  role: z.enum(["owner", "accountant", "cashier", "inventory_manager", "viewer"]),
});

export const roleSchema = z.object({
  role: z.enum(["owner", "accountant", "cashier", "inventory_manager", "viewer"]),
});

export async function listMembers(tx: Tx, businessId: string) {
  return tx
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      isActive: users.isActive,
      role: memberships.role,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.businessId, businessId))
    .orderBy(asc(memberships.createdAt));
}

export async function createMember(tx: Tx, session: Session, raw: unknown) {
  const input = memberSchema.parse(raw);
  if (!(await memberCan(tx, session, PERMISSIONS.usersManage))) {
    throw new AppError("لا تملك صلاحية إدارة المستخدمين", 403);
  }
  const email = input.email.trim().toLowerCase();
  const [existing] = await tx.select().from(users).where(eq(users.email, email));
  if (existing) {
    const [membership] = await tx
      .select()
      .from(memberships)
      .where(
        and(eq(memberships.businessId, session.businessId), eq(memberships.userId, existing.id)),
      );
    if (membership) throw new AppError("المستخدم عضو في المنشأة بالفعل", 409);
    await tx
      .insert(memberships)
      .values({ businessId: session.businessId, userId: existing.id, role: input.role });
    await writeAudit(tx, {
      businessId: session.businessId,
      userId: session.userId,
      action: "user.add_membership",
      entityType: "user",
      entityId: existing.id,
      after: { role: input.role },
    });
    return { id: existing.id, reused: true };
  }

  const passwordHash = await hashPassword(input.password);
  const [user] = await tx
    .insert(users)
    .values({ email, name: input.name, passwordHash })
    .returning();
  await tx
    .insert(memberships)
    .values({ businessId: session.businessId, userId: user.id, role: input.role });
  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "user.create",
    entityType: "user",
    entityId: user.id,
    after: { email, role: input.role },
  });
  return { id: user.id, reused: false };
}

export async function updateMemberRole(
  tx: Tx,
  session: Session,
  memberUserId: string,
  raw: unknown,
) {
  const input = roleSchema.parse(raw);
  if (!(await memberCan(tx, session, PERMISSIONS.usersManage))) {
    throw new AppError("لا تملك صلاحية إدارة المستخدمين", 403);
  }
  const [membership] = await tx
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.businessId, session.businessId),
        eq(memberships.userId, memberUserId),
      ),
    );
  if (!membership) throw new AppError("العضوية غير موجودة", 404);
  if (membership.role === "owner" && input.role !== "owner") {
    const [owners] = await tx
      .select({ count: sql<string>`count(*)` })
      .from(memberships)
      .where(
        and(eq(memberships.businessId, session.businessId), eq(memberships.role, "owner")),
      );
    if (BigInt(owners.count) <= 1n) {
      throw new AppError("لا يمكن إزالة دور المالك الوحيد", 409);
    }
  }
  await tx
    .update(memberships)
    .set({ role: input.role })
    .where(eq(memberships.id, membership.id));
  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "user.update_role",
    entityType: "user",
    entityId: memberUserId,
    before: { role: membership.role },
    after: { role: input.role },
  });
  return { ok: true };
}

export async function resetMemberPassword(
  tx: Tx,
  session: Session,
  memberUserId: string,
  password: string,
) {
  if (!(await memberCan(tx, session, PERMISSIONS.usersManage))) {
    throw new AppError("لا تملك صلاحية إدارة المستخدمين", 403);
  }
  if (password.length < 8) throw new AppError("كلمة المرور يجب أن تكون 8 أحرف على الأقل", 422);
  const [membership] = await tx
    .select()
    .from(memberships)
    .where(
      and(eq(memberships.businessId, session.businessId), eq(memberships.userId, memberUserId)),
    );
  if (!membership) throw new AppError("العضوية غير موجودة", 404);
  const passwordHash = await hashPassword(password);
  await tx.update(users).set({ passwordHash }).where(eq(users.id, memberUserId));
  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "user.reset_password",
    entityType: "user",
    entityId: memberUserId,
  });
  return { ok: true };
}

export function permissionMatrix() {
  return Object.entries(ROLE_PERMISSIONS).map(([role, permissions]) => ({
    role,
    label: ROLE_LABELS[role],
    permissions,
  }));
}

export const settingsSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  legalName: z.string().max(200).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  address: z.string().max(300).optional().nullable(),
  taxEnabled: z.boolean().optional(),
  taxRateBp: z.number().int().min(0).max(10000).optional(),
  valuationMethod: z.enum(["weighted_average", "fifo"]).optional(),
  offlineSellLimit: z.string().optional(),
});

export async function updateSettings(tx: Tx, session: Session, raw: unknown) {
  const input = settingsSchema.parse(raw);
  if (!(await memberCan(tx, session, PERMISSIONS.settingsManage))) {
    throw new AppError("لا تملك صلاحية تعديل الإعدادات", 403);
  }
  const business = await loadBusiness(tx, session.businessId);
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.legalName !== undefined) patch.legalName = input.legalName || null;
  if (input.phone !== undefined) patch.phone = input.phone || null;
  if (input.address !== undefined) patch.address = input.address || null;
  if (input.taxEnabled !== undefined) patch.taxEnabled = input.taxEnabled;
  if (input.taxRateBp !== undefined) patch.taxRateBp = input.taxRateBp;
  if (input.offlineSellLimit !== undefined) {
    const value = parseQty(input.offlineSellLimit);
    if (value < 0n) throw new AppError("حد البيع دون اتصال غير صالح", 422);
    patch.offlineSellLimitMilli = value;
  }
  if (input.valuationMethod !== undefined && input.valuationMethod !== business.valuationMethod) {
    const [movements] = await tx
      .select({ count: sql<string>`count(*)` })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.businessId, session.businessId));
    if (BigInt(movements.count) > 0n) {
      throw new AppError("لا يمكن تغيير طريقة تقييم المخزون بعد وجود حركات", 409);
    }
    patch.valuationMethod = input.valuationMethod;
  }
  if (Object.keys(patch).length) {
    await tx.update(businesses).set(patch).where(eq(businesses.id, session.businessId));
  }
  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "settings.update",
    entityType: "business",
    entityId: session.businessId,
    before: { name: business.name, valuationMethod: business.valuationMethod },
    after: patch,
  });
  return loadBusiness(tx, session.businessId);
}

export async function getSettings(tx: Tx, businessId: string) {
  const business = await loadBusiness(tx, businessId);
  const warehouseRows = await tx
    .select()
    .from(warehouses)
    .where(eq(warehouses.businessId, businessId))
    .orderBy(asc(warehouses.name));
  const unitRows = await tx
    .select()
    .from(units)
    .where(eq(units.businessId, businessId))
    .orderBy(asc(units.name));
  const categoryRows = await tx
    .select()
    .from(productCategories)
    .where(eq(productCategories.businessId, businessId))
    .orderBy(asc(productCategories.name));
  return { business, warehouses: warehouseRows, units: unitRows, categories: categoryRows };
}

export async function updateWarehouse(
  tx: Tx,
  session: Session,
  warehouseId: string,
  input: { name?: string; isDefault?: boolean; isActive?: boolean },
) {
  if (!(await memberCan(tx, session, PERMISSIONS.settingsManage))) {
    throw new AppError("لا تملك صلاحية إدارة المستودعات", 403);
  }
  const [existing] = await tx
    .select()
    .from(warehouses)
    .where(and(eq(warehouses.id, warehouseId), eq(warehouses.businessId, session.businessId)));
  if (!existing) throw new AppError("المستودع غير موجود", 404);
  if (input.isDefault) {
    await tx
      .update(warehouses)
      .set({ isDefault: false })
      .where(eq(warehouses.businessId, session.businessId));
  }
  await tx.update(warehouses).set(input).where(eq(warehouses.id, warehouseId));
  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "warehouse.update",
    entityType: "warehouse",
    entityId: warehouseId,
    after: input,
  });
  return { ok: true };
}

export async function listAuditLogs(tx: Tx, businessId: string, limit = 200) {
  return tx
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      before: auditLogs.before,
      after: auditLogs.after,
      createdAt: auditLogs.createdAt,
      userName: users.name,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .where(eq(auditLogs.businessId, businessId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
}
