import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { ensureReady } from "@/db/bootstrap";
import { getDb } from "@/db/client";
import { accounts, businesses, businessSubscriptions, cashboxes, memberships, permissions as permissionsTable, platformAuditLogs, rolePermissions, roles, subscriptionHistory, subscriptionPayments, subscriptionPlans, units, users, warehouses } from "@/db/schema";
import { AppError, ok, readJson, route } from "@/server/api";
import { requirePlatformAdmin, hashPassword } from "@/server/auth";
import { PERMISSION_CATALOG, ROLE_LABELS, ROLE_PERMISSIONS, SYSTEM_ACCOUNTS } from "@/lib/constants";

const createBusinessSchema = z.object({
  businessName: z.string().trim().min(2).max(200),
  ownerName: z.string().trim().min(2).max(150),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().max(40).optional().default(""),
  address: z.string().trim().max(300).optional().default(""),
  password: z.string().min(8).max(200),
  planId: z.string().uuid(),
  billingPeriod: z.enum(["monthly", "yearly"]).default("monthly"),
});

export async function POST(request: Request) { return route(async () => {
  await ensureReady(); const actor = await requirePlatformAdmin(); const input = createBusinessSchema.parse(await readJson(request)); const db = await getDb();
  const email = input.email.toLowerCase(); const passwordHash = await hashPassword(input.password);
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) throw new AppError("هذا البريد الإلكتروني مسجل بالفعل. استخدم بريداً آخر لصاحب المؤسسة.", 409);
    const [plan] = await tx.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, input.planId)).limit(1);
    if (!plan?.isActive) throw new AppError("اختر باقة نشطة", 422);
    const [business] = await tx.insert(businesses).values({ name: input.businessName, phone: input.phone || null, address: input.address || null }).returning();
    const [owner] = await tx.insert(users).values({ email, name: input.ownerName, passwordHash }).returning();
    await tx.insert(memberships).values({ businessId: business.id, userId: owner.id, role: "owner" });
    await tx.insert(permissionsTable).values(PERMISSION_CATALOG.map((p) => ({ key: p.key, labelAr: p.labelAr, groupAr: p.groupAr }))).onConflictDoNothing();
    for (const [roleKey, permissionKeys] of Object.entries(ROLE_PERMISSIONS)) {
      const [role] = await tx.insert(roles).values({ businessId: business.id, key: roleKey as never, nameAr: ROLE_LABELS[roleKey] ?? roleKey }).returning();
      if (permissionKeys.length) await tx.insert(rolePermissions).values(permissionKeys.map((permissionKey) => ({ roleId: role.id, permissionKey })));
    }
    await tx.insert(accounts).values(SYSTEM_ACCOUNTS.map((account) => ({ ...account, businessId: business.id, isSystem: true })));
    await tx.insert(units).values({ businessId: business.id, name: "قطعة", symbol: "pc", kind: "count" });
    await tx.insert(warehouses).values({ businessId: business.id, name: "المستودع الرئيسي", isDefault: true });
    await tx.insert(cashboxes).values({ businessId: business.id, name: "الصندوق الرئيسي", isDefault: true });
    const now = new Date(); const durationDays = input.billingPeriod === "yearly" ? 365 : 30;
    const expiresAt = new Date(now); expiresAt.setDate(expiresAt.getDate() + durationDays);
    const amount = input.billingPeriod === "yearly" ? plan.yearlyPriceMinor : plan.monthlyPriceMinor;
    const pendingPayment = amount > 0n;
    const status = pendingPayment ? "pending_payment" as const : "active" as const;
    const [subscription] = await tx.insert(businessSubscriptions).values({ businessId: business.id, planId: plan.id, status, billingPeriod: input.billingPeriod, startedAt: now, expiresAt: pendingPayment ? null : expiresAt }).returning();
    if (pendingPayment) await tx.insert(subscriptionPayments).values({ businessId: business.id, subscriptionId: subscription.id, amountMinor: amount, currency: plan.currency, status: "pending", provider: "manual_pending" });
    await tx.insert(subscriptionHistory).values({ businessId: business.id, actorUserId: actor.userId, action: "business.created", details: { planId: plan.id, planName: plan.name, status, billingPeriod: input.billingPeriod } });
    await tx.insert(platformAuditLogs).values({ actorUserId: actor.userId, action: "business.created", entityType: "business", entityId: business.id, details: { email, planId: plan.id, status } });
    return { id: business.id, name: business.name, owner: { name: owner.name, email: owner.email }, plan: plan.name, status, expiresAt: pendingPayment ? null : expiresAt };
  });
  return ok(result, 201);
}); }

export async function GET() { return route(async () => { await ensureReady(); await requirePlatformAdmin(); const db = await getDb();
  const [rows, owners, subs] = await Promise.all([db.select().from(businesses).orderBy(desc(businesses.createdAt)),
    db.select({ businessId: memberships.businessId, name: users.name, email: users.email }).from(memberships).innerJoin(users, eq(memberships.userId, users.id)).where(eq(memberships.role, "owner")),
    db.select({ subscription: businessSubscriptions, plan: subscriptionPlans }).from(businessSubscriptions).leftJoin(subscriptionPlans, eq(businessSubscriptions.planId, subscriptionPlans.id)).orderBy(desc(businessSubscriptions.createdAt))]);
  const ownerMap = new Map(owners.map(x => [x.businessId, x])); const subMap = new Map<string, (typeof subs)[number]>();
  for (const s of subs) if (!subMap.has(s.subscription.businessId)) subMap.set(s.subscription.businessId, s);
  const now = new Date();
  return ok(rows.map(b => { const latest = subMap.get(b.id) ?? null; const subStatus = latest?.subscription.status;
    const derivedStatus = latest?.subscription.expiresAt && latest.subscription.expiresAt < now && subStatus !== "cancelled" && subStatus !== "suspended" ? "expired" : subStatus;
    return { ...b, owner: ownerMap.get(b.id) ?? null, subscription: latest ? { ...latest, subscription: { ...latest.subscription, status: derivedStatus } } : null };
  })); }); }

