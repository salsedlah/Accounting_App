import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ensureReady } from "@/db/bootstrap";
import { getDb } from "@/db/client";
import { businessSubscriptions, platformAuditLogs, subscriptionPlans } from "@/db/schema";
import { AppError, ok, readJson, route } from "@/server/api";
import { requirePlatformAdmin } from "@/server/auth";

const planInput = z.object({ name: z.string().trim().min(2).max(60), description: z.string().max(500).default(""),
  monthlyPriceMinor: z.coerce.number().int().min(0), yearlyPriceMinor: z.coerce.number().int().min(0), currency: z.string().trim().length(3),
  trialDays: z.coerce.number().int().min(0).max(365), maxUsers: z.coerce.number().int().min(0), maxProducts: z.coerce.number().int().min(0),
  storageLimitMb: z.coerce.number().int().min(0), features: z.record(z.string(), z.boolean()), isActive: z.boolean().default(true) });

export async function GET() { return route(async () => { await ensureReady(); await requirePlatformAdmin();
  const db = await getDb(); return ok(await db.select().from(subscriptionPlans)); }); }

export async function POST(request: Request) { return route(async () => { await ensureReady(); const actor = await requirePlatformAdmin();
  const input = planInput.parse(await readJson(request)); const db = await getDb();
  const plan = await db.transaction(async (tx) => { const [created] = await tx.insert(subscriptionPlans).values({ ...input, monthlyPriceMinor: BigInt(input.monthlyPriceMinor), yearlyPriceMinor: BigInt(input.yearlyPriceMinor) }).returning();
    await tx.insert(platformAuditLogs).values({ actorUserId: actor.userId, action: "plan.created", entityType: "subscription_plan", entityId: created.id, details: { name: created.name } }); return created; }); return ok(plan, 201); }); }

export async function PATCH(request: Request) { return route(async () => { await ensureReady(); const actor = await requirePlatformAdmin();
  const body = await readJson<{ id: string } & z.input<typeof planInput>>(request); const id = z.string().uuid().parse(body.id); const input = planInput.parse(body); const db = await getDb();
  const plan = await db.transaction(async (tx) => { const [updated] = await tx.update(subscriptionPlans).set({ ...input, monthlyPriceMinor: BigInt(input.monthlyPriceMinor), yearlyPriceMinor: BigInt(input.yearlyPriceMinor), updatedAt: new Date() }).where(eq(subscriptionPlans.id, id)).returning();
    if (!updated) throw new AppError("الباقة غير موجودة", 404); await tx.insert(platformAuditLogs).values({ actorUserId: actor.userId, action: "plan.updated", entityType: "subscription_plan", entityId: id, details: { name: updated.name } }); return updated; }); return ok(plan); }); }

export async function DELETE(request: Request) { return route(async () => { await ensureReady(); const actor = await requirePlatformAdmin();
  const id = z.string().uuid().parse(new URL(request.url).searchParams.get("id")); const db = await getDb();
  await db.transaction(async (tx) => { const [use] = await tx.select({ count: sql<number>`count(*)::int` }).from(businessSubscriptions).where(eq(businessSubscriptions.planId, id));
    if (use.count > 0) throw new AppError("لا يمكن حذف باقة مرتبطة باشتراكات؛ يمكنك إيقافها بدلاً من ذلك", 409);
    const [deleted] = await tx.delete(subscriptionPlans).where(eq(subscriptionPlans.id, id)).returning({ id: subscriptionPlans.id });
    if (!deleted) throw new AppError("الباقة غير موجودة", 404); await tx.insert(platformAuditLogs).values({ actorUserId: actor.userId, action: "plan.deleted", entityType: "subscription_plan", entityId: id }); }); return ok({ ok: true }); }); }
