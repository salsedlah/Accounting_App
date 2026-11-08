import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db/client";
import {
  cashTransactions,
  customerAccounts,
  customers,
  notificationEvents,
  productUnits,
  products,
  saleItems,
  sales,
  units,
} from "@/db/schema";
import { ACCOUNT_CODES } from "@/lib/constants";
import { PERMISSIONS, can } from "@/lib/constants";
import { postJournal } from "@/lib/accounting";
import { issueStock, lockBalance, receiveStock } from "@/lib/inventory";
import { nextDocumentNo } from "@/lib/invoice-number";
import { mulDiv, parseMoney, percentBp } from "@/lib/money";
import { formatQty, lineAmount, parseQty, toBaseQty } from "@/lib/quantity";
import { AppError } from "@/server/api";
import type { Session } from "@/server/auth";
import {
  customerOutstanding,
  defaultCashbox,
  defaultWarehouse,
  loadBusiness,
  loadCustomer,
  memberCan,
  touchCustomer,
  writeAudit,
} from "./common";

export const saleItemInput = z.object({
  productId: z.string().uuid(),
  unitId: z.string().uuid(),
  qty: z.string().min(1),
  unitPrice: z.string().optional(),
  discount: z.string().optional(),
  priceTier: z.enum(["retail", "wholesale"]).default("retail"),
});

export const createSaleSchema = z.object({
  kind: z.enum(["sale", "return"]).default("sale"),
  customerId: z.string().uuid().nullish(),
  warehouseId: z.string().uuid().nullish(),
  cashboxId: z.string().uuid().nullish(),
  originalSaleId: z.string().uuid().nullish(),
  items: z.array(saleItemInput).min(1, "الفاتورة تحتاج بنداً واحداً على الأقل"),
  discount: z.string().optional(),
  paymentType: z.enum(["cash", "credit", "mixed"]).default("cash"),
  paid: z.string().optional(),
  notes: z.string().max(1000).optional(),
  occurredAt: z.string().datetime().optional(),
  idempotencyKey: z.string().min(8).max(200),
  clientUuid: z.string().max(100).optional(),
  offline: z.boolean().optional(),
});

export type CreateSaleInput = z.infer<typeof createSaleSchema>;

type PreparedLine = {
  productId: string;
  productName: string;
  unitId: string;
  unitName: string;
  qtyMilli: bigint;
  qtyBaseMilli: bigint;
  unitPriceMinor: bigint;
  discountMinor: bigint;
  lineTotalMinor: bigint;
  priceTier: "retail" | "wholesale";
};

