import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db/client";
import {
  inventoryBalances,
  products,
  stocktakingItems,
  stocktakingSessions,
  units,
} from "@/db/schema";
import { ACCOUNT_CODES, PERMISSIONS, can } from "@/lib/constants";
import { postJournal, type JournalLineInput } from "@/lib/accounting";
import { issueStock, receiveStock } from "@/lib/inventory";
import { mulDiv } from "@/lib/money";
import { parseQty } from "@/lib/quantity";
import { AppError } from "@/server/api";
import type { Session } from "@/server/auth";
import { defaultWarehouse, loadBusiness, memberCan, writeAudit } from "./common";

export const createStocktakeSchema = z.object({
  warehouseId: z.string().uuid().nullish(),
  scope: z.enum(["full", "category", "products"]).default("full"),
  categoryId: z.string().uuid().nullish(),
  productIds: z.array(z.string().uuid()).optional(),
  title: z.string().min(1).max(200),
  notes: z.string().max(500).optional(),
});

export const saveCountsSchema = z.object({
  sessionId: z.string().uuid(),
  counts: z.array(
    z.object({ itemId: z.string().uuid(), countedQty: z.string().min(1) }),
  ),
});

export async function createStocktake(tx: Tx, session: Session, raw: unknown) {
  const input = createStocktakeSchema.parse(raw);
  if (!(await memberCan(tx, session, PERMISSIONS.stocktakingManage))) {
    throw new AppError("لا تملك صلاحية إدارة الجرد", 403);
  }
  const warehouse = await defaultWarehouse(tx, session.businessId, input.warehouseId);

  const filters = [
    eq(products.businessId, session.businessId),
    eq(products.isActive, true),
  ];
  if (input.scope === "category" && input.categoryId) {
    filters.push(eq(products.categoryId, input.categoryId));
  }
  if (input.scope === "products" && input.productIds?.length) {
    filters.push(inArray(products.id, input.productIds));
  }

  const rows = await tx
    .select({
      id: products.id,
      purchaseCost: products.purchaseCostMinor,
      qty: inventoryBalances.qtyMilli,
      value: inventoryBalances.valueMinor,
    })
    .from(products)
    .leftJoin(
      inventoryBalances,
      and(
        eq(inventoryBalances.productId, products.id),
        eq(inventoryBalances.warehouseId, warehouse.id),
      ),
    )
    .where(and(...filters));

  if (rows.length === 0) throw new AppError("لا توجد منتجات ضمن نطاق الجرد", 422);

  const [created] = await tx
    .insert(stocktakingSessions)
    .values({
      businessId: session.businessId,
      warehouseId: warehouse.id,
      scope: input.scope,
      title: input.title,
      status: "counting",
      createdBy: session.userId,
      notes: input.notes ?? null,
    })
    .returning();

  await tx.insert(stocktakingItems).values(
    rows.map((p) => {
      const qty = p.qty ?? 0n;
      const value = p.value ?? 0n;
      const unitCost = qty > 0n ? mulDiv(value, 1000n, qty) : p.purchaseCost;
      return {
        sessionId: created.id,
        productId: p.id,
        expectedQtyMilli: qty,
        countedQtyMilli: null,
        varianceQtyMilli: null,
        unitCostMinor: unitCost,
        varianceValueMinor: 0n,
      };
    }),
  );

  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "stocktaking.create",
    entityType: "stocktaking_session",
    entityId: created.id,
    after: { title: input.title, scope: input.scope, warehouseId: warehouse.id },
  });

  return created;
}

