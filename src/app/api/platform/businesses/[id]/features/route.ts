import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { ensureReady } from "@/db/bootstrap";
import { getDb } from "@/db/client";
import { businesses, businessFeatureOverrides, businessSubscriptions, platformAuditLogs, subscriptionHistory, subscriptionPlans } from "@/db/schema";
import { AppError, ok, readJson, route } from "@/server/api";
import { requirePlatformAdmin } from "@/server/auth";

const inputSchema = z.object({ featureKey: z.string().min(1).max(80), enabled: z.boolean() });
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) { return route(async () => {
  await ensureReady(); const actor = await requirePlatformAdmin(); const id = z.string().uuid().parse((await context.params).id); const input = inputSchema.parse(await readJson(request)); const db = await getDb();
  const [business] = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, id)).limit(1);
  if (!business) throw new AppError("المؤسسة غير موجودة", 404);
  const override = await db.transaction(async (tx) => { const [saved] = await tx.insert(businessFeatureOverrides).values({ businessId: id, ...input }).onConflictDoUpdate({ target: [businessFeatureOverrides.businessId, businessFeatureOverrides.featureKey], set: { enabled: input.enabled, createdAt: new Date() } }).returning();
    await tx.insert(subscriptionHistory).values({ businessId: id, actorUserId: actor.userId, action: "feature.override", details: input });
    await tx.insert(platformAuditLogs).values({ actorUserId: actor.userId, action: input.enabled ? "feature.enabled" : "feature.disabled", entityType: "business_feature", entityId: id, details: input }); return saved; });
  return ok(override);
}); }

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { return route(async () => {
  await ensureReady(); await requirePlatformAdmin(); const id = z.string().uuid().parse((await context.params).id); const db = await getDb();
  const [sub, overrides] = await Promise.all([
    db.select({ subscription: businessSubscriptions, plan: subscriptionPlans }).from(businessSubscriptions).leftJoin(subscriptionPlans, eq(businessSubscriptions.planId, subscriptionPlans.id)).where(eq(businessSubscriptions.businessId, id)).orderBy(desc(businessSubscriptions.createdAt)).limit(1),
    db.select().from(businessFeatureOverrides).where(eq(businessFeatureOverrides.businessId, id)),
  ]);
  const features = { ...(sub[0]?.plan?.features ?? {}) } as Record<string, boolean>;
  for (const override of overrides) features[override.featureKey] = override.enabled;
  return ok(features);
}); }
