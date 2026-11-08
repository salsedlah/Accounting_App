import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db/client";
import {
  cashTransactions,
  productUnits,
  products,
  purchaseItems,
  purchases,
  supplierAccounts,
  suppliers,
  units,
} from "@/db/schema";
import { ACCOUNT_CODES, PERMISSIONS, can } from "@/lib/constants";
import { postJournal, type JournalLineInput } from "@/lib/accounting";
import { issueStock, receiveStock } from "@/lib/inventory";
import { nextDocumentNo } from "@/lib/invoice-number";
import { allocateProportionally, mulDiv, parseMoney } from "@/lib/money";
import { lineAmount, parseQty, toBaseQty } from "@/lib/quantity";
import { AppError } from "@/server/api";
import type { Session } from "@/server/auth";
import {
  defaultCashbox,
  defaultWarehouse,
  loadBusiness,
  memberCan,
  supplierOutstanding,
  writeAudit,
} from "./common";

export const purchaseItemInput = z.object({
  productId: z.string().uuid(),
  unitId: z.string().uuid(),
  qty: z.string().min(1),
  unitCost: z.string().min(1),
  discount: z.string().optional(),
});

export const createPurchaseSchema = z.object({
  kind: z.enum(["purchase", "return"]).default("purchase"),
  supplierId: z.string().uuid(),
  warehouseId: z.string().uuid().nullish(),
  cashboxId: z.string().uuid().nullish(),
  originalPurchaseId: z.string().uuid().nullish(),
  items: z.array(purchaseItemInput).min(1),
  discount: z.string().optional(),
  extraCost: z.string().optional(),
  paid: z.string().optional(),
  notes: z.string().max(1000).optional(),
  occurredAt: z.string().datetime().optional(),
  idempotencyKey: z.string().min(8).max(200),
  clientUuid: z.string().max(100).optional(),
});

type Prepared = {
  productId: string;
  unitId: string;
  qtyMilli: bigint;
  qtyBaseMilli: bigint;
  unitCostMinor: bigint;
  discountMinor: bigint;
  lineNetMinor: bigint;
  receiptValueMinor: bigint;
  factorMilli: bigint;
};

