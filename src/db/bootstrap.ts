import { getDb } from "./client";
import { ensureSeed } from "./seed";
import { businesses, businessSubscriptions, permissions, subscriptionPlans } from "./schema";
import { eq } from "drizzle-orm";
import { PERMISSION_CATALOG } from "@/lib/constants";

let ready: Promise<void> | undefined;

/** Runs migrations (via getDb) and the idempotent demo seed exactly once. */
export function ensureReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await getDb();
      await ensureInitialPlans();
      const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
      const isRemotePostgres = /^postgres(ql)?:\/\//i.test(databaseUrl);
      // A remote production database must never receive the local demo business,
      // users, and sample transactions implicitly during application startup.
      if (isRemotePostgres && process.env.ALLOW_DEMO_SEED !== "true") return;
      await ensureSeed();
      // The local seed may create its demo business after the first plan pass.
      await ensureInitialPlans();
    })().catch((error) => {
      ready = undefined;
      throw error;
    });
  }
  return ready;
}

async function ensureInitialPlans() {
  const db = await getDb();
  await db.insert(permissions).values(PERMISSION_CATALOG).onConflictDoNothing();
  await db.insert(subscriptionPlans).values([
    { name: "Free", description: "الأساسيات لإدارة النشاط والبدء باستخدام حساب ذكي.", monthlyPriceMinor: 0n, yearlyPriceMinor: 0n, trialDays: 0, maxUsers: 1, maxProducts: 100, storageLimitMb: 250, features: { dashboard: true, products: true, inventory: true, pos: true, reports: true } },
    { name: "Plus", description: "إدارة متقدمة للمخزون والعملاء والمزامنة السحابية.", monthlyPriceMinor: 0n, yearlyPriceMinor: 0n, trialDays: 7, maxUsers: 5, maxProducts: 0, storageLimitMb: 5000, features: { dashboard: true, products: true, inventory: true, pos: true, purchases: true, customers: true, customer_debts: true, suppliers: true, supplier_debts: true, expenses: true, cashbox: true, invoices: true, stocktaking: true, reports: true, barcode: true, cloud_sync: true, pdf_invoices: true } },
    { name: "Premium", description: "كامل أدوات المحاسبة والتقارير والتحليلات والصلاحيات.", monthlyPriceMinor: 0n, yearlyPriceMinor: 0n, trialDays: 14, maxUsers: 0, maxProducts: 0, storageLimitMb: 20000, features: { dashboard: true, products: true, inventory: true, pos: true, purchases: true, customers: true, customer_debts: true, suppliers: true, supplier_debts: true, expenses: true, cashbox: true, invoices: true, stocktaking: true, reports: true, advanced_reports: true, barcode: true, cloud_sync: true, pdf_invoices: true, accounting: true, ai_assistant: true, advanced_permissions: true, analytics: true } },
  ]).onConflictDoNothing({ target: subscriptionPlans.name });
  const [free] = await db.select({ id: subscriptionPlans.id }).from(subscriptionPlans).where(eq(subscriptionPlans.name, "Free")).limit(1);
  if (!free) return;
  const [allBusinesses, allSubscriptions] = await Promise.all([db.select({ id: businesses.id }).from(businesses), db.select({ businessId: businessSubscriptions.businessId }).from(businessSubscriptions)]);
  const assigned = new Set(allSubscriptions.map((s) => s.businessId));
  const missing = allBusinesses.filter((b) => !assigned.has(b.id));
  if (missing.length) await db.insert(businessSubscriptions).values(missing.map((b) => ({ businessId: b.id, planId: free.id, status: "active" as const, billingPeriod: "monthly", expiresAt: null })));
}