export async function createSale(tx: Tx, session: Session, raw: unknown) {
  const input = createSaleSchema.parse(raw);
  if (input.kind === "return" && !(await memberCan(tx, session, PERMISSIONS.salesReturn))) {
    throw new AppError("لا تملك صلاحية إنشاء مرتجع بيع", 403);
  }
  if (input.kind === "sale" && !(await memberCan(tx, session, PERMISSIONS.salesCreate))) {
    throw new AppError("لا تملك صلاحية إنشاء المبيعات", 403);
  }

  const business = await loadBusiness(tx, session.businessId);

  const [existing] = await tx
    .select()
    .from(sales)
    .where(
      and(eq(sales.businessId, session.businessId), eq(sales.idempotencyKey, input.idempotencyKey)),
    );
  if (existing) return { sale: await getSaleDetail(tx, session.businessId, existing.id), duplicate: true };

  const warehouse = await defaultWarehouse(tx, session.businessId, input.warehouseId);
  const customer = input.customerId
    ? await loadCustomer(tx, session.businessId, input.customerId)
    : null;
  const cashbox = await defaultCashbox(tx, session.businessId, input.cashboxId);

  const hasDiscount = input.items.some((i) => i.discount && parseMoney(i.discount) > 0n) ||
    (input.discount ? parseMoney(input.discount) > 0n : false);
      if (hasDiscount && !(await memberCan(tx, session, PERMISSIONS.discounts))) {
    throw new AppError("لا تملك صلاحية تطبيق الخصومات", 403);
  }

  const prepared: PreparedLine[] = [];
  let totalBaseQty = 0n;

  for (const item of input.items) {
    const [row] = await tx
      .select({
        id: products.id,
        name: products.name,
        isActive: products.isActive,
        retail: products.retailPriceMinor,
        wholesale: products.wholesalePriceMinor,
        purchaseCost: products.purchaseCostMinor,
        factorMilli: productUnits.factorMilli,
        unitRetail: productUnits.retailPriceMinor,
        unitWholesale: productUnits.wholesalePriceMinor,
        allowFraction: productUnits.allowFraction,
        isBase: productUnits.isBase,
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
    if (!row.isActive) throw new AppError(`المنتج ${row.name} غير نشط`, 422);

    const qtyMilli = parseQty(item.qty);
    if (qtyMilli <= 0n) throw new AppError("الكمية يجب أن تكون أكبر من صفر");
    if (!row.allowFraction && qtyMilli % 1000n !== 0n) {
      throw new AppError(`الوحدة ${row.unitName} لا تسمح بكمية كسرية`);
    }
    const qtyBaseMilli = toBaseQty(qtyMilli, row.factorMilli);
    totalBaseQty += qtyBaseMilli;

    const tier = item.priceTier;
    const basePrice = tier === "wholesale" ? row.wholesale : row.retail;
    const override = tier === "wholesale" ? row.unitWholesale : row.unitRetail;
    let unitPrice = override ?? (row.isBase ? basePrice : mulDiv(basePrice, row.factorMilli, 1000n));
    if (item.unitPrice !== undefined) {
      const custom = parseMoney(item.unitPrice);
      if (custom < 0n) throw new AppError("السعر لا يمكن أن يكون سالباً");
      if (custom !== unitPrice && !(await memberCan(tx, session, PERMISSIONS.customPrice))) {
        throw new AppError("لا تملك صلاحية تعديل الأسعار", 403);
      }
      unitPrice = custom;
    }

    const gross = lineAmount(unitPrice, qtyMilli);
    const discount = item.discount ? parseMoney(item.discount) : 0n;
    if (discount < 0n) throw new AppError("الخصم لا يمكن أن يكون سالباً");
    if (discount > gross) throw new AppError("خصم البند أكبر من قيمته");

    prepared.push({
      productId: row.id,
      productName: row.name,
      unitId: item.unitId,
      unitName: row.unitName,
      qtyMilli,
      qtyBaseMilli,
      unitPriceMinor: unitPrice,
      discountMinor: discount,
      lineTotalMinor: gross - discount,
      priceTier: tier,
    });
  }

  if (input.offline && business.offlineSellLimitMilli > 0n && totalBaseQty > business.offlineSellLimitMilli) {
    throw new AppError("تجاوزت الكمية حد البيع دون اتصال المسموح به", 409);
  }

  const subtotalMinor = prepared.reduce((s, l) => s + lineAmount(l.unitPriceMinor, l.qtyMilli), 0n);
  const lineDiscounts = prepared.reduce((s, l) => s + l.discountMinor, 0n);
  const headerDiscount = input.discount ? parseMoney(input.discount) : 0n;
  if (headerDiscount < 0n) throw new AppError("الخصم لا يمكن أن يكون سالباً");
  if (headerDiscount > subtotalMinor - lineDiscounts) {
    throw new AppError("الخصم الإجمالي أكبر من قيمة الفاتورة");
  }
  const taxable = subtotalMinor - lineDiscounts - headerDiscount;
  const taxMinor = business.taxEnabled ? percentBp(taxable, business.taxRateBp) : 0n;
  const totalMinor = taxable + taxMinor;

  let paidMinor = 0n;
  if (input.kind === "sale") {
    if (input.paymentType === "cash") paidMinor = totalMinor;
    else if (input.paymentType === "credit") paidMinor = 0n;
    else {
      if (input.paid === undefined) throw new AppError("الدفع المختلط يتطلب تحديد المبلغ المدفوع");
      paidMinor = parseMoney(input.paid);
    }
  } else {
    if (input.paymentType === "cash") paidMinor = totalMinor;
    else if (input.paymentType === "credit") paidMinor = 0n;
    else paidMinor = input.paid ? parseMoney(input.paid) : 0n;
  }
  if (paidMinor < 0n || paidMinor > totalMinor) {
    throw new AppError("المبلغ المدفوع يجب أن يكون بين صفر وإجمالي الفاتورة");
  }
  const dueMinor = totalMinor - paidMinor;
  if (dueMinor > 0n && !customer) {
    throw new AppError("البيع الآجل أو المختلط يتطلب اختيار عميل");
  }
  if (input.kind === "return" && dueMinor > 0n && !customer) {
    throw new AppError("مرتجع الآجل يتطلب اختيار عميل");
  }

  if (input.kind === "sale") {
    await assertStockAvailable(tx, session.businessId, warehouse.id, prepared);
  }

  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  const saleId = crypto.randomUUID();
  let costTotalMinor = 0n;
  const lineCosts: bigint[] = [];

  for (const line of prepared) {
    if (input.kind === "sale") {
      const result = await issueStock(tx, {
        businessId: session.businessId,
        productId: line.productId,
        warehouseId: warehouse.id,
        type: "sale",
        qtyMilli: line.qtyBaseMilli,
        valuation: business.valuationMethod,
        referenceType: "sale",
        referenceId: saleId,
        userId: session.userId,
        occurredAt,
      });
      costTotalMinor += result.costMinor;
      lineCosts.push(result.costMinor);
    } else {
      const returnValue = await saleReturnCost(
        tx,
        session.businessId,
        input.originalSaleId ?? null,
        line.productId,
        line.qtyBaseMilli,
      );
      await receiveStock(tx, {
        businessId: session.businessId,
        productId: line.productId,
        warehouseId: warehouse.id,
        type: "sale_return",
        qtyMilli: line.qtyBaseMilli,
        totalValueMinor: returnValue,
        referenceType: "sale_return",
        referenceId: saleId,
        userId: session.userId,
        occurredAt,
      });
      costTotalMinor += returnValue;
      lineCosts.push(returnValue);
    }
  }

  const invoiceNo = await nextDocumentNo(
    tx,
    session.businessId,
    input.kind === "sale" ? "sale" : "sale_return",
  );

  const [sale] = await tx
    .insert(sales)
    .values({
      id: saleId,
      businessId: session.businessId,
      kind: input.kind,
      invoiceNo,
      customerId: customer?.id ?? null,
      warehouseId: warehouse.id,
      userId: session.userId,
      originalSaleId: input.originalSaleId ?? null,
      subtotalMinor,
      discountMinor: lineDiscounts + headerDiscount,
      taxMinor,
      totalMinor,
      costTotalMinor,
      paidMinor,
      dueMinor,
      paymentType: input.paymentType,
      cashboxId: cashbox.id,
      notes: input.notes ?? null,
      idempotencyKey: input.idempotencyKey,
      clientUuid: input.clientUuid ?? null,
      offlineCreated: input.offline ?? false,
      occurredAt,
    })
    .returning();

  await tx.insert(saleItems).values(
    prepared.map((line, index) => ({
      saleId,
      productId: line.productId,
      unitId: line.unitId,
      qtyMilli: line.qtyMilli,
      qtyBaseMilli: line.qtyBaseMilli,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor: line.discountMinor,
      lineTotalMinor: line.lineTotalMinor,
      costTotalMinor: lineCosts[index] ?? 0n,
      priceTier: line.priceTier,
    })),
  );

  const netRevenue = totalMinor - taxMinor;
  const entry =
    input.kind === "sale"
      ? await postJournal(tx, {
          businessId: session.businessId,
          memo: `فاتورة بيع ${invoiceNo}`,
          sourceType: "sale",
          sourceId: saleId,
          userId: session.userId,
          entryDate: occurredAt,
          lines: [
            { accountCode: ACCOUNT_CODES.cash, debit: paidMinor },
            { accountCode: ACCOUNT_CODES.receivable, debit: dueMinor },
            { accountCode: ACCOUNT_CODES.sales, credit: netRevenue },
            { accountCode: ACCOUNT_CODES.taxPayable, credit: taxMinor },
          ],
        })
      : await postJournal(tx, {
          businessId: session.businessId,
          memo: `مرتجع بيع ${invoiceNo}`,
          sourceType: "sale_return",
          sourceId: saleId,
          userId: session.userId,
          entryDate: occurredAt,
          lines: [
            { accountCode: ACCOUNT_CODES.salesReturns, debit: netRevenue },
            { accountCode: ACCOUNT_CODES.taxPayable, debit: taxMinor },
            { accountCode: ACCOUNT_CODES.cash, credit: paidMinor },
            { accountCode: ACCOUNT_CODES.receivable, credit: dueMinor },
          ],
        });

  if (costTotalMinor > 0n) {
    await postJournal(tx, {
      businessId: session.businessId,
      memo: input.kind === "sale" ? `تكلفة بيع ${invoiceNo}` : `تكلفة مرتجع ${invoiceNo}`,
      sourceType: "cogs",
      sourceId: saleId,
      userId: session.userId,
      entryDate: occurredAt,
      lines:
        input.kind === "sale"
          ? [
              { accountCode: ACCOUNT_CODES.cogs, debit: costTotalMinor },
              { accountCode: ACCOUNT_CODES.inventory, credit: costTotalMinor },
            ]
          : [
              { accountCode: ACCOUNT_CODES.inventory, debit: costTotalMinor },
              { accountCode: ACCOUNT_CODES.cogs, credit: costTotalMinor },
            ],
    });
  }

  if (paidMinor > 0n) {
    await tx.insert(cashTransactions).values({
      businessId: session.businessId,
      cashboxId: cashbox.id,
      direction: input.kind === "sale" ? "inflow" : "outflow",
      amountMinor: paidMinor,
      sourceType: input.kind === "sale" ? "sale" : "sale_return",
      sourceId: saleId,
      description: `${input.kind === "sale" ? "تحصيل" : "رد"} فاتورة ${invoiceNo}`,
      journalEntryId: entry.id,
      userId: session.userId,
      createdAt: occurredAt,
    });
  }

  if (customer && dueMinor > 0n) {
    await tx.insert(customerAccounts).values({
      businessId: session.businessId,
      customerId: customer.id,
      entryType: input.kind === "sale" ? "sale" : "sale_return",
      amountMinor: input.kind === "sale" ? dueMinor : -dueMinor,
      referenceType: "sale",
      referenceId: saleId,
      journalEntryId: entry.id,
      note: invoiceNo,
      createdAt: occurredAt,
    });
    await touchCustomer(tx, customer.id, occurredAt);
  }

  let creditWarning: { outstanding: string; limit: string } | null = null;
  if (customer && input.kind === "sale" && dueMinor > 0n) {
    const outstanding = await customerOutstanding(tx, session.businessId, customer.id);
    if (customer.creditLimitMinor > 0n && outstanding >= customer.creditLimitMinor) {
      creditWarning = {
        outstanding: outstanding.toString(),
        limit: customer.creditLimitMinor.toString(),
      };
      await tx.insert(notificationEvents).values({
        businessId: session.businessId,
        type: "credit_limit_reached",
        severity: "warning",
        channel: "in_app",
        entityType: "customer",
        entityId: customer.id,
        titleAr: `تجاوز حد الائتمان: ${customer.name}`,
        bodyAr: `الرصيد المستحق ${outstanding} هللة تجاوز حد الائتمان ${customer.creditLimitMinor} هللة`,
        payload: { customerId: customer.id, outstanding: outstanding.toString(), limit: customer.creditLimitMinor.toString(), phone: customer.phone },
        status: "pending",
      });
    }
  }

  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: input.kind === "sale" ? "sale.create" : "sale.return",
    entityType: "sale",
    entityId: saleId,
    after: { invoiceNo, totalMinor: totalMinor.toString(), dueMinor: dueMinor.toString() },
  });

  return {
    sale: await getSaleDetail(tx, session.businessId, saleId),
    duplicate: false,
    creditWarning,
  };
}

