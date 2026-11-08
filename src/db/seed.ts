import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  businesses,
  cashboxes,
  customers,
  memberships,
  permissions as permissionsTable,
  productCategories,
  productUnits,
  products,
  rolePermissions,
  roles,
  suppliers,
  units,
  users,
  warehouses,
} from "@/db/schema";
import {
  PERMISSION_CATALOG,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  SYSTEM_ACCOUNTS,
} from "@/lib/constants";
import { accounts } from "@/db/schema";
import { postJournal } from "@/lib/accounting";
import { receiveStock } from "@/lib/inventory";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/quantity";
import { hashPassword } from "@/server/auth";
import type { Session } from "@/server/auth";
import { createSale } from "@/server/services/sales";
import { createPayment } from "@/server/services/payments";
import { createExpense } from "@/server/services/expenses";
import { writeAudit } from "@/server/services/common";

const DEMO_BUSINESS = "مؤسسة النور للتجارة";
const DEMO_PASSWORD = "Admin123!";

declare global {
  // eslint-disable-next-line no-var
  var __hisab_seed: Promise<{ businessId: string; seeded: boolean }> | undefined;
}

export function ensureSeed() {
  if (!globalThis.__hisab_seed) {
    globalThis.__hisab_seed = seed().catch((error) => {
      globalThis.__hisab_seed = undefined;
      throw error;
    });
  }
  return globalThis.__hisab_seed;
}

