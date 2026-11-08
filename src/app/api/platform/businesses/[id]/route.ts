import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { ensureReady } from "@/db/bootstrap";
import { getDb } from "@/db/client";
import { businesses, businessSubscriptions, memberships, subscriptionHistory, subscriptionPayments, subscriptionPlans, users } from "@/db/schema";
import { AppError, ok, route } from "@/server/api";
import { requirePlatformAdmin } from "@/server/auth";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { return route(async () => {
  await ensureReady(); await requirePlatformAdmin(); const id = z.string().uuid().parse((await context.params).id); const db = await getDb();
  const [business] = await db.select().from(businesses).where(eq(businesses.id, id)).limit(1); if (!business) throw new AppError("المؤسسة غير موجودة", 404);
  const [contacts, subscriptions, payments, history] = await Promise.all([
    db.select({ userId: users.id, name: users.name, email: users.email, role: memberships.role, createdAt: memberships.createdAt }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.businessId, id)),
    db.select({ subscription: businessSubscriptions, plan: subscriptionPlans }).from(businessSubscriptions).leftJoin(subscriptionPlans, eq(businessSubscriptions.planId, subscriptionPlans.id)).where(eq(businessSubscriptions.businessId, id)).orderBy(desc(businessSubscriptions.createdAt)),
    db.select().from(subscriptionPayments).where(eq(subscriptionPayments.businessId, id)).orderBy(desc(subscriptionPayments.createdAt)),
    db.select().from(subscriptionHistory).where(eq(subscriptionHistory.businessId, id)).orderBy(desc(subscriptionHistory.createdAt)).limit(100),
  ]);
  return ok({ business, contacts, subscriptions, payments, history });
}); }