/**
 * Aggregates every cart line per product and locks the inventory balances in a
 * deterministic order before any stock is issued. This guarantees that the whole
 * cart is validated as one unit, that the same product cannot bypass the limit
 * by appearing on several lines, and that two concurrent cashiers cannot sell
 * the same remaining quantity (the row locks serialise the transactions).
 */
async function assertStockAvailable(
  tx: Tx,
  businessId: string,
  warehouseId: string,
  lines: PreparedLine[],
) {
  const requested = new Map<string, { qtyMilli: bigint; productName: string }>();
  for (const line of lines) {
    const current = requested.get(line.productId);
    if (current) current.qtyMilli += line.qtyBaseMilli;
    else
      requested.set(line.productId, {
        qtyMilli: line.qtyBaseMilli,
        productName: line.productName,
      });
  }

  const ordered = [...requested.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const available = new Map<string, bigint>();
  for (const [productId] of ordered) {
    const balance = await lockBalance(tx, businessId, productId, warehouseId);
    available.set(productId, balance.qtyMilli);
  }

  for (const [productId, info] of ordered) {
    const stock = available.get(productId) ?? 0n;
    if (info.qtyMilli > stock) {
      const remaining = stock > 0n ? stock : 0n;
      throw new AppError(
        `الكمية المطلوبة أكبر من المخزون المتوفر للمنتج ${info.productName}. الكمية المتبقية: ${formatQty(remaining)}.`,
        409,
        "insufficient_stock",
        {
          productId,
          productName: info.productName,
          availableBaseMilli: stock.toString(),
          requestedBaseMilli: info.qtyMilli.toString(),
          remainingBaseMilli: remaining.toString(),
        },
      );
    }
  }
}

async function saleReturnCost(
  tx: Tx,
  businessId: string,
  originalSaleId: string | null,
  productId: string,
  qtyBaseMilli: bigint,
): Promise<bigint> {
  if (originalSaleId) {
    const [row] = await tx
      .select({
        qty: saleItems.qtyBaseMilli,
        cost: saleItems.costTotalMinor,
      })
      .from(saleItems)
      .where(and(eq(saleItems.saleId, originalSaleId), eq(saleItems.productId, productId)));
    if (row && row.qty > 0n && row.cost > 0n) {
      return mulDiv(row.cost, qtyBaseMilli, row.qty);
    }
  }
  const [product] = await tx
    .select({ cost: products.purchaseCostMinor })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.businessId, businessId)));
  return mulDiv(product?.cost ?? 0n, qtyBaseMilli, 1000n);
}

