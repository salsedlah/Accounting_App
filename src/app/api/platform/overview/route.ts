import { desc, eq } from "drizzle-orm";
import { ensureReady } from "@/db/bootstrap";
import { getDb } from "@/db/client";
import { businesses, businessSubscriptions, memberships, subscriptionPayments, subscriptionPlans, users } from "@/db/schema";
import { requirePlatformAdmin } from "@/server/auth";
import { ok, route } from "@/server/api";

export async function GET() {
  return route(async () => {
    await ensureReady();
    await requirePlatformAdmin();
    const db = await getDb();
    const [allBusinesses, subs, plans, payments, owners] = await Promise.all([
      db.select().from(businesses).orderBy(desc(businesses.createdAt)),
      db.select({ subscription: businessSubscriptions, plan: subscriptionPlans }).from(businessSubscriptions)
        .leftJoin(subscriptionPlans, eq(businessSubscriptions.planId, subscriptionPlans.id)),
      db.select().from(subscriptionPlans).orderBy(desc(subscriptionPlans.createdAt)),
      db.select().from(subscriptionPayments).orderBy(desc(subscriptionPayments.createdAt)),
      db.select({ businessId: memberships.businessId, owner: users.name, email: users.email })
        .from(memberships).innerJoin(users, eq(memberships.userId, users.id)).where(eq(memberships.role, "owner")),
    ]);
    const today = new Date();
    const validSubs = subs.map(({ subscription, plan }) => ({
      ...subscription,
      status: subscription.expiresAt && subscription.expiresAt < today && subscription.status !== "cancelled" && subscription.status !== "suspended" ? "expired" : subscription.status,
      planName: plan?.name ?? "بدون باقة",
      plan,
    }));
    const current = validSubs.filter((s) => s.status === "active" || s.status === "trial");
    const active = current.filter((s) => s.status === "active");
    const paidVerified = payments.filter((p) => p.status === "verified");
    const pending = payments.filter((p) => p.status === "pending");
    const mrr = active.filter((s) => s.billingPeriod === "monthly").reduce((sum, s) => sum + Number(s.plan?.monthlyPriceMinor ?? 0), 0)
      + active.filter((s) => s.billingPeriod === "yearly").reduce((sum, s) => sum + Number(s.plan?.yearlyPriceMinor ?? 0) / 12, 0);
    const yearly = active.filter((s) => s.billingPeriod === "yearly").reduce((sum, s) => sum + Number(s.plan?.yearlyPriceMinor ?? 0), 0);
    const ownerByBusiness = new Map(owners.map((owner) => [owner.businessId, owner]));
    const businessRows = allBusinesses.map((business) => ({ ...business, owner: ownerByBusiness.get(business.id) ?? null }));
    const expiring = validSubs.filter((s) => s.status === "active" && s.expiresAt && s.expiresAt.getTime() > today.getTime() && s.expiresAt.getTime() < today.getTime() + 30 * 86400000);
    const monthlyGrowth = Array.from({ length: 6 }, (_, i) => {
      const start = new Date(today.getFullYear(), today.getMonth() - 5 + i, 1);
      const end = new Date(today.getFullYear(), today.getMonth() - 4 + i, 1);
      return { month: start.toLocaleDateString("ar", { month: "short" }), businesses: allBusinesses.filter((b) => b.createdAt >= start && b.createdAt < end).length,
        revenue: paidVerified.filter((p) => p.createdAt >= start && p.createdAt < end).reduce((sum, p) => sum + Number(p.amountMinor), 0) };
    });
    return ok({ metrics: { businesses: allBusinesses.length, active: active.length, expired: validSubs.filter((s) => s.status === "expired").length,
      trial: validSubs.filter((s) => s.status === "trial").length, mrr, yearly, collected: paidVerified.reduce((sum, p) => sum + Number(p.amountMinor), 0),
      pending: pending.reduce((sum, p) => sum + Number(p.amountMinor), 0), expiring: expiring.length },
      businesses: businessRows.slice(0, 8), subscriptions: validSubs, plans, payments, chart: monthlyGrowth });
  });
}
