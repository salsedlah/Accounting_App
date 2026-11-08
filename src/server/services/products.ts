import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db/client";
import {
  inventoryBalances,
  inventoryMovements,
  productCategories,
  productUnits,
  products,
  units,
  warehouses,
} from "@/db/schema";
import { PERMISSIONS, can } from "@/lib/constants";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/quantity";
import { AppError } from "@/server/api";
import type { Session } from "@/server/auth";
import { defaultWarehouse, memberCan, writeAudit } from "./common";

const priceField = z.string().optional();

export const productUnitSchema = z.object({
  unitId: z.string().uuid(),
  factor: z.string().min(1),
  retailPrice: priceField,
  wholesalePrice: priceField,
  allowFraction: z.boolean().optional(),
});

export const productSchema = z.object({
  name: z.string().min(1).max(200),
  sku: z.string().min(1).max(100),
  barcode: z.string().max(100).optional().nullable(),
  categoryId: z.string().uuid().nullish(),
  imageUrl: z.string().max(1000).nullish(),
  baseUnitId: z.string().uuid(),
  purchaseCost: z.string().min(1),
  retailPrice: z.string().min(1),
  wholesalePrice: z.string().min(1),
  minStock: z.string().min(1),
  defaultSupplierId: z.string().uuid().nullish(),
  expiryDate: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
  units: z.array(productUnitSchema).min(1),
});

function parseFactor(value: string): bigint {
  const factor = parseQty(value);
  if (factor <= 0n) throw new AppError("معامل التحويل يجب أن يكون أكبر من صفر");
  return factor;
}

export async function createProduct(tx: Tx, session: Session, raw: unknown) {
  const input = productSchema.parse(raw);
  if (!(await memberCan(tx, session, PERMISSIONS.productsWrite))) {
    throw new AppError("لا تملك صلاحية إدارة المنتجات", 403);
  }
  const unitIds = input.units.map((u) => u.unitId);
  const unitRows = await tx
    .select({ id: units.id })
    .from(units)
    .where(and(eq(units.businessId, session.businessId), inArray(units.id, unitIds)));
  if (unitRows.length !== new Set(unitIds).size) throw new AppError("وحدة قياس غير موجودة", 404);
  if (!unitIds.includes(input.baseUnitId)) {
    throw new AppError("يجب إدراج الوحدة الأساسية ضمن وحدات المنتج");
  }

  const baseEntry = input.units.find((u) => u.unitId === input.baseUnitId)!;
  if (parseFactor(baseEntry.factor) !== 1000n) {
    throw new AppError("معامل الوحدة الأساسية يجب أن يساوي 1");
  }
  if (new Set(unitIds).size !== unitIds.length) throw new AppError("تكرار في وحدات المنتج");

  const [product] = await tx
    .insert(products)
    .values({
      businessId: session.businessId,
      name: input.name,
      sku: input.sku,
      barcode: input.barcode || null,
      categoryId: input.categoryId ?? null,
      imageUrl: input.imageUrl ?? null,
      baseUnitId: input.baseUnitId,
      purchaseCostMinor: parseMoney(input.purchaseCost),
      retailPriceMinor: parseMoney(input.retailPrice),
      wholesalePriceMinor: parseMoney(input.wholesalePrice),
      minStockMilli: parseQty(input.minStock),
      defaultSupplierId: input.defaultSupplierId ?? null,
      expiryDate: input.expiryDate || null,
      isActive: input.isActive ?? true,
    })
    .returning();

  await tx.insert(productUnits).values(
    input.units.map((u, index) => ({
      productId: product.id,
      unitId: u.unitId,
      factorMilli: parseFactor(u.factor),
      isBase: u.unitId === input.baseUnitId,
      retailPriceMinor: u.retailPrice ? parseMoney(u.retailPrice) : null,
      wholesalePriceMinor: u.wholesalePrice ? parseMoney(u.wholesalePrice) : null,
      allowFraction: u.allowFraction ?? false,
      sortOrder: index,
    })),
  );

  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "product.create",
    entityType: "product",
    entityId: product.id,
    after: { name: product.name, sku: product.sku, baseUnitId: product.baseUnitId },
  });
  return product;
}

