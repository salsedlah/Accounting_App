import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  accounts,
  businessSubscriptions,
  businesses,
  cashboxes,
  memberships,
  permissions,
  productCategories,
  rolePermissions,
  roles,
  subscriptionPlans,
  units,
  users,
  warehouses,
} from "@/db/schema";
import {
  PERMISSION_CATALOG,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  SYSTEM_ACCOUNTS,
} from "@/lib/constants";
import { hashPassword } from "@/server/auth";

export type ProvisionInput = {
  email: string;
  name: string;
  businessName: string;
  password?: string;
  authUserId?: string | null;
};

export type ProvisionResult = {
  userId: string;
  businessId: string;
  createdBusiness: boolean;
  createdUser: boolean;
};

const DEFAULT_UNITS = [
  { name: "قطعة", symbol: "pc", kind: "count" },
  { name: "كرتون", symbol: "ctn", kind: "package" },
  { name: "كيلوجرام", symbol: "kg", kind: "weight" },
  { name: "لتر", symbol: "L", kind: "volume" },
];

/**
 * Creates a business with its chart of accounts, roles, default warehouse and
 * cashbox, then links (or creates) the owner user. Safe to call repeatedly for
 * the same Supabase account: the auth id / email lookup prevents duplicates.
 */
export async function provisionAccount(tx: Tx, input: ProvisionInput): Promise<ProvisionResult> {
  const email = input.email.trim().toLowerCase();
  let user =
    (input.authUserId
      ? (
          await tx
            .select()
            .from(users)
            .where(eq(users.authUserId, input.authUserId))
            .limit(1)
        )[0]
      : undefined) ??
    (await tx.select().from(users).where(eq(users.email, email)).limit(1))[0];

  let createdUser = false;
  if (!user) {
    const passwordHash = await hashPassword(input.password ?? randomUUID());
    [user] = await tx
      .insert(users)
      .values({
        email,
        name: input.name,
        passwordHash,
        authUserId: input.authUserId ?? null,
      })
      .returning();
    createdUser = true;
  } else if (input.authUserId && user.authUserId !== input.authUserId) {
    // Never silently re-point an existing account at a different Supabase
    // identity: that would let a second Auth account take over local data.
    if (user.authUserId) {
      throw new Error(
        "هذا البريد مرتبط مسبقاً بحساب Supabase Auth مختلف. سجّل الدخول بالحساب الأصلي.",
      );
    }
    [user] = await tx
      .update(users)
      .set({ authUserId: input.authUserId })
      .where(eq(users.id, user.id))
      .returning();
  }

  const [existingMembership] = await tx
    .select({ businessId: memberships.businessId })
    .from(memberships)
    .where(and(eq(memberships.userId, user.id), eq(memberships.role, "owner")))
    .limit(1);
  if (existingMembership) {
    if (input.authUserId) {
      // Keep the business ownership marker in sync so RLS and change capture
      // can attribute cloud rows to the verified Auth account.
      await tx
        .update(businesses)
        .set({ ownerAuthUserId: input.authUserId })
        .where(eq(businesses.id, existingMembership.businessId));
    }
    await ensureBusinessBootstrap(tx, existingMembership.businessId);
    return {
      userId: user.id,
      businessId: existingMembership.businessId,
      createdBusiness: false,
      createdUser,
    };
  }

  const [business] = await tx
    .insert(businesses)
    .values({
      name: input.businessName.trim() || `${input.name} - نشاطي`,
      ownerAuthUserId: input.authUserId ?? null,
    })
    .returning();

  await tx
    .insert(memberships)
    .values({ businessId: business.id, userId: user.id, role: "owner" });
  await ensureBusinessBootstrap(tx, business.id);

  return {
    userId: user.id,
    businessId: business.id,
    createdBusiness: true,
    createdUser,
  };
}

/** Links an existing Supabase Auth user to a business, creating one if needed. */
export async function linkAuthUser(
  tx: Tx,
  authUser: { id: string; email: string | null; user_metadata?: Record<string, unknown> | null },
  fallback: { name?: string; businessName?: string } = {},
): Promise<ProvisionResult> {
  const email = (authUser.email ?? "").trim().toLowerCase();
  if (!email) throw new Error("حساب Supabase لا يحتوي بريداً إلكترونياً");
  const metadata = authUser.user_metadata ?? {};
  return provisionAccount(tx, {
    email,
    name:
      (typeof metadata.name === "string" && metadata.name) ||
      fallback.name ||
      email.split("@")[0],
    businessName:
      (typeof metadata.business_name === "string" && metadata.business_name) ||
      fallback.businessName ||
      "نشاطي",
    authUserId: authUser.id,
  });
}

