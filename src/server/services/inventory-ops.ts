import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db/client";
import {
  inventoryBalances,
  inventoryMovements,
  products,
  stockTransfers,
  units,
  warehouses,
} from "@/db/schema";
import { PERMISSIONS, can } from "@/lib/constants";
import { postJournal } from "@/lib/accounting";
import { ACCOUNT_CODES } from "@/lib/constants";
import {
  currentUnitCost,
  issueStock,
  receiveStock,
  transferStock,
} from "@/lib/inventory";
import { mulDiv, parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/quantity";
import { AppError } from "@/server/api";
import type { Session } from "@/server/auth";
import { defaultWarehouse, loadBusiness, memberCan, writeAudit } from "./common";

export const adjustmentSchema = z.object({
  productId: z.string().uuid(),
  warehouseId: z.string().uuid().nullish(),
  direction: z.enum(["increase", "decrease", "damage"]),
  qty: z.string().min(1),
  unitCost: z.string().optional(),
  reason: z.string().min(1).max(300),
  occurredAt: z.string().datetime().optional(),
});

export const transferSchema = z.object({
  productId: z.string().uuid(),
  fromWarehouseId: z.string().uuid(),
  toWarehouseId: z.string().uuid(),
  qty: z.string().min(1),
  note: z.string().max(300).optional(),
});

export async function adjustStock(tx: Tx, session: Session, raw: unknown) {
  const input = adjustmentSchema.parse(raw);
  if (!(await memberCan(tx, session, PERMISSIONS.inventoryAdjust))) {
    throw new AppError("لا تملك صلاحية تعديل المخزون", 403);
  }
  const business = await loadBusiness(tx, session.businessId);
  const warehouse = await defaultWarehouse(tx, session.businessId, input.warehouseId);
  const [product] = await tx
    .select()
    .from(products)
    .where(and(eq(products.id, input.productId), eq(products.businessId, session.businessId)));
  if (!product) throw new AppError("المنتج غير موجود", 404);
  const qty = parseQty(input.qty);
  if (qty <= 0n) throw new AppError("الكمية يجب أن تكون أكبر من صفر");
  const referenceId = crypto.randomUUID();
  const at = input.occurredAt ? new Date(input.occurredAt) : new Date();

  if (input.direction === "increase") {
    let unitCost = await currentUnitCost(tx, session.businessId, product.id, warehouse.id);
    if (input.unitCost) unitCost = parseMoney(input.unitCost);
    if (unitCost === 0n) unitCost = product.purchaseCostMinor;
    const value = mulDiv(unitCost, qty, 1000n);
    await receiveStock(tx, {
      businessId: session.businessId,
      productId: product.id,
      warehouseId: warehouse.id,
      type: "adjustment",
      qtyMilli: qty,
      totalValueMinor: value,
      referenceType: "adjustment",
      referenceId,
      userId: session.userId,
      note: input.reason,
      occurredAt: at,
    });
    if (value > 0n) {
      await postJournal(tx, {
        businessId: session.businessId,
        memo: `زيادة مخزون - ${product.name}`,
        sourceType: "adjustment",
        sourceId: referenceId,
        userId: session.userId,
        entryDate: at,
        lines: [
          { accountCode: ACCOUNT_CODES.inventory, debit: value },
          { accountCode: ACCOUNT_CODES.adjustmentGain, credit: value },
        ],
      });
    }
  } else {
    const result = await issueStock(tx, {
      businessId: session.businessId,
      productId: product.id,
      warehouseId: warehouse.id,
      type: input.direction === "damage" ? "damage" : "adjustment",
      qtyMilli: qty,
      valuation: business.valuationMethod,
      referenceType: "adjustment",
      referenceId,
      userId: session.userId,
      note: input.reason,
      occurredAt: at,
    });
    if (result.costMinor > 0n) {
      await postJournal(tx, {
        businessId: session.businessId,
        memo: `${input.direction === "damage" ? "إتلاف" : "تخفيض"} مخزون - ${product.name}`,
        sourceType: "adjustment",
        sourceId: referenceId,
        userId: session.userId,
        entryDate: at,
        lines: [
          { accountCode: ACCOUNT_CODES.adjustmentLoss, debit: result.costMinor },
          { accountCode: ACCOUNT_CODES.inventory, credit: result.costMinor },
        ],
      });
    }
  }

  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: `inventory.${input.direction}`,
    entityType: "product",
    entityId: product.id,
    after: { qty: qty.toString(), reason: input.reason, warehouseId: warehouse.id },
  });

  return { ok: true };
}