export async function updateProduct(tx: Tx, session: Session, productId: string, raw: unknown) {
  const input = productSchema.partial().parse(raw);
  if (!(await memberCan(tx, session, PERMISSIONS.productsWrite))) {
    throw new AppError("لا تملك صلاحية إدارة المنتجات", 403);
  }
  const [existing] = await tx
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.businessId, session.businessId)));
  if (!existing) throw new AppError("المنتج غير موجود", 404);

  if (input.baseUnitId && input.baseUnitId !== existing.baseUnitId) {
    throw new AppError("الوحدة الأساسية غير قابلة للتغيير بعد إنشاء المنتج");
  }

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.sku !== undefined) patch.sku = input.sku;
  if (input.barcode !== undefined) patch.barcode = input.barcode || null;
  if (input.categoryId !== undefined) patch.categoryId = input.categoryId ?? null;
  if (input.imageUrl !== undefined) patch.imageUrl = input.imageUrl ?? null;
  if (input.purchaseCost !== undefined) patch.purchaseCostMinor = parseMoney(input.purchaseCost);
  if (input.retailPrice !== undefined) patch.retailPriceMinor = parseMoney(input.retailPrice);
  if (input.wholesalePrice !== undefined) patch.wholesalePriceMinor = parseMoney(input.wholesalePrice);
  if (input.minStock !== undefined) patch.minStockMilli = parseQty(input.minStock);
  if (input.defaultSupplierId !== undefined) patch.defaultSupplierId = input.defaultSupplierId ?? null;
  if (input.expiryDate !== undefined) patch.expiryDate = input.expiryDate || null;
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  if (Object.keys(patch).length) {
    await tx.update(products).set(patch).where(eq(products.id, productId));
  }

  if (input.units) {
    const [movementCount] = await tx
      .select({ count: sql<string>`count(*)` })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.productId, productId));
    const hasMovements = BigInt(movementCount?.count ?? "0") > 0n;
    const existingUnits = await tx
      .select()
      .from(productUnits)
      .where(eq(productUnits.productId, productId));
    const existingById = new Map(existingUnits.map((u) => [u.unitId, u]));

    for (const [index, unitInput] of input.units.entries()) {
      const factor = parseFactor(unitInput.factor);
      if (unitInput.unitId === existing.baseUnitId && factor !== 1000n) {
        throw new AppError("معامل الوحدة الأساسية يجب أن يساوي 1");
      }
      const current = existingById.get(unitInput.unitId);
      if (current) {
        if (hasMovements && current.factorMilli !== factor) {
          throw new AppError("لا يمكن تغيير معامل التحويل بعد وجود حركات مخزنية");
        }
        await tx
          .update(productUnits)
          .set({
            factorMilli: factor,
            retailPriceMinor: unitInput.retailPrice ? parseMoney(unitInput.retailPrice) : null,
            wholesalePriceMinor: unitInput.wholesalePrice
              ? parseMoney(unitInput.wholesalePrice)
              : null,
            allowFraction: unitInput.allowFraction ?? current.allowFraction,
            sortOrder: index,
          })
          .where(eq(productUnits.id, current.id));
      } else {
        const [unitRow] = await tx
          .select({ id: units.id })
          .from(units)
          .where(
            and(
              eq(units.id, unitInput.unitId),
              eq(units.businessId, session.businessId),
            ),
          );
        if (!unitRow) throw new AppError("وحدة قياس غير موجودة", 404);
        await tx.insert(productUnits).values({
          productId,
          unitId: unitInput.unitId,
          factorMilli: factor,
          isBase: false,
          retailPriceMinor: unitInput.retailPrice ? parseMoney(unitInput.retailPrice) : null,
          wholesalePriceMinor: unitInput.wholesalePrice
            ? parseMoney(unitInput.wholesalePrice)
            : null,
          allowFraction: unitInput.allowFraction ?? false,
          sortOrder: index,
        });
      }
    }
  }

  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "product.update",
    entityType: "product",
    entityId: productId,
    before: { name: existing.name, sku: existing.sku },
    after: patch,
  });
  return getProductDetail(tx, session.businessId, productId);
}

export async function deactivateProduct(tx: Tx, session: Session, productId: string) {
  if (!(await memberCan(tx, session, PERMISSIONS.productsWrite))) {
    throw new AppError("لا تملك صلاحية إدارة المنتجات", 403);
  }
  const [existing] = await tx
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.businessId, session.businessId)));
  if (!existing) throw new AppError("المنتج غير موجود", 404);
  await tx.update(products).set({ isActive: !existing.isActive }).where(eq(products.id, productId));
  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: existing.isActive ? "product.deactivate" : "product.activate",
    entityType: "product",
    entityId: productId,
  });
  return { isActive: !existing.isActive };
}