export async function createPurchase(tx: Tx, session: Session, raw: unknown) {
  const input = createPurchaseSchema.parse(raw);
  if (!(await memberCan(tx, session, PERMISSIONS.purchasesCreate))) {
    throw new AppError("لا تملك صلاحية إدارة المشتريات", 403);
  }

  const business = await loadBusiness(tx, session.businessId);

  const [existing] = await tx
    .select()
    .from(purchases)
    .where(
      and(
        eq(purchases.businessId, session.businessId),
        eq(purchases.idempotencyKey, input.idempotencyKey),
      ),
    );
  if (existing) return { purchase: await getPurchaseDetail(tx, session.businessId, existing.id), duplicate: true };

  const [supplier] = await tx
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, input.supplierId), eq(suppliers.businessId, session.businessId)));
  if (!supplier) throw new AppError("المورد غير موجود", 404);

  const warehouse = await defaultWarehouse(tx, session.businessId, input.warehouseId);
  const cashbox = await defaultCashbox(tx, session.businessId, input.cashboxId);

  const prepared: Prepared[] = [];
  for (const item of input.items) {
    const [row] = await tx
      .select({
        id: products.id,
        name: products.name,
        factorMilli: productUnits.factorMilli,
        unitName: units.name,
      })
      .from(products)
      .innerJoin(productUnits, eq(productUnits.productId, products.id))
      .innerJoin(units, eq(units.id, productUnits.unitId))
      .where(
        and(
          eq(products.id, item.productId),
          eq(products.businessId, session.businessId),
          eq(productUnits.unitId, item.unitId),
        ),
      );
    if (!row) throw new AppError("المنتج أو الوحدة غير موجودة", 404);
    const qtyMilli = parseQty(item.qty);
    if (qtyMilli <= 0n) throw new AppError("الكمية يجب أن تكون أكبر من صفر");
    const qtyBaseMilli = toBaseQty(qtyMilli, row.factorMilli);
    const unitCost = parseMoney(item.unitCost);
    if (unitCost < 0n) throw new AppError("تكلفة الوحدة لا يمكن أن تكون سالبة");
    const gross = lineAmount(unitCost, qtyMilli);
    const discount = item.discount ? parseMoney(item.discount) : 0n;
    if (discount < 0n || discount > gross) throw new AppError("خصم البند غير صالح");
    prepared.push({
      productId: row.id,
      unitId: item.unitId,
      qtyMilli,
      qtyBaseMilli,
      unitCostMinor: unitCost,
      discountMinor: discount,
      lineNetMinor: gross - discount,
      receiptValueMinor: 0n,
      factorMilli: row.factorMilli,
    });
  }

  const subtotal = prepared.reduce(
    (sum, l) => sum + lineAmount(l.unitCostMinor, l.qtyMilli),
    0n,
  );
  const lineDiscounts = prepared.reduce((sum, l) => sum + l.discountMinor, 0n);
  const headerDiscount = input.discount ? parseMoney(input.discount) : 0n;
  if (headerDiscount < 0n || headerDiscount > subtotal - lineDiscounts) {
    throw new AppError("خصم الفاتورة غير صالح");
  }
  const extraCost = input.extraCost ? parseMoney(input.extraCost) : 0n;
  if (extraCost < 0n) throw new AppError("التكاليف الإضافية لا يمكن أن تكون سالبة");
  const total = subtotal - lineDiscounts - headerDiscount + extraCost;

  const paid = input.paid ? parseMoney(input.paid) : 0n;
  if (paid < 0n || paid > total) throw new AppError("المبلغ المدفوع غير صالح");
  const due = total - paid;

  const lineNets = prepared.map((l) => l.lineNetMinor);
  const discountShares = allocateProportionally(headerDiscount, lineNets);
  const extraShares = allocateProportionally(extraCost, lineNets);
  prepared.forEach((line, i) => {
    line.receiptValueMinor = line.lineNetMinor - discountShares[i] + extraShares[i];
  });

  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  const purchaseId = crypto.randomUUID();
  const lineCosts: bigint[] = [];
  let inventoryCost = 0n;

  for (const line of prepared) {
    if (input.kind === "purchase") {
      await receiveStock(tx, {
        businessId: session.businessId,
        productId: line.productId,
        warehouseId: warehouse.id,
        type: "purchase",
        qtyMilli: line.qtyBaseMilli,
        totalValueMinor: line.receiptValueMinor,
        referenceType: "purchase",
        referenceId: purchaseId,
        userId: session.userId,
        occurredAt,
      });
      inventoryCost += line.receiptValueMinor;
      lineCosts.push(line.receiptValueMinor);
      const costPerBase = mulDiv(line.unitCostMinor, 1000n, line.factorMilli);
      await tx
        .update(products)
        .set({ purchaseCostMinor: costPerBase })
        .where(eq(products.id, line.productId));
    } else {
      const result = await issueStock(tx, {
        businessId: session.businessId,
        productId: line.productId,
        warehouseId: warehouse.id,
        type: "purchase_return",
        qtyMilli: line.qtyBaseMilli,
        valuation: business.valuationMethod,
        referenceType: "purchase_return",
        referenceId: purchaseId,
        userId: session.userId,
        occurredAt,
      });
      lineCosts.push(result.costMinor);
      inventoryCost += result.costMinor;
    }
  }

  const invoiceNo = await nextDocumentNo(
    tx,
    session.businessId,
    input.kind === "purchase" ? "purchase" : "purchase_return",
  );

  const [purchase] = await tx
    .insert(purchases)
    .values({
      id: purchaseId,
      businessId: session.businessId,
      kind: input.kind,
      invoiceNo,
      supplierId: supplier.id,
      warehouseId: warehouse.id,
      userId: session.userId,
      originalPurchaseId: input.originalPurchaseId ?? null,
      subtotalMinor: subtotal,
      discountMinor: lineDiscounts + headerDiscount,
      extraCostMinor: extraCost,
      totalMinor: total,
      paidMinor: paid,
      dueMinor: due,
      cashboxId: cashbox.id,
      notes: input.notes ?? null,
      idempotencyKey: input.idempotencyKey,
      clientUuid: input.clientUuid ?? null,
      occurredAt,
    })
    .returning();

  await tx.insert(purchaseItems).values(
    prepared.map((line, index) => ({
      purchaseId,
      productId: line.productId,
      unitId: line.unitId,
      qtyMilli: line.qtyMilli,
      qtyBaseMilli: line.qtyBaseMilli,
      unitCostMinor: line.unitCostMinor,
      discountMinor: line.discountMinor,
      lineTotalMinor: line.lineNetMinor,
    })),
  );

  const entry =
    input.kind === "purchase"
      ? await postJournal(tx, {
          businessId: session.businessId,
          memo: `فاتورة شراء ${invoiceNo}`,
          sourceType: "purchase",
          sourceId: purchaseId,
          userId: session.userId,
          entryDate: occurredAt,
          lines: [
            { accountCode: ACCOUNT_CODES.inventory, debit: total },
            { accountCode: ACCOUNT_CODES.cash, credit: paid },
            { accountCode: ACCOUNT_CODES.payable, credit: due },
          ],
        })
      : await (async () => {
          const difference = inventoryCost - total;
          const lines: JournalLineInput[] = [
            { accountCode: ACCOUNT_CODES.payable, debit: due },
            { accountCode: ACCOUNT_CODES.cash, debit: paid },
            { accountCode: ACCOUNT_CODES.inventory, credit: inventoryCost },
          ];
          if (difference > 0n) {
            lines.push({ accountCode: ACCOUNT_CODES.adjustmentLoss, debit: difference });
          } else if (difference < 0n) {
            lines.push({ accountCode: ACCOUNT_CODES.adjustmentGain, credit: -difference });
          }
          return postJournal(tx, {
            businessId: session.businessId,
            memo: `مرتجع شراء ${invoiceNo}`,
            sourceType: "purchase_return",
            sourceId: purchaseId,
            userId: session.userId,
            entryDate: occurredAt,
            lines,
          });
        })();

  if (paid > 0n) {
    await tx.insert(cashTransactions).values({
      businessId: session.businessId,
      cashboxId: cashbox.id,
      direction: input.kind === "purchase" ? "outflow" : "inflow",
      amountMinor: paid,
      sourceType: input.kind === "purchase" ? "purchase" : "purchase_return",
      sourceId: purchaseId,
      description: `${input.kind === "purchase" ? "دفع" : "استرداد"} فاتورة ${invoiceNo}`,
      journalEntryId: entry.id,
      userId: session.userId,
      createdAt: occurredAt,
    });
  }

  if (due > 0n) {
    await tx.insert(supplierAccounts).values({
      businessId: session.businessId,
      supplierId: supplier.id,
      entryType: input.kind === "purchase" ? "purchase" : "purchase_return",
      amountMinor: input.kind === "purchase" ? due : -due,
      referenceType: "purchase",
      referenceId: purchaseId,
      journalEntryId: entry.id,
      note: invoiceNo,
      createdAt: occurredAt,
    });
  }

  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: input.kind === "purchase" ? "purchase.create" : "purchase.return",
    entityType: "purchase",
    entityId: purchaseId,
    after: { invoiceNo, totalMinor: total.toString(), dueMinor: due.toString() },
  });

  return {
    purchase: await getPurchaseDetail(tx, session.businessId, purchaseId),
    duplicate: false,
    supplierOutstanding: (await supplierOutstanding(tx, session.businessId, supplier.id)).toString(),
  };
}