export async function saveStocktakeCounts(tx: Tx, session: Session, raw: unknown) {
  const input = saveCountsSchema.parse(raw);
  const st = await loadSession(tx, session.businessId, input.sessionId);
  if (st.status === "posted" || st.status === "cancelled") {
    throw new AppError("لا يمكن تعديل جرد مرحّل أو ملغى", 409);
  }
  if (!(await memberCan(tx, session, PERMISSIONS.stocktakingManage))) {
    throw new AppError("لا تملك صلاحية إدارة الجرد", 403);
  }

  const items = await tx
    .select()
    .from(stocktakingItems)
    .where(eq(stocktakingItems.sessionId, st.id));
  const byId = new Map(items.map((i) => [i.id, i]));

  for (const count of input.counts) {
    const item = byId.get(count.itemId);
    if (!item) throw new AppError("بند الجرد غير موجود ضمن هذه الجلسة", 404);
    const counted = parseQty(count.countedQty);
    if (counted < 0n) throw new AppError("الكمية المجرودة لا يمكن أن تكون سالبة");
    const variance = counted - item.expectedQtyMilli;
    const varianceValue = mulDiv(variance, item.unitCostMinor, 1000n);
    await tx
      .update(stocktakingItems)
      .set({
        countedQtyMilli: counted,
        varianceQtyMilli: variance,
        varianceValueMinor: varianceValue,
      })
      .where(eq(stocktakingItems.id, item.id));
  }

  if (st.status === "pending_approval") {
    await tx
      .update(stocktakingSessions)
      .set({ status: "counting" })
      .where(eq(stocktakingSessions.id, st.id));
  }

  return { ok: true };
}

export async function submitStocktake(tx: Tx, session: Session, sessionId: string) {
  if (!(await memberCan(tx, session, PERMISSIONS.stocktakingManage))) {
    throw new AppError("لا تملك صلاحية إدارة الجرد", 403);
  }
  const st = await loadSession(tx, session.businessId, sessionId);
  if (st.status !== "counting" && st.status !== "draft") {
    throw new AppError("حالة الجلسة لا تسمح بالإرسال للاعتماد", 409);
  }
  const items = await tx
    .select()
    .from(stocktakingItems)
    .where(eq(stocktakingItems.sessionId, st.id));
  if (items.length === 0) throw new AppError("لا توجد بنود في الجلسة", 422);
  if (items.some((i) => i.countedQtyMilli === null)) {
    throw new AppError("يجب إدخال الكميات المجرودة لجميع المنتجات", 422);
  }
  await tx
    .update(stocktakingSessions)
    .set({ status: "pending_approval" })
    .where(eq(stocktakingSessions.id, st.id));
  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "stocktaking.submit",
    entityType: "stocktaking_session",
    entityId: st.id,
  });
  return { ok: true };
}

export async function approveStocktake(tx: Tx, session: Session, sessionId: string) {
  if (!(await memberCan(tx, session, PERMISSIONS.stocktakingManage))) {
    throw new AppError("لا تملك صلاحية اعتماد الجرد", 403);
  }
  const st = await loadSession(tx, session.businessId, sessionId);
  if (st.status !== "pending_approval") {
    throw new AppError("الجلسة ليست بانتظار الاعتماد", 409);
  }
  await tx
    .update(stocktakingSessions)
    .set({ status: "approved", approvedBy: session.userId })
    .where(eq(stocktakingSessions.id, st.id));
  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "stocktaking.approve",
    entityType: "stocktaking_session",
    entityId: st.id,
  });
  return { ok: true };
}

