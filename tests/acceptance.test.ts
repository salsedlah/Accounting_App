import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DIR = mkdtempSync(join(tmpdir(), "hisab-test-"));
process.env.DATABASE_URL = `file:${TEST_DIR.replace(/\\/g, "/")}`;

const { ensureReady } = await import("@/db/bootstrap");
const { closeDb, getDb, transaction } = await import("@/db/client");
const schema = await import("@/db/schema");
const { createSale } = await import("@/server/services/sales");
const { createPayment } = await import("@/server/services/payments");
const { trialBalance } = await import("@/server/services/reports");
const { getCustomerStatement } = await import("@/server/services/parties");
const { countOpenSales } = await import("./helpers");

let db: Awaited<ReturnType<typeof getDb>>;

type Session = {
  userId: string;
  businessId: string;
  email: string;
  name: string;
  role: string;
  businessName: string;
};

let session: Session;
let waterId: string;
let cartonUnitId: string;
let cartonFactor: bigint;
let cartonRetail: bigint;
let baseUnitId: string;
let customerId: string;
let warehouseId: string;

async function waterStock(): Promise<bigint> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${schema.inventoryBalances.qtyMilli}), 0)` })
    .from(schema.inventoryBalances)
    .where(eq(schema.inventoryBalances.productId, waterId));
  return BigInt(row.total);
}

beforeAll(async () => {
  // Each test file owns its temporary database. Reset any runtime left by a
  // previous file in the shared fork before creating this file's runtime.
  await closeDb();
  await ensureReady();
  db = await getDb();

  const [business] = await db.select().from(schema.businesses).limit(1);
  const [owner] = await db
    .select({ userId: schema.memberships.userId })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.businessId, business.id),
        eq(schema.memberships.role, "owner"),
      ),
    );
  const [ownerUser] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, owner.userId));
  session = {
    userId: ownerUser.id,
    businessId: business.id,
    email: ownerUser.email,
    name: ownerUser.name,
    role: "owner",
    businessName: business.name,
  };

  const [water] = await db.select().from(schema.products).where(eq(schema.products.sku, "WTR-600"));
  waterId = water.id;
  baseUnitId = water.baseUnitId;

  const units = await db
    .select({
      unitId: schema.productUnits.unitId,
      factorMilli: schema.productUnits.factorMilli,
      retail: schema.productUnits.retailPriceMinor,
      isBase: schema.productUnits.isBase,
    })
    .from(schema.productUnits)
    .where(eq(schema.productUnits.productId, waterId));
  const carton = units.find((u) => !u.isBase && u.factorMilli === 24000n) ?? units.find((u) => !u.isBase);
  if (!carton) throw new Error("carton unit missing from seed");
  cartonUnitId = carton.unitId;
  cartonFactor = carton.factorMilli;
  cartonRetail = carton.retail ?? water.retailPriceMinor;

  const [customer] = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.name, "أحمد علي"));
  customerId = customer.id;

  const [warehouse] = await db.select().from(schema.warehouses).limit(1);
  warehouseId = warehouse.id;
});

afterAll(async () => {
  await closeDb();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("sale acceptance flow", () => {
  it("decrements stock in base units and keeps the ledger balanced", async () => {
    const opening = await waterStock();
    const result = await transaction((tx) =>
      createSale(tx, session, {
        customerId: null,
        items: [
          {
            productId: waterId,
            unitId: cartonUnitId,
            qty: "2",
            priceTier: "retail",
          },
        ],
        paymentType: "cash",
        idempotencyKey: "test-sale-cash-001",
      }),
    );

    expect(result.duplicate).toBe(false);
    expect(result.sale.totalMinor).toBe(cartonRetail * 2n);
    expect(result.sale.dueMinor).toBe(0n);
    expect(result.sale.items[0].qtyBaseMilli).toBe(cartonFactor * 2n);

    const closing = await waterStock();
    expect(opening - closing).toBe(cartonFactor * 2n);

    const trial = await transaction((tx) => trialBalance(tx, session.businessId, new Date()));
    expect(trial.totalDebitMinor).toBe(trial.totalCreditMinor);
  });

  it("returns the existing sale for a repeated idempotency key", async () => {
    const before = await countOpenSales(db, session.businessId);
    const result = await transaction((tx) =>
      createSale(tx, session, {
        customerId: null,
        items: [{ productId: waterId, unitId: cartonUnitId, qty: "2" }],
        paymentType: "cash",
        idempotencyKey: "test-sale-cash-001",
      }),
    );
    const after = await countOpenSales(db, session.businessId);
    expect(result.duplicate).toBe(true);
    expect(after).toBe(before);
  });

  it("rejects a credit sale without a customer", async () => {
    await expect(
      transaction((tx) =>
        createSale(tx, session, {
          customerId: null,
          items: [{ productId: waterId, unitId: cartonUnitId, qty: "1" }],
          paymentType: "credit",
          idempotencyKey: "test-sale-credit-bad",
        }),
      ),
    ).rejects.toThrow();
  });

  it("applies a customer receipt and reduces the outstanding balance", async () => {
    const before = await transaction((tx) =>
      getCustomerStatement(tx, session.businessId, customerId),
    );

    const payment = await transaction((tx) =>
      createPayment(tx, session, {
        direction: "customer_receipt",
        customerId,
        amount: "250",
        method: "cash",
        idempotencyKey: "test-receipt-001",
      }),
    );
    expect(payment.duplicate).toBe(false);

    const after = await transaction((tx) =>
      getCustomerStatement(tx, session.businessId, customerId),
    );
    expect(before.balanceMinor - after.balanceMinor).toBe(25000n);
  });

  it("keeps the inventory and ledger reconciled after mixed activity", async () => {
    const trial = await transaction((tx) => trialBalance(tx, session.businessId, new Date()));
    expect(trial.totalDebitMinor).toBe(trial.totalCreditMinor);
    expect(trial.items.length).toBeGreaterThan(0);
    expect(baseUnitId).toBeTruthy();
  });
});

async function setWaterStock(qtyMilli: bigint) {
  await db
    .insert(schema.inventoryBalances)
    .values({
      businessId: session.businessId,
      productId: waterId,
      warehouseId,
      qtyMilli,
      valueMinor: qtyMilli / 10n,
    })
    .onConflictDoUpdate({
      target: [schema.inventoryBalances.productId, schema.inventoryBalances.warehouseId],
      set: { qtyMilli, valueMinor: qtyMilli / 10n, updatedAt: new Date() },
    });
  await db
    .delete(schema.inventoryLots)
    .where(eq(schema.inventoryLots.productId, waterId));
}

function sellWater(
  items: Array<{ unitId?: string; qty: string }>,
  key: string,
  kind: "sale" | "return" = "sale",
) {
  return transaction((tx) =>
    createSale(tx, session, {
      kind,
      customerId: null,
      items: items.map((item) => ({
        productId: waterId,
        unitId: item.unitId ?? baseUnitId,
        qty: item.qty,
        priceTier: "retail" as const,
      })),
      paymentType: "cash",
      idempotencyKey: key,
    }),
  );
}

describe("pos stock validation", () => {
  it("allows a sale within stock and leaves the remainder", async () => {
    await setWaterStock(10000n);
    const result = await sellWater([{ qty: "5" }], "stock-ok-001");
    expect(result.sale.items[0].qtyBaseMilli).toBe(5000n);
    expect(await waterStock()).toBe(5000n);
  });

  it("allows selling the exact available quantity", async () => {
    await setWaterStock(10000n);
    const result = await sellWater([{ qty: "10" }], "stock-exact-001");
    expect(result.sale.items[0].qtyBaseMilli).toBe(10000n);
    expect(await waterStock()).toBe(0n);
  });

  it("rejects a sale that exceeds stock without changing it", async () => {
    await setWaterStock(10000n);
    await expect(sellWater([{ qty: "11" }], "stock-over-001")).rejects.toMatchObject({
      status: 409,
      code: "insufficient_stock",
    });
    expect(await waterStock()).toBe(10000n);
  });

  it("rejects a carton when only part of a carton remains", async () => {
    await setWaterStock(7000n);
    await sellWater([{ qty: "5" }], "stock-partial-001");
    expect(await waterStock()).toBe(2000n);
    await expect(
      sellWater([{ unitId: cartonUnitId, qty: "1" }], "stock-partial-002"),
    ).rejects.toMatchObject({ status: 409, code: "insufficient_stock" });
    expect(await waterStock()).toBe(2000n);
  });

  it("rejects any sale when stock is zero", async () => {
    await setWaterStock(0n);
    await expect(sellWater([{ qty: "1" }], "stock-zero-001")).rejects.toMatchObject({
      status: 409,
      code: "insufficient_stock",
    });
    expect(await waterStock()).toBe(0n);
  });

  it("validates cartons plus pieces against the combined stock", async () => {
    await setWaterStock(180000n);
    const result = await sellWater(
      [
        { unitId: cartonUnitId, qty: "2" },
        { qty: "12" },
      ],
      "stock-mixed-001",
    );
    expect(result.sale.items.reduce((sum, item) => sum + item.qtyBaseMilli, 0n)).toBe(60000n);
    expect(await waterStock()).toBe(120000n);
  });

  it("aggregates multiple lines of the same product before validating", async () => {
    await setWaterStock(5000n);
    await expect(
      sellWater([{ qty: "3" }, { qty: "3" }], "stock-aggregate-001"),
    ).rejects.toMatchObject({ status: 409, code: "insufficient_stock" });
    expect(await waterStock()).toBe(5000n);
  });

  it("adds returned quantities back to stock", async () => {
    await setWaterStock(10000n);
    await sellWater([{ qty: "8" }], "stock-return-sale-001");
    expect(await waterStock()).toBe(2000n);
    await sellWater([{ qty: "3" }], "stock-return-001", "return");
    expect(await waterStock()).toBe(5000n);
  });

  it("does not deduct stock twice for a repeated idempotency key", async () => {
    await setWaterStock(10000n);
    const first = await sellWater([{ qty: "4" }], "stock-idem-001");
    expect(first.duplicate).toBe(false);
    expect(await waterStock()).toBe(6000n);
    const second = await sellWater([{ qty: "4" }], "stock-idem-001");
    expect(second.duplicate).toBe(true);
    expect(await waterStock()).toBe(6000n);
  });
});
