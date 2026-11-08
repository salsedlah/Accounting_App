import { and, desc, eq, sql } from "drizzle-orm";
import { ensureReady } from "@/db/bootstrap";
import { getDb } from "@/db/client";
import { businessFeatureOverrides, businessSubscriptions, products, subscriptionPlans, users, memberships } from "@/db/schema";
import { requireSession } from "@/server/auth";
import { ok, route } from "@/server/api";

export async function GET() { return route(async () => { await ensureReady(); const session = await requireSession(); const db = await getDb();
  const [row] = await db.select({ subscription: businessSubscriptions, plan: subscriptionPlans }).from(businessSubscriptions)
    .leftJoin(subscriptionPlans, eq(businessSubscriptions.planId, subscriptionPlans.id)).where(eq(businessSubscriptions.businessId, session.businessId))
    .orderBy(desc(businessSubscriptions.createdAt)).limit(1);
  const [overrides, userCount, productCount, owner] = await Promise.all([
    db.select().from(businessFeatureOverrides).where(eq(businessFeatureOverrides.businessId, session.businessId)),
    db.select({ count: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.businessId, session.businessId)),
    db.select({ count: sql<number>`count(*)::int` }).from(products).where(eq(products.businessId, session.businessId)),
    db.select({ email: users.email }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.businessId, session.businessId), eq(memberships.role, "owner"))).limit(1),
  ]);
  const now = new Date(); const expired = Boolean(row?.subscription.expiresAt && row.subscription.expiresAt < now) || row?.subscription.status === "expired";
  const status = expired && row?.subscription.status !== "cancelled" && row?.subscription.status !== "suspended" ? "expired" : row?.subscription.status ?? "unassigned";
  const entitled = !expired && (status === "active" || status === "trial");
  const [freePlan] = entitled || !row ? [] : await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.name, "Free")).limit(1);
  const effectivePlan = entitled ? row?.plan : freePlan;
  const effectiveFeatures = { ...(effectivePlan?.features ?? {}) } as Record<string, boolean>; for (const override of overrides) effectiveFeatures[override.featureKey] = override.enabled;
  const remainingDays = row?.subscription.expiresAt ? Math.max(0, Math.ceil((row.subscription.expiresAt.getTime() - now.getTime()) / 86400000)) : null;
  return ok({ plan: row?.plan ?? null, status, startedAt: row?.subscription.startedAt ?? null, expiresAt: row?.subscription.expiresAt ?? null,
    remainingDays, features: effectiveFeatures, limits: { maxUsers: effectivePlan?.maxUsers ?? 0, maxProducts: effectivePlan?.maxProducts ?? 0,
      storageLimitMb: effectivePlan?.storageLimitMb ?? 0, users: userCount[0]?.count ?? 0, products: productCount[0]?.count ?? 0 },
    billingEmail: owner[0]?.email ?? session.email, paymentGatewayConnected: false });
}); }
