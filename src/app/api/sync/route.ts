import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ensureReady } from "@/db/bootstrap";
import { getDb, type Tx } from "@/db/client";
import { syncOperations } from "@/db/schema";
import { AppError, ok, readJson, route } from "@/server/api";
import { requireBusinessFeature, requireSession, type Session } from "@/server/auth";
import { createSale } from "@/server/services/sales";
import { createPurchase } from "@/server/services/purchases";
import { createExpense } from "@/server/services/expenses";
import { createPayment } from "@/server/services/payments";
import { createCustomer, createCustomerDebt, createSupplier } from "@/server/services/parties";
import { createProduct } from "@/server/services/products";
import { adjustStock } from "@/server/services/inventory-ops";
import { createStocktake } from "@/server/services/stocktaking";
import { createManualCash } from "@/server/services/cashbox";

const operationTypes = [
  "sale.create", "purchase.create", "expense.create", "payment.create",
  "customer.create", "supplier.create", "product.create", "debt.create",
  "inventory.adjust", "cashbox.manual", "stocktaking.create",
] as const;

const operationSchema = z.object({
  operationId: z.string().min(8).max(120),
  type: z.enum(operationTypes),
  payload: z.record(z.string(), z.unknown()),
});

const schema = z.object({
  deviceId: z.string().max(120).optional(),
  operations: z.array(operationSchema).min(1).max(50),
});

type Op = z.infer<typeof operationSchema>;

async function loadOperation(tx: Tx, businessId: string, op: Op) {
  const [row] = await tx
    .select()
    .from(syncOperations)
    .where(
      and(
        eq(syncOperations.businessId, businessId),
        eq(syncOperations.operationId, op.operationId),
      ),
    );
  return row;
}

async function processOperation(
  session: Session,
  op: Op,
  deviceId: string | undefined,
) {
  const db = await getDb();
  const inserted = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(syncOperations)
      .values({
        businessId: session.businessId,
        operationId: op.operationId,
        idempotencyKey: String(op.payload.idempotencyKey ?? op.operationId),
        type: op.type,
        status: "pending",
        deviceId,
        payload: op.payload,
      })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  });

  const existing = inserted ? null : await db.transaction((tx) => loadOperation(tx, session.businessId, op));
  if (existing?.status === "done") {
    return {
      operationId: op.operationId,
      status: "done" as const,
      result: existing.result,
      duplicate: true,
    };
  }
  if (existing?.status === "conflict") {
    return {
      operationId: op.operationId,
      status: "conflict" as const,
      error: existing.error,
    };
  }

  try {
    const result = await db.transaction(async (tx) => {
      let summary: unknown;
      switch (op.type) {
        case "sale.create": {
          const created = await createSale(tx, session, { ...op.payload, offline: true });
          summary = { id: created.sale.id, invoiceNo: created.sale.invoiceNo };
          break;
        }
        case "purchase.create": summary = await createPurchase(tx, session, op.payload); break;
        case "expense.create": summary = await createExpense(tx, session, op.payload); break;
        case "payment.create": summary = await createPayment(tx, session, op.payload); break;
        case "customer.create": summary = await createCustomer(tx, session, op.payload); break;
        case "supplier.create": summary = await createSupplier(tx, session, op.payload); break;
        case "product.create": summary = await createProduct(tx, session, op.payload); break;
        case "debt.create": summary = await createCustomerDebt(tx, session, op.payload); break;
        case "inventory.adjust": summary = await adjustStock(tx, session, op.payload); break;
        case "cashbox.manual": summary = await createManualCash(tx, session, op.payload); break;
        case "stocktaking.create": summary = await createStocktake(tx, session, op.payload); break;
      }
      summary = JSON.parse(
        JSON.stringify(summary, (_key, value) => typeof value === "bigint" ? value.toString() : value),
      );
      await tx
        .update(syncOperations)
        .set({ status: "done", result: summary, processedAt: new Date(), error: null })
        .where(
          and(
            eq(syncOperations.businessId, session.businessId),
            eq(syncOperations.operationId, op.operationId),
          ),
        );
      return summary;
    });
    return { operationId: op.operationId, status: "done" as const, result };
  } catch (error) {
    const message =
      error instanceof AppError
        ? error.message
        : error instanceof z.ZodError
          ? "بيانات العملية غير صالحة"
          : "تعذر ترحيل العملية";
    const status = error instanceof AppError && error.status < 500 ? "conflict" : "failed";
    await db.transaction((tx) =>
      tx
        .update(syncOperations)
        .set({ status, error: message, processedAt: new Date() })
        .where(
          and(
            eq(syncOperations.businessId, session.businessId),
            eq(syncOperations.operationId, op.operationId),
          ),
        ),
    );
    return { operationId: op.operationId, status, error: message };
  }
}

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requireSession();
    const input = schema.parse(await readJson(request));
    const operationFeatures: Record<(typeof operationTypes)[number], string> = {
      "sale.create": "pos", "purchase.create": "purchases", "expense.create": "expenses", "payment.create": "customer_debts",
      "customer.create": "customers", "supplier.create": "suppliers", "product.create": "products", "debt.create": "customer_debts",
      "inventory.adjust": "inventory", "cashbox.manual": "cashbox", "stocktaking.create": "stocktaking",
    };
    for (const feature of new Set(input.operations.map((op) => operationFeatures[op.type]))) await requireBusinessFeature(session, feature);
    const results = [];
    for (const op of input.operations) {
      results.push(await processOperation(session, op, input.deviceId));
    }
    return ok({
      results,
      done: results.filter((r) => r.status === "done").length,
      failed: results.filter((r) => r.status !== "done").length,
    });
  });
}
