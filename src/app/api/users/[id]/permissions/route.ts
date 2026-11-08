import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ensureReady } from "@/db/bootstrap";
import { getDb } from "@/db/client";
import { membershipPermissionOverrides, memberships } from "@/db/schema";
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission } from "@/lib/constants";
import { getAvailablePermissions, requirePermission } from "@/server/auth";
import { AppError, ok, readJson, route } from "@/server/api";
import { writeAudit } from "@/server/services/common";

const inputSchema = z.object({ permissions: z.array(z.string()).max(100) });
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) { return route(async () => {
  await ensureReady(); const session = await requirePermission(PERMISSIONS.usersManage); const userId = z.string().uuid().parse((await context.params).id);
  const input = inputSchema.parse(await readJson(request)); const db = await getDb(); const available = await getAvailablePermissions(session);
  const availableKeys = new Set(available.map((item) => item.key)); const selected = new Set(input.permissions);
  if ([...selected].some((key) => !availableKeys.has(key as Permission))) throw new AppError("تتضمن الصلاحيات المختارة ميزة غير متاحة في باقة المؤسسة", 422);
  const result = await db.transaction(async (tx) => {
    const [membership] = await tx.select().from(memberships).where(and(eq(memberships.businessId, session.businessId), eq(memberships.userId, userId))).limit(1);
    if (!membership) throw new AppError("المستخدم ليس عضواً في هذه المؤسسة", 404);
    const roleDefaults = new Set(ROLE_PERMISSIONS[membership.role] ?? []);
    if (userId === session.userId && roleDefaults.has(PERMISSIONS.usersManage) && !selected.has(PERMISSIONS.usersManage)) {
      throw new AppError("لا يمكنك إزالة صلاحية إدارة المستخدمين من حسابك الحالي", 409);
    }
    const beforeRows = await tx.select().from(membershipPermissionOverrides).where(eq(membershipPermissionOverrides.membershipId, membership.id));
    for (const permission of available) {
      const allowed = selected.has(permission.key);
      if (allowed === roleDefaults.has(permission.key)) {
        await tx.delete(membershipPermissionOverrides).where(and(eq(membershipPermissionOverrides.membershipId, membership.id), eq(membershipPermissionOverrides.permissionKey, permission.key)));
      } else {
        await tx.insert(membershipPermissionOverrides).values({ membershipId: membership.id, permissionKey: permission.key, allowed, actorUserId: session.userId, updatedAt: new Date() })
          .onConflictDoUpdate({ target: [membershipPermissionOverrides.membershipId, membershipPermissionOverrides.permissionKey], set: { allowed, actorUserId: session.userId, updatedAt: new Date() } });
      }
    }
    await writeAudit(tx, { businessId: session.businessId, userId: session.userId, action: "user.permissions_update", entityType: "user", entityId: userId,
      before: beforeRows.map((item) => ({ permission: item.permissionKey, allowed: item.allowed })), after: [...selected] });
    return { userId, permissions: [...selected] };
  });
  return ok(result);
}); }