export async function getSaleDetail(tx: Tx, businessId: string, saleId: string) {
  const [sale] = await tx
    .select()
    .from(sales)
    .where(and(eq(sales.businessId, businessId), eq(sales.id, saleId)));
  if (!sale) throw new AppError("الفاتورة غير موجودة", 404);

  const items = await tx
    .select({
      id: saleItems.id,
      productId: saleItems.productId,
      productName: products.name,
      sku: products.sku,
      unitId: saleItems.unitId,
      unitName: units.name,
      qtyMilli: saleItems.qtyMilli,
      qtyBaseMilli: saleItems.qtyBaseMilli,
      unitPriceMinor: saleItems.unitPriceMinor,
      discountMinor: saleItems.discountMinor,
      lineTotalMinor: saleItems.lineTotalMinor,
      costTotalMinor: saleItems.costTotalMinor,
      priceTier: saleItems.priceTier,
    })
    .from(saleItems)
    .innerJoin(products, eq(products.id, saleItems.productId))
    .innerJoin(units, eq(units.id, saleItems.unitId))
    .where(eq(saleItems.saleId, saleId));

  let customer: { id: string; name: string; phone: string | null; address: string | null } | null =
    null;
  if (sale.customerId) {
    const [c] = await tx
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        address: customers.address,
      })
      .from(customers)
      .where(eq(customers.id, sale.customerId));
    customer = c ?? null;
  }

  return { ...sale, items, customer };
}

export async function listSales(
  tx: Tx,
  businessId: string,
  limit = 50,
  kind?: "sale" | "return",
) {
  const where = kind
    ? and(eq(sales.businessId, businessId), eq(sales.kind, kind))
    : eq(sales.businessId, businessId);
  return tx
    .select({
      id: sales.id,
      kind: sales.kind,
      invoiceNo: sales.invoiceNo,
      totalMinor: sales.totalMinor,
      paidMinor: sales.paidMinor,
      dueMinor: sales.dueMinor,
      status: sales.status,
      paymentType: sales.paymentType,
      createdAt: sales.createdAt,
      customerName: customers.name,
    })
    .from(sales)
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .where(where)
    .orderBy(desc(sales.createdAt))
    .limit(limit);
}