export async function transferInventory(tx: Tx, session: Session, raw: unknown) {
  const input = transferSchema.parse(raw);
  if (!(await memberCan(tx, session, PERMISSIONS.inventoryAdjust))) {
    throw new AppError("لا تملك صلاحية تحويل المخزون", 403);
  }
  const business = await loadBusiness(tx, session.businessId);
  const qty = parseQty(input.qty);
  if (qty <= 0n) throw new AppError("الكمية يجب أن تكون أكبر من صفر");
  const [product] = await tx
    .select()
    .from(products)
    .where(and(eq(products.id, input.productId), eq(products.businessId, session.businessId)));
  if (!product) throw new AppError("المنتج غير موجود", 404);

  const id = crypto.randomUUID();
  await tx.insert(stockTransfers).values({
    id,
    businessId: session.businessId,
    fromWarehouseId: input.fromWarehouseId,
    toWarehouseId: input.toWarehouseId,
    note: input.note ?? null,
    userId: session.userId,
  });

  await transferStock(tx, {
    businessId: session.businessId,
    productId: product.id,
    fromWarehouseId: input.fromWarehouseId,
    toWarehouseId: input.toWarehouseId,
    qtyMilli: qty,
    referenceId: id,
    userId: session.userId,
    note: input.note ?? null,
    valuation: business.valuationMethod,
  });

  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "inventory.transfer",
    entityType: "product",
    entityId: product.id,
    after: { qty: qty.toString(), from: input.fromWarehouseId, to: input.toWarehouseId },
  });

  return { ok: true, transferId: id };
}

export async function listInventoryOverview(
  tx: Tx,
  businessId: string,
  warehouseId?: string,
) {
  const where = warehouseId
    ? and(
        eq(inventoryBalances.businessId, businessId),
        eq(inventoryBalances.warehouseId, warehouseId),
      )
    : eq(inventoryBalances.businessId, businessId);
  return tx
    .select({
      productId: products.id,
      productName: products.name,
      sku: products.sku,
      barcode: products.barcode,
      unitSymbol: units.symbol,
      warehouseId: warehouses.id,
      warehouseName: warehouses.name,
      qtyMilli: inventoryBalances.qtyMilli,
      valueMinor: inventoryBalances.valueMinor,
      minStockMilli: products.minStockMilli,
      retailPriceMinor: products.retailPriceMinor,
      updatedAt: inventoryBalances.updatedAt,
    })
    .from(inventoryBalances)
    .innerJoin(products, eq(products.id, inventoryBalances.productId))
    .innerJoin(units, eq(units.id, products.baseUnitId))
    .innerJoin(warehouses, eq(warehouses.id, inventoryBalances.warehouseId))
    .where(where)
    .orderBy(products.name);
}

export async function listInventoryMovements(
  tx: Tx,
  businessId: string,
  limit = 200,
) {
  return tx
    .select({
      id: inventoryMovements.id,
      type: inventoryMovements.type,
      qtyMilli: inventoryMovements.qtyMilli,
      valueMinor: inventoryMovements.valueMinor,
      referenceType: inventoryMovements.referenceType,
      referenceId: inventoryMovements.referenceId,
      note: inventoryMovements.note,
      createdAt: inventoryMovements.createdAt,
      productName: products.name,
      sku: products.sku,
      unitSymbol: units.symbol,
      warehouseName: warehouses.name,
    })
    .from(inventoryMovements)
    .innerJoin(products, eq(products.id, inventoryMovements.productId))
    .innerJoin(units, eq(units.id, products.baseUnitId))
    .innerJoin(warehouses, eq(warehouses.id, inventoryMovements.warehouseId))
    .where(eq(inventoryMovements.businessId, businessId))
    .orderBy(desc(inventoryMovements.createdAt))
    .limit(limit);
}
