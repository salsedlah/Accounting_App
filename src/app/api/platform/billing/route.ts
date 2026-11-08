import { desc, eq } from "drizzle-orm";
import { ensureReady } from "@/db/bootstrap";
import { getDb } from "@/db/client";
import { businesses, businessSubscriptions, subscriptionPayments, subscriptionPlans } from "@/db/schema";
import { ok, route } from "@/server/api";
import { requirePlatformAdmin } from "@/server/auth";

export async function GET() { return route(async () => { await ensureReady(); await requirePlatformAdmin(); const db = await getDb();
  const payments = await db.select({ payment: subscriptionPayments, business: businesses, plan: subscriptionPlans })
    .from(subscriptionPayments).innerJoin(businesses, eq(subscriptionPayments.businessId, businesses.id))
    .leftJoin(businessSubscriptions, eq(subscriptionPayments.subscriptionId, businessSubscriptions.id))
    .leftJoin(subscriptionPlans, eq(businessSubscriptions.planId, subscriptionPlans.id)).orderBy(desc(subscriptionPayments.createdAt)).limit(500);
  return ok(payments); }); }