const change = z.discriminatedUnion("action", [
  z.object({ action: z.literal("suspend") }),
  z.object({ action: z.literal("activate") }),
  z.object({ action: z.literal("trial"), planId: z.string().uuid(), trialDays: z.coerce.number().int().min(1).max(365) }),
  z.object({ action: z.literal("assign"), planId: z.string().uuid(), billingPeriod: z.enum(["monthly", "yearly"]) }),
  z.object({ action: z.literal("extend"), days: z.coerce.number().int().min(1).max(3650) }),
  z.object({ action: z.literal("limits"), maxUsers: z.coerce.number().int().min(0).nullable(), maxProducts: z.coerce.number().int().min(0).nullable() }),
]);
export async function PATCH(request: Request) { return route(async () => { await ensureReady(); const actor = await requirePlatformAdmin(); const input = change.parse(await readJson(request)); const id = z.string().uuid().parse(new URL(request.url).searchParams.get("id")); const db = await getDb();
  const [business] = await db.select().from(businesses).where(eq(businesses.id, id)).limit(1); if (!business) throw new AppError("المؤسسة غير موجودة", 404);
  if (input.action === "suspend" || input.action === "activate") {
    const value = input.action === "suspend" ? "suspended" : "active"; await db.transaction(async (tx) => { await tx.update(businesses).set({ platformStatus: value }).where(eq(businesses.id, id));
      await tx.insert(platformAuditLogs).values({ actorUserId: actor.userId, action: input.action === "suspend" ? "business.suspended" : "business.activated", entityType: "business", entityId: id }); });
    return ok({ status: value });
  }
  if (input.action === "extend") {
    const [latest] = await db.select().from(businessSubscriptions).where(eq(businessSubscriptions.businessId, id)).orderBy(desc(businessSubscriptions.createdAt)).limit(1);
    if (!latest) throw new AppError("لا يوجد اشتراك لتمديده", 409);
    const now = new Date(); const expires = new Date(Math.max(latest.expiresAt?.getTime() ?? now.getTime(), now.getTime())); expires.setDate(expires.getDate() + input.days);
    const sub = await db.transaction(async (tx) => { const [updated] = await tx.update(businessSubscriptions).set({ expiresAt: expires }).where(eq(businessSubscriptions.id, latest.id)).returning();
      await tx.insert(subscriptionHistory).values({ businessId: id, actorUserId: actor.userId, action: "subscription.extended", details: { days: input.days, expiresAt: expires.toISOString() } });
      await tx.insert(platformAuditLogs).values({ actorUserId: actor.userId, action: "subscription.extended", entityType: "business_subscription", entityId: updated.id, details: { businessId: id, days: input.days } }); return updated; });
    return ok(sub);
  }
  if (input.action === "limits") {
    const details = { maxUsers: input.maxUsers, maxProducts: input.maxProducts };
    await db.transaction(async (tx) => { await tx.update(businesses).set({ maxUsersOverride: input.maxUsers, maxProductsOverride: input.maxProducts }).where(eq(businesses.id, id));
      await tx.insert(subscriptionHistory).values({ businessId: id, actorUserId: actor.userId, action: "limits.changed", details });
      await tx.insert(platformAuditLogs).values({ actorUserId: actor.userId, action: "business.limits_changed", entityType: "business", entityId: id, details }); });
    return ok(details);
  }
  const [plan] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, input.planId)).limit(1); if (!plan || !plan.isActive) throw new AppError("اختر باقة نشطة", 422);
  const now = new Date();
  const isTrial = input.action === "trial";
  const period = input.action === "assign" ? input.billingPeriod : "monthly";
  const days = input.action === "trial" ? input.trialDays : period === "yearly" ? 365 : 30;
  const expires = new Date(now); expires.setDate(expires.getDate() + days);
  // A paid plan remains pending until a payment provider verifies its payment.
  const due = input.action === "assign" && Number(period === "yearly" ? plan.yearlyPriceMinor : plan.monthlyPriceMinor) > 0;
  const subscriptionStatus = isTrial ? "trial" as const : due ? "pending_payment" as const : "active" as const;
  const billingPeriod = period;
  const actionName = isTrial ? "trial.granted" : "plan.assigned";
  const sub = await db.transaction(async (tx) => { const [created] = await tx.insert(businessSubscriptions).values({ businessId: id, planId: plan.id, status: subscriptionStatus, billingPeriod, startedAt: now, expiresAt: due ? null : expires }).returning();
    if (due) await tx.insert(subscriptionPayments).values({ businessId: id, subscriptionId: created.id, amountMinor: billingPeriod === "yearly" ? plan.yearlyPriceMinor : plan.monthlyPriceMinor, currency: plan.currency, status: "pending", provider: "manual_pending" });
    await tx.insert(subscriptionHistory).values({ businessId: id, actorUserId: actor.userId, action: actionName, details: { planId: plan.id, billingPeriod, status: subscriptionStatus, expiresAt: due ? null : expires.toISOString() } });
    await tx.insert(platformAuditLogs).values({ actorUserId: actor.userId, action: isTrial ? "subscription.trial_granted" : "subscription.plan_assigned", entityType: "business_subscription", entityId: created.id, details: { businessId: id, planId: plan.id, billingPeriod, status: subscriptionStatus } }); return created; });
  return ok(sub, 201); }); }