export async function postStocktake(tx: Tx, session: Session, sessionId: string) {
  if (!(await memberCan(tx, session, PERMISSIONS.stocktakingManage))) {
    throw new AppError("لا تملك صلاحية ترحيل الجرد", 403);
  }
  const business = await loadBusiness(tx, session.businessId);
  const st = await loadSession(tx, session.businessId, sessionId);
  if (st.status !== "approved") {
    throw new AppError("يجب اعتماد الجرد قبل الترحيل", 409);
  }
  const items = await tx
    .select()
    .from(stocktakingItems)
    .where(eq(stocktakingItems.sessionId, st.id));

  let totalGain = 0n;
  let totalLoss = 0n;
  const at = new Date();

  for (const item of items) {
    const variance = item.varianceQtyMilli ?? 0n;
    if (variance === 0n) continue;
    if (variance > 0n) {
      const value = mulDiv(variance, item.unitCostMinor, 1000n);
      await receiveStock(tx, {
        businessId: session.businessId,
        productId: item.productId,
        warehouseId: st.warehouseId,
        type: "stocktake",
        qtyMilli: variance,
        totalValueMinor: value,
        referenceType: "stocktaking",
        referenceId: st.id,
        userId: session.userId,
        note: `جرد: ${st.title}`,
        occurredAt: at,
      });
      totalGain += value;
    } else {
      const result = await issueStock(tx, {
        businessId: session.businessId,
        productId: item.productId,
        warehouseId: st.warehouseId,
        type: "stocktake",
        qtyMilli: -variance,
        valuation: business.valuationMethod,
        referenceType: "stocktaking",
        referenceId: st.id,
        userId: session.userId,
        note: `جرد: ${st.title}`,
        occurredAt: at,
      });
      totalLoss += result.costMinor;
      await tx
        .update(stocktakingItems)
        .set({ varianceValueMinor: -result.costMinor })
        .where(eq(stocktakingItems.id, item.id));
    }
  }

  if (totalGain > 0n || totalLoss > 0n) {
    const lines: JournalLineInput[] = [];
    if (totalGain > 0n) {
      lines.push({ accountCode: ACCOUNT_CODES.inventory, debit: totalGain });
      lines.push({ accountCode: ACCOUNT_CODES.adjustmentGain, credit: totalGain });
    }
    if (totalLoss > 0n) {
      lines.push({ accountCode: ACCOUNT_CODES.adjustmentLoss, debit: totalLoss });
      lines.push({ accountCode: ACCOUNT_CODES.inventory, credit: totalLoss });
    }
    await postJournal(tx, {
      businessId: session.businessId,
      memo: `تسوية جرد - ${st.title}`,
      sourceType: "stocktaking",
      sourceId: st.id,
      userId: session.userId,
      entryDate: at,
      lines,
    });
  }

  await tx
    .update(stocktakingSessions)
    .set({ status: "posted", completedAt: at })
    .where(eq(stocktakingSessions.id, st.id));

  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "stocktaking.post",
    entityType: "stocktaking_session",
    entityId: st.id,
    after: { totalGain: totalGain.toString(), totalLoss: totalLoss.toString() },
  });

  return { ok: true, totalGain, totalLoss };
}

export async function listStocktakes(tx: Tx, businessId: string, limit = 50) {
  return tx
    .select({
      id: stocktakingSessions.id,
      title: stocktakingSessions.title,
      status: stocktakingSessions.status,
      scope: stocktakingSessions.scope,
      startedAt: stocktakingSessions.startedAt,
      completedAt: stocktakingSessions.completedAt,
      itemCount: sql<string>`(select count(*) from ${stocktakingItems} where ${stocktakingItems.sessionId} = ${stocktakingSessions.id})`,
      varianceCount: sql<string>`(select count(*) from ${stocktakingItems} where ${stocktakingItems.sessionId} = ${stocktakingSessions.id} and coalesce(${stocktakingItems.varianceQtyMilli},0) <> 0)`,
    })
    .from(stocktakingSessions)
    .where(eq(stocktakingSessions.businessId, businessId))
    .orderBy(desc(stocktakingSessions.startedAt))
    .limit(limit);
}

export async function getStocktakeDetail(tx: Tx, businessId: string, sessionId: string) {
  const st = await loadSession(tx, businessId, sessionId);
  const items = await tx
    .select({
      id: stocktakingItems.id,
      productId: stocktakingItems.productId,
      productName: products.name,
      sku: products.sku,
      unitName: units.name,
      expectedQtyMilli: stocktakingItems.expectedQtyMilli,
      countedQtyMilli: stocktakingItems.countedQtyMilli,
      varianceQtyMilli: stocktakingItems.varianceQtyMilli,
      unitCostMinor: stocktakingItems.unitCostMinor,
      varianceValueMinor: stocktakingItems.varianceValueMinor,
    })
    .from(stocktakingItems)
    .innerJoin(products, eq(products.id, stocktakingItems.productId))
    .innerJoin(units, eq(units.id, products.baseUnitId))
    .where(eq(stocktakingItems.sessionId, st.id));
  return { ...st, items };
}

async function loadSession(tx: Tx, businessId: string, sessionId: string) {
  const [st] = await tx
    .select()
    .from(stocktakingSessions)
    .where(
      and(
        eq(stocktakingSessions.id, sessionId),
        eq(stocktakingSessions.businessId, businessId),
      ),
    );
  if (!st) throw new AppError("جلسة الجرد غير موجودة", 404);
  return st;
}