/**
 * Idempotently fills the reference data every business needs. Existing rows are
 * never deleted or overwritten.
 */
export async function ensureBusinessBootstrap(tx: Tx, businessId: string): Promise<void> {
  await tx
    .insert(permissions)
    .values(
      PERMISSION_CATALOG.map((permission) => ({
        key: permission.key,
        labelAr: permission.labelAr,
        groupAr: permission.groupAr,
      })),
    )
    .onConflictDoNothing();

  const roleRows = await tx.select({ key: roles.key }).from(roles).where(eq(roles.businessId, businessId));
  const existingRoles = new Set(roleRows.map((row) => String(row.key)));
  for (const [key, permissionKeys] of Object.entries(ROLE_PERMISSIONS)) {
    if (existingRoles.has(key)) continue;
    const [role] = await tx
      .insert(roles)
      .values({ businessId, key: key as never, nameAr: ROLE_LABELS[key] ?? key })
      .returning();
    if (permissionKeys.length) {
      await tx
        .insert(rolePermissions)
        .values(permissionKeys.map((permissionKey) => ({ roleId: role.id, permissionKey })))
        .onConflictDoNothing();
    }
  }

  const accountRows = await tx
    .select({ code: accounts.code })
    .from(accounts)
    .where(eq(accounts.businessId, businessId));
  const existingAccounts = new Set(accountRows.map((row) => row.code));
  const missingAccounts = SYSTEM_ACCOUNTS.filter((account) => !existingAccounts.has(account.code));
  if (missingAccounts.length) {
    await tx.insert(accounts).values(
      missingAccounts.map((account) => ({
        businessId,
        code: account.code,
        nameAr: account.nameAr,
        type: account.type,
        isSystem: true,
      })),
    );
  }

  const [warehouse] = await tx
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(eq(warehouses.businessId, businessId))
    .limit(1);
  if (!warehouse) {
    await tx.insert(warehouses).values({ businessId, name: "المخزن الرئيسي", isDefault: true });
  }

  const [cashbox] = await tx
    .select({ id: cashboxes.id })
    .from(cashboxes)
    .where(eq(cashboxes.businessId, businessId))
    .limit(1);
  if (!cashbox) {
    await tx.insert(cashboxes).values({ businessId, name: "الصندوق الرئيسي", isDefault: true });
  }

  const [unit] = await tx
    .select({ id: units.id })
    .from(units)
    .where(eq(units.businessId, businessId))
    .limit(1);
  if (!unit) {
    await tx
      .insert(units)
      .values(DEFAULT_UNITS.map((item) => ({ ...item, businessId })))
      .onConflictDoNothing();
  }

  const [category] = await tx
    .select({ id: productCategories.id })
    .from(productCategories)
    .where(eq(productCategories.businessId, businessId))
    .limit(1);
  if (!category) {
    await tx.insert(productCategories).values({ businessId, name: "عام" }).onConflictDoNothing();
  }

  let [freePlan] = await tx
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.name, "Free"))
    .limit(1);
  if (!freePlan) {
    [freePlan] = await tx
      .insert(subscriptionPlans)
      .values({
        name: "Free",
        description: "الأساسيات لإدارة النشاط والبدء باستخدام حساب ذكي.",
        monthlyPriceMinor: 0n,
        yearlyPriceMinor: 0n,
        trialDays: 0,
        maxUsers: 1,
        maxProducts: 100,
        storageLimitMb: 250,
        features: { dashboard: true, products: true, inventory: true, pos: true, reports: true },
      })
      .returning();
  }
  const [subscription] = await tx
    .select({ id: businessSubscriptions.id })
    .from(businessSubscriptions)
    .where(eq(businessSubscriptions.businessId, businessId))
    .limit(1);
  if (!subscription && freePlan) {
    await tx.insert(businessSubscriptions).values({
      businessId,
      planId: freePlan.id,
      status: "active",
      billingPeriod: "monthly",
      expiresAt: null,
    });
  }
}