export async function getPurchaseDetail(tx: Tx, businessId: string, purchaseId: string) {
  const [purchase] = await tx
    .select()
    .from(purchases)
    .where(and(eq(purchases.businessId, businessId), eq(purchases.id, purchaseId)));
  if (!purchase) throw new AppError("فاتورة الشراء غير موجودة", 404);

  const items = await tx
    .select({
      id: purchaseItems.id,
      productId: purchaseItems.productId,
      productName: products.name,
      sku: products.sku,
      unitId: purchaseItems.unitId,
      unitName: units.name,
      qtyMilli: purchaseItems.qtyMilli,
      qtyBaseMilli: purchaseItems.qtyBaseMilli,
      unitCostMinor: purchaseItems.unitCostMinor,
      discountMinor: purchaseItems.discountMinor,
      lineTotalMinor: purchaseItems.lineTotalMinor,
    })
    .from(purchaseItems)
    .innerJoin(products, eq(products.id, purchaseItems.productId))
    .innerJoin(units, eq(units.id, purchaseItems.unitId))
    .where(eq(purchaseItems.purchaseId, purchaseId));

  const [supplier] = await tx.select().from(suppliers).where(eq(suppliers.id, purchase.supplierId));
  return { ...purchase, items, supplier: supplier ?? null };
}

export async function listPurchases(tx: Tx, businessId: string, limit = 50) {
  return tx
    .select({
      id: purchases.id,
      kind: purchases.kind,
      invoiceNo: purchases.invoiceNo,
      totalMinor: purchases.totalMinor,
      paidMinor: purchases.paidMinor,
      dueMinor: purchases.dueMinor,
      status: purchases.status,
      createdAt: purchases.createdAt,
      supplierName: suppliers.name,
    })
    .from(purchases)
    .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .where(eq(purchases.businessId, businessId))
    .orderBy(desc(purchases.createdAt))
    .limit(limit);
}