export async function listProducts(
  tx: Tx,
  businessId: string,
  options: { warehouseId?: string; search?: string; includeInactive?: boolean } = {},
) {
  const warehouse = await defaultWarehouse(tx, businessId, options.warehouseId);
  const filters = [eq(products.businessId, businessId)];
  if (!options.includeInactive) filters.push(eq(products.isActive, true));
  if (options.search) {
    const q = `%${options.search}%`;
    filters.push(
      or(
        sql`${products.name} ilike ${q}`,
        sql`${products.sku} ilike ${q}`,
        sql`coalesce(${products.barcode},'') ilike ${q}`,
      )!,
    );
  }

  const rows = await tx
    .select({
      id: products.id,
      name: products.name,
      sku: products.sku,
      barcode: products.barcode,
      categoryId: products.categoryId,
      categoryName: productCategories.name,
      imageUrl: products.imageUrl,
      baseUnitId: products.baseUnitId,
      baseUnitName: units.name,
      purchaseCostMinor: products.purchaseCostMinor,
      retailPriceMinor: products.retailPriceMinor,
      wholesalePriceMinor: products.wholesalePriceMinor,
      minStockMilli: products.minStockMilli,
      defaultSupplierId: products.defaultSupplierId,
      expiryDate: products.expiryDate,
      isActive: products.isActive,
      qtyMilli: inventoryBalances.qtyMilli,
      valueMinor: inventoryBalances.valueMinor,
    })
    .from(products)
    .innerJoin(units, eq(units.id, products.baseUnitId))
    .leftJoin(productCategories, eq(productCategories.id, products.categoryId))
    .leftJoin(
      inventoryBalances,
      and(
        eq(inventoryBalances.productId, products.id),
        eq(inventoryBalances.warehouseId, warehouse.id),
      ),
    )
    .where(and(...filters))
    .orderBy(asc(products.name));

  if (rows.length === 0) return { warehouse, products: [] };

  const ids = rows.map((r) => r.id);
  const unitRows = await tx
    .select({
      productId: productUnits.productId,
      unitId: productUnits.unitId,
      unitName: units.name,
      factorMilli: productUnits.factorMilli,
      isBase: productUnits.isBase,
      retailPriceMinor: productUnits.retailPriceMinor,
      wholesalePriceMinor: productUnits.wholesalePriceMinor,
      allowFraction: productUnits.allowFraction,
      sortOrder: productUnits.sortOrder,
    })
    .from(productUnits)
    .innerJoin(units, eq(units.id, productUnits.unitId))
    .where(inArray(productUnits.productId, ids))
    .orderBy(asc(productUnits.sortOrder), asc(productUnits.factorMilli));

  const grouped = new Map<string, typeof unitRows>();
  for (const u of unitRows) {
    const list = grouped.get(u.productId) ?? [];
    list.push(u);
    grouped.set(u.productId, list);
  }

  return {
    warehouse,
    products: rows.map((p) => ({
      ...p,
      qtyMilli: p.qtyMilli ?? 0n,
      valueMinor: p.valueMinor ?? 0n,
      units: grouped.get(p.id) ?? [],
    })),
  };
}

export async function getProductDetail(tx: Tx, businessId: string, productId: string) {
  const [product] = await tx
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.businessId, businessId)));
  if (!product) throw new AppError("المنتج غير موجود", 404);
  const unitRows = await tx
    .select({
      unitId: productUnits.unitId,
      unitName: units.name,
      factorMilli: productUnits.factorMilli,
      isBase: productUnits.isBase,
      retailPriceMinor: productUnits.retailPriceMinor,
      wholesalePriceMinor: productUnits.wholesalePriceMinor,
      allowFraction: productUnits.allowFraction,
    })
    .from(productUnits)
    .innerJoin(units, eq(units.id, productUnits.unitId))
    .where(eq(productUnits.productId, productId))
    .orderBy(asc(productUnits.sortOrder));
  return { ...product, units: unitRows };
}

export async function listCategories(tx: Tx, businessId: string) {
  return tx
    .select()
    .from(productCategories)
    .where(eq(productCategories.businessId, businessId))
    .orderBy(asc(productCategories.name));
}

export async function createCategory(tx: Tx, session: Session, name: string) {
  if (!(await memberCan(tx, session, PERMISSIONS.productsWrite))) {
    throw new AppError("لا تملك صلاحية إدارة المنتجات", 403);
  }
  const [row] = await tx
    .insert(productCategories)
    .values({ businessId: session.businessId, name })
    .returning();
  return row;
}

export async function listUnits(tx: Tx, businessId: string) {
  return tx
    .select()
    .from(units)
    .where(eq(units.businessId, businessId))
    .orderBy(asc(units.name));
}

export async function createUnit(
  tx: Tx,
  session: Session,
  input: { name: string; symbol: string; kind?: string },
) {
  if (!(await memberCan(tx, session, PERMISSIONS.settingsManage))) {
    throw new AppError("لا تملك صلاحية إدارة الوحدات", 403);
  }
  const [row] = await tx
    .insert(units)
    .values({
      businessId: session.businessId,
      name: input.name,
      symbol: input.symbol,
      kind: input.kind ?? "custom",
    })
    .returning();
  return row;
}

export async function listWarehouses(tx: Tx, businessId: string) {
  return tx
    .select()
    .from(warehouses)
    .where(eq(warehouses.businessId, businessId))
    .orderBy(asc(warehouses.name));
}

export async function createWarehouse(
  tx: Tx,
  session: Session,
  input: { name: string; isDefault?: boolean },
) {
  if (!(await memberCan(tx, session, PERMISSIONS.settingsManage))) {
    throw new AppError("لا تملك صلاحية إدارة المستودعات", 403);
  }
  if (input.isDefault) {
    await tx
      .update(warehouses)
      .set({ isDefault: false })
      .where(eq(warehouses.businessId, session.businessId));
  }
  const [row] = await tx
    .insert(warehouses)
    .values({
      businessId: session.businessId,
      name: input.name,
      isDefault: input.isDefault ?? false,
    })
    .returning();
  return row;
}