async function seed(): Promise<{ businessId: string; seeded: boolean }> {
  const db = await getDb();
  const [existing] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.name, DEMO_BUSINESS));
  if (existing) return { businessId: existing.id, seeded: false };

  const passwordHashes = {
    owner: await hashPassword(DEMO_PASSWORD),
    accountant: await hashPassword("Accountant123!"),
    cashier: await hashPassword("Cashier123!"),
    inventory: await hashPassword("Inventory123!"),
    viewer: await hashPassword("Viewer123!"),
  };

  await db.transaction(async (tx) => {
    const [business] = await tx
      .insert(businesses)
      .values({
        name: DEMO_BUSINESS,
        legalName: "مؤسسة النور للتجارة العامة",
        phone: "777000111",
        address: "صنعاء - شارع حدة - اليمن",
        currency: "YER",
        currencyScale: 2,
        taxEnabled: false,
        taxRateBp: 0,
        valuationMethod: "weighted_average",
        offlineSellLimitMilli: parseQty("10000"),
      })
      .returning();

    // Permissions catalogue
    await tx
      .insert(permissionsTable)
      .values(
        PERMISSION_CATALOG.map((p) => ({
          key: p.key,
          labelAr: p.labelAr,
          groupAr: p.groupAr,
        })),
      )
      .onConflictDoNothing();

    const roleRows: Array<{ id: string; key: string }> = [];
    for (const key of Object.keys(ROLE_PERMISSIONS) as Array<keyof typeof ROLE_PERMISSIONS>) {
      const [role] = await tx
        .insert(roles)
        .values({ businessId: business.id, key: key as never, nameAr: ROLE_LABELS[key] })
        .returning();
      roleRows.push({ id: role.id, key: String(key) });
      const keys = ROLE_PERMISSIONS[key];
      if (keys.length) {
        await tx.insert(rolePermissions).values(
          keys.map((permissionKey) => ({ roleId: role.id, permissionKey })),
        );
      }
    }

    // Chart of accounts
    await tx.insert(accounts).values(
      SYSTEM_ACCOUNTS.map((a) => ({
        businessId: business.id,
        code: a.code,
        nameAr: a.nameAr,
        type: a.type,
        isSystem: true,
      })),
    );

    // Users
    const userSpecs = [
      { email: "owner@demo.local", name: "سالم عبدالله (المالك)", role: "owner" as const, hash: passwordHashes.owner },
      { email: "accountant@demo.local", name: "منى الحسني (محاسبة)", role: "accountant" as const, hash: passwordHashes.accountant },
      { email: "cashier@demo.local", name: "خالد الشامي (كاشير)", role: "cashier" as const, hash: passwordHashes.cashier },
      { email: "inventory@demo.local", name: "نبيل الحداد (مخزون)", role: "inventory_manager" as const, hash: passwordHashes.inventory },
      { email: "viewer@demo.local", name: "زائر", role: "viewer" as const, hash: passwordHashes.viewer },
    ];
    let ownerUserId = "";
    for (const spec of userSpecs) {
      const [user] = await tx
        .insert(users)
        .values({ email: spec.email, name: spec.name, passwordHash: spec.hash })
        .returning();
      await tx
        .insert(memberships)
        .values({ businessId: business.id, userId: user.id, role: spec.role });
      if (spec.role === "owner") ownerUserId = user.id;
    }

    // Units
    const unitSpecs = [
      { name: "قطعة", symbol: "pc", kind: "count" },
      { name: "كرتون", symbol: "ctn", kind: "package" },
      { name: "نصف كرتون", symbol: "1/2 ctn", kind: "package" },
      { name: "ربع كرتون", symbol: "1/4 ctn", kind: "package" },
      { name: "كيس", symbol: "bag", kind: "package" },
      { name: "كيس كبير", symbol: "big bag", kind: "package" },
      { name: "كيلوجرام", symbol: "kg", kind: "weight" },
      { name: "جرام", symbol: "g", kind: "weight" },
      { name: "لتر", symbol: "L", kind: "volume" },
      { name: "ملليلتر", symbol: "ml", kind: "volume" },
      { name: "متر", symbol: "m", kind: "length" },
      { name: "علبة", symbol: "box", kind: "package" },
      { name: "حزمة", symbol: "pack", kind: "package" },
      { name: "صندوق", symbol: "carton box", kind: "package" },
    ];
    const unitRows = await tx
      .insert(units)
      .values(unitSpecs.map((u) => ({ ...u, businessId: business.id })))
      .returning();
    const unitByName = new Map(unitRows.map((u) => [u.name, u.id]));

    const categoryRows = await tx
      .insert(productCategories)
      .values([
        { businessId: business.id, name: "مياه ومشروبات" },
        { businessId: business.id, name: "مواد غذائية" },
        { businessId: business.id, name: "منظفات" },
        { businessId: business.id, name: "قرطاسية" },
      ])
      .returning();
    const catByName = new Map(categoryRows.map((c) => [c.name, c.id]));

    const [mainWarehouse, branchWarehouse] = await tx
      .insert(warehouses)
      .values([
        { businessId: business.id, name: "المخزن الرئيسي", isDefault: true },
        { businessId: business.id, name: "مخزن الفرع" },
      ])
      .returning();

    const [mainCashbox] = await tx
      .insert(cashboxes)
      .values({
        businessId: business.id,
        name: "الصندوق الرئيسي",
        openingBalanceMinor: parseMoney("500000"),
        isDefault: true,
      })
      .returning();

    const supplierRows = await tx
      .insert(suppliers)
      .values([
        { businessId: business.id, name: "شركة المياه الوطنية", phone: "778111222", address: "صنعاء" },
        { businessId: business.id, name: "مؤسسة الغذاء الجيد", phone: "778222333", address: "الحديدة" },
        { businessId: business.id, name: "مورد مواد التنظيف", phone: "778333444", address: "عدن" },
      ])
      .returning();

    const customerRows = await tx
      .insert(customers)
      .values([
        {
          businessId: business.id,
          name: "أحمد علي",
          phone: "771234567",
          address: "صنعاء - حدة",
          creditLimitMinor: parseMoney("200000"),
        },
        {
          businessId: business.id,
          name: "محمد صالح",
          phone: "772345678",
          address: "صنعاء - شملان",
          creditLimitMinor: parseMoney("100000"),
        },
        {
          businessId: business.id,
          name: "شركة الأمل التجارية",
          phone: "773456789",
          address: "صنعاء - التحرير",
          creditLimitMinor: parseMoney("1000000"),
        },
      ])
      .returning();

    type ProductSpec = {
      name: string;
      sku: string;
      barcode: string;
      category: string;
      baseUnit: string;
      purchaseCost: string;
      retail: string;
      wholesale: string;
      minStock: string;
      supplierId: string;
      expiry?: string;
      openingQty: string;
      units: Array<{
        unit: string;
        factor: string;
        retail?: string;
        wholesale?: string;
        allowFraction?: boolean;
      }>;
    };

    const specs: ProductSpec[] = [
      {
        name: "مياه معدنية 600 مل",
        sku: "WTR-600",
        barcode: "6291000000011",
        category: "مياه ومشروبات",
        baseUnit: "قطعة",
        purchaseCost: "100",
        retail: "150",
        wholesale: "125",
        minStock: "240",
        supplierId: supplierRows[0].id,
        openingQty: "2400",
        units: [
          { unit: "قطعة", factor: "1" },
          { unit: "كرتون", factor: "24", retail: "3600", wholesale: "3000", allowFraction: true },
          { unit: "نصف كرتون", factor: "12", retail: "1800", wholesale: "1500" },
          { unit: "ربع كرتون", factor: "6", retail: "900", wholesale: "750" },
        ],
      },
      {
        name: "أرز بسمتي 5 كجم",
        sku: "RICE-5",
        barcode: "6291000000028",
        category: "مواد غذائية",
        baseUnit: "كيس",
        purchaseCost: "5500",
        retail: "6500",
        wholesale: "6000",
        minStock: "20",
        supplierId: supplierRows[1].id,
        openingQty: "40",
        units: [
          { unit: "كيس", factor: "1" },
          { unit: "كرتون", factor: "6", retail: "39000", wholesale: "36000" },
        ],
      },
      {
        name: "سكر أبيض 1 كجم",
        sku: "SUGAR-1",
        barcode: "6291000000035",
        category: "مواد غذائية",
        baseUnit: "كيس",
        purchaseCost: "800",
        retail: "1000",
        wholesale: "900",
        minStock: "50",
        supplierId: supplierRows[1].id,
        openingQty: "100",
        units: [
          { unit: "كيس", factor: "1" },
          { unit: "كرتون", factor: "12", retail: "12000", wholesale: "10800" },
        ],
      },
      {
        name: "زيت طبخ 1.8 لتر",
        sku: "OIL-18",
        barcode: "6291000000042",
        category: "مواد غذائية",
        baseUnit: "قطعة",
        purchaseCost: "3200",
        retail: "3800",
        wholesale: "3500",
        minStock: "12",
        supplierId: supplierRows[1].id,
        openingQty: "30",
        units: [
          { unit: "قطعة", factor: "1" },
          { unit: "كرتون", factor: "4", retail: "15200", wholesale: "14000" },
        ],
      },
      {
        name: "سكر مكشوف (كجم)",
        sku: "SUGAR-KG",
        barcode: "6291000000059",
        category: "مواد غذائية",
        baseUnit: "كيلوجرام",
        purchaseCost: "900",
        retail: "1100",
        wholesale: "1000",
        minStock: "25",
        supplierId: supplierRows[1].id,
        openingQty: "50",
        units: [
          { unit: "كيلوجرام", factor: "1", allowFraction: true },
          { unit: "جرام", factor: "0.001", allowFraction: true },
        ],
      },
      {
        name: "شاي 250 جرام",
        sku: "TEA-250",
        barcode: "6291000000066",
        category: "مواد غذائية",
        baseUnit: "قطعة",
        purchaseCost: "1800",
        retail: "2500",
        wholesale: "2300",
        minStock: "48",
        supplierId: supplierRows[1].id,
        openingQty: "240",
        units: [
          { unit: "قطعة", factor: "1" },
          { unit: "كرتون", factor: "12", retail: "30000", wholesale: "27600" },
        ],
      },
      {
        name: "مياه معدنية 1.5 لتر",
        sku: "WTR-1500",
        barcode: "6291000000073",
        category: "مياه ومشروبات",
        baseUnit: "قطعة",
        purchaseCost: "250",
        retail: "300",
        wholesale: "280",
        minStock: "60",
        supplierId: supplierRows[0].id,
        expiry: "2027-06-30",
        openingQty: "120",
        units: [
          { unit: "قطعة", factor: "1" },
          { unit: "كرتون", factor: "6", retail: "1800", wholesale: "1680" },
        ],
      },
      {
        name: "صابون غسيل 2.5 كجم",
        sku: "SOAP-25",
        barcode: "6291000000080",
        category: "منظفات",
        baseUnit: "قطعة",
        purchaseCost: "2200",
        retail: "2800",
        wholesale: "2600",
        minStock: "10",
        supplierId: supplierRows[2].id,
        openingQty: "24",
        units: [
          { unit: "قطعة", factor: "1" },
          { unit: "كرتون", factor: "6", retail: "16800", wholesale: "15600" },
        ],
      },
    ];

    const productIds = new Map<string, string>();
    let openingValue = 0n;

    for (const spec of specs) {
      const [product] = await tx
        .insert(products)
        .values({
          businessId: business.id,
          name: spec.name,
          sku: spec.sku,
          barcode: spec.barcode,
          categoryId: catByName.get(spec.category) ?? null,
          baseUnitId: unitByName.get(spec.baseUnit)!,
          purchaseCostMinor: parseMoney(spec.purchaseCost),
          retailPriceMinor: parseMoney(spec.retail),
          wholesalePriceMinor: parseMoney(spec.wholesale),
          minStockMilli: parseQty(spec.minStock),
          defaultSupplierId: spec.supplierId,
          expiryDate: spec.expiry ?? null,
        })
        .returning();
      productIds.set(spec.sku, product.id);

      await tx.insert(productUnits).values(
        spec.units.map((u, i) => ({
          productId: product.id,
          unitId: unitByName.get(u.unit)!,
          factorMilli: parseQty(u.factor),
          isBase: u.unit === spec.baseUnit,
          retailPriceMinor: u.retail ? parseMoney(u.retail) : null,
          wholesalePriceMinor: u.wholesale ? parseMoney(u.wholesale) : null,
          allowFraction: u.allowFraction ?? false,
          sortOrder: i,
        })),
      );

      const baseQtyMilli = parseQty(spec.openingQty);
      const value = (parseMoney(spec.purchaseCost) * baseQtyMilli) / 1000n;
      openingValue += value;
      await receiveStock(tx, {
        businessId: business.id,
        productId: product.id,
        warehouseId: mainWarehouse.id,
        type: "opening",
        qtyMilli: baseQtyMilli,
        totalValueMinor: value,
        referenceType: "opening",
        referenceId: business.id,
        userId: ownerUserId,
        note: "رصيد افتتاحي",
      });
    }

    const cashOpening = parseMoney("500000");
    await postJournal(tx, {
      businessId: business.id,
      memo: "الرصيد الافتتاحي للنشاط",
      sourceType: "opening",
      sourceId: business.id,
      userId: ownerUserId,
      lines: [
        { accountCode: SYSTEM_ACCOUNTS[0].code, debit: cashOpening },
        { accountCode: SYSTEM_ACCOUNTS[3].code, debit: openingValue },
        { accountCode: SYSTEM_ACCOUNTS[6].code, credit: cashOpening + openingValue },
      ],
    });

    const ownerSession: Session = {
      userId: ownerUserId,
      businessId: business.id,
      email: "owner@demo.local",
      name: "سالم عبدالله (المالك)",
      role: "owner",
      businessName: business.name,
    };

    const now = Date.now();
    const water = productIds.get("WTR-600")!;
    const rice = productIds.get("RICE-5")!;
    const tea = productIds.get("TEA-250")!;

    const waterUnits = await tx.select().from(productUnits).where(eq(productUnits.productId, water));
    const riceUnits = await tx.select().from(productUnits).where(eq(productUnits.productId, rice));
    const teaUnits = await tx.select().from(productUnits).where(eq(productUnits.productId, tea));
    const unitId = (list: typeof waterUnits, factor: string) =>
      list.find((u) => u.factorMilli === parseQty(factor))!.unitId;

    await createSale(tx, ownerSession, {
      kind: "sale",
      customerId: customerRows[0].id,
      warehouseId: mainWarehouse.id,
      cashboxId: mainCashbox.id,
      items: [
        {
          productId: water,
          unitId: unitId(waterUnits, "24"),
          qty: "3",
          priceTier: "wholesale",
        },
      ],
      paymentType: "credit",
      occurredAt: new Date(now - 1000 * 60 * 90).toISOString(),
      idempotencyKey: "seed-sale-1",
    });

    await createSale(tx, ownerSession, {
      kind: "sale",
      customerId: customerRows[1].id,
      warehouseId: mainWarehouse.id,
      cashboxId: mainCashbox.id,
      items: [
        { productId: rice, unitId: unitId(riceUnits, "1"), qty: "2", priceTier: "retail" },
        { productId: water, unitId: unitId(waterUnits, "1"), qty: "12", priceTier: "retail" },
      ],
      paymentType: "cash",
      occurredAt: new Date(now - 1000 * 60 * 45).toISOString(),
      idempotencyKey: "seed-sale-2",
    });

    await createSale(tx, ownerSession, {
      kind: "sale",
      customerId: customerRows[2].id,
      warehouseId: mainWarehouse.id,
      cashboxId: mainCashbox.id,
      items: [
        { productId: tea, unitId: unitId(teaUnits, "12"), qty: "5", priceTier: "wholesale" },
      ],
      paymentType: "mixed",
      paid: "50000",
      occurredAt: new Date(now - 1000 * 60 * 15).toISOString(),
      idempotencyKey: "seed-sale-3",
    });

    await createPayment(tx, ownerSession, {
      direction: "customer_receipt",
      customerId: customerRows[0].id,
      amount: "3000",
      method: "cash",
      cashboxId: mainCashbox.id,
      occurredAt: new Date(now - 1000 * 60 * 5).toISOString(),
      idempotencyKey: "seed-payment-1",
    });

    await createExpense(tx, ownerSession, {
      category: "كهرباء ومياه",
      description: "فاتورة كهرباء المحل",
      amount: "5000",
      cashboxId: mainCashbox.id,
      paidAt: new Date(now - 1000 * 60 * 30).toISOString(),
      idempotencyKey: "seed-expense-1",
    });

    await writeAudit(tx, {
      businessId: business.id,
      userId: ownerUserId,
      action: "seed.demo_data",
      entityType: "business",
      entityId: business.id,
      after: { products: specs.length, openingValue: openingValue.toString() },
    });

    void branchWarehouse;
  });

  return { businessId: (await ensureBusinessId()), seeded: true };
}

async function ensureBusinessId(): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.name, DEMO_BUSINESS));
  return row.id;
}

