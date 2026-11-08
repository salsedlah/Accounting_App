import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { inventoryBalances, inventoryLots, inventoryMovements } from "@/db/schema";
import { allocateProportionally, mulDiv } from "@/lib/money";
import { formatQty, proRataValue } from "@/lib/quantity";

export type ValuationMethod = "weighted_average" | "fifo";

export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryError";
  }
}

type MovementBase = {
  businessId: string;
  productId: string;
  warehouseId: string;
  userId?: string | null;
  note?: string | null;
  referenceType: string;
  referenceId: string;
  occurredAt?: Date;
  type:
    | "opening"
    | "purchase"
    | "purchase_return"
    | "sale"
    | "sale_return"
    | "adjustment"
    | "transfer_in"
    | "transfer_out"
    | "stocktake"
    | "damage";
};

export async function lockBalance(
  tx: Tx,
  businessId: string,
  productId: string,
  warehouseId: string,
) {
  await tx
    .insert(inventoryBalances)
    .values({ businessId, productId, warehouseId, qtyMilli: 0n, valueMinor: 0n })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(inventoryBalances)
    .where(
      and(
        eq(inventoryBalances.businessId, businessId),
        eq(inventoryBalances.productId, productId),
        eq(inventoryBalances.warehouseId, warehouseId),
      ),
    )
    .for("update");
  if (!row) throw new InventoryError("تعذر قفل رصيد المخزون");
  return row;
}

export async function getBalance(
  tx: Tx,
  businessId: string,
  productId: string,
  warehouseId: string,
) {
  const [row] = await tx
    .select()
    .from(inventoryBalances)
    .where(
      and(
        eq(inventoryBalances.businessId, businessId),
        eq(inventoryBalances.productId, productId),
        eq(inventoryBalances.warehouseId, warehouseId),
      ),
    );
  return row ?? null;
}

export type ReceiveStockInput = MovementBase & {
  qtyMilli: bigint;
  totalValueMinor: bigint;
};

/** Record a physical receipt (purchase, opening stock, return, transfer in...). */
export async function receiveStock(tx: Tx, input: ReceiveStockInput) {
  if (input.qtyMilli <= 0n) throw new InventoryError("كمية الاستلام يجب أن تكون أكبر من صفر");
  if (input.totalValueMinor < 0n) throw new InventoryError("قيمة الاستلام لا يمكن أن تكون سالبة");

  const balance = await lockBalance(tx, input.businessId, input.productId, input.warehouseId);

  const [movement] = await tx
    .insert(inventoryMovements)
    .values({
      businessId: input.businessId,
      productId: input.productId,
      warehouseId: input.warehouseId,
      type: input.type,
      qtyMilli: input.qtyMilli,
      valueMinor: input.totalValueMinor,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      userId: input.userId ?? null,
      note: input.note ?? null,
      createdAt: input.occurredAt ?? new Date(),
    })
    .returning();

  await tx
    .update(inventoryBalances)
    .set({
      qtyMilli: balance.qtyMilli + input.qtyMilli,
      valueMinor: balance.valueMinor + input.totalValueMinor,
      updatedAt: new Date(),
    })
    .where(eq(inventoryBalances.id, balance.id));

  await tx.insert(inventoryLots).values({
    businessId: input.businessId,
    productId: input.productId,
    warehouseId: input.warehouseId,
    sourceMovementId: movement.id,
    qtyReceivedMilli: input.qtyMilli,
    qtyRemainingMilli: input.qtyMilli,
    valueRemainingMinor: input.totalValueMinor,
    createdAt: input.occurredAt ?? new Date(),
  });

  return { movement, valueMinor: input.totalValueMinor };
}

export type IssueStockInput = MovementBase & {
  qtyMilli: bigint;
  valuation: ValuationMethod;
};

/** Record a physical issue and return its exact inventory cost. */
export async function issueStock(tx: Tx, input: IssueStockInput) {
  if (input.qtyMilli <= 0n) throw new InventoryError("كمية الصرف يجب أن تكون أكبر من صفر");

  const balance = await lockBalance(tx, input.businessId, input.productId, input.warehouseId);
  if (balance.qtyMilli < input.qtyMilli) {
    throw new InventoryError(
      `الكمية غير كافية. المتاح ${formatQty(balance.qtyMilli)} والمطلوب ${formatQty(input.qtyMilli)}`,
    );
  }

  let costMinor: bigint;
  let fifoConsumed = false;

  if (input.valuation === "fifo") {
    const result = await consumeFifoLots(
      tx,
      input.businessId,
      input.productId,
      input.warehouseId,
      input.qtyMilli,
    );
    if (result !== null) {
      costMinor = result;
      fifoConsumed = true;
    } else {
      costMinor = computeWeightedCost(balance, input.qtyMilli);
      await revalueWeightedLots(
        tx,
        input.businessId,
        input.productId,
        input.warehouseId,
        input.qtyMilli,
        balance.valueMinor - costMinor,
      );
    }
  } else {
    costMinor = computeWeightedCost(balance, input.qtyMilli);
    await revalueWeightedLots(
      tx,
      input.businessId,
      input.productId,
      input.warehouseId,
      input.qtyMilli,
      balance.valueMinor - costMinor,
    );
  }

  if (!fifoConsumed && costMinor > balance.valueMinor) costMinor = balance.valueMinor;
  if (costMinor < 0n) costMinor = 0n;

  const newQty = balance.qtyMilli - input.qtyMilli;
  const newValue = newQty === 0n ? 0n : balance.valueMinor - costMinor;

  const [movement] = await tx
    .insert(inventoryMovements)
    .values({
      businessId: input.businessId,
      productId: input.productId,
      warehouseId: input.warehouseId,
      type: input.type,
      qtyMilli: -input.qtyMilli,
      valueMinor: -costMinor,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      userId: input.userId ?? null,
      note: input.note ?? null,
      createdAt: input.occurredAt ?? new Date(),
    })
    .returning();

  await tx
    .update(inventoryBalances)
    .set({ qtyMilli: newQty, valueMinor: newValue < 0n ? 0n : newValue, updatedAt: new Date() })
    .where(eq(inventoryBalances.id, balance.id));

  return { movement, costMinor };
}

function computeWeightedCost(
  balance: { qtyMilli: bigint; valueMinor: bigint },
  qtyMilli: bigint,
): bigint {
  if (balance.qtyMilli === 0n) return 0n;
  if (qtyMilli >= balance.qtyMilli) return balance.valueMinor;
  return proRataValue(balance.valueMinor, qtyMilli, balance.qtyMilli);
}

async function consumeFifoLots(
  tx: Tx,
  businessId: string,
  productId: string,
  warehouseId: string,
  qtyMilli: bigint,
): Promise<bigint | null> {
  const lots = await tx
    .select()
    .from(inventoryLots)
    .where(
      and(
        eq(inventoryLots.businessId, businessId),
        eq(inventoryLots.productId, productId),
        eq(inventoryLots.warehouseId, warehouseId),
        gt(inventoryLots.qtyRemainingMilli, 0n),
      ),
    )
    .orderBy(asc(inventoryLots.createdAt), asc(inventoryLots.id))
    .for("update");

  let remaining = qtyMilli;
  let total = 0n;
  const plan: Array<{ lot: (typeof lots)[number]; take: bigint; value: bigint }> = [];
  for (const lot of lots) {
    if (remaining <= 0n) break;
    const take = lot.qtyRemainingMilli < remaining ? lot.qtyRemainingMilli : remaining;
    const value =
      take === lot.qtyRemainingMilli
        ? lot.valueRemainingMinor
        : mulDiv(lot.valueRemainingMinor, take, lot.qtyRemainingMilli);
    plan.push({ lot, take, value });
    total += value;
    remaining -= take;
  }
  if (remaining > 0n) return null;

  for (const item of plan) {
    await tx
      .update(inventoryLots)
      .set({
        qtyRemainingMilli: item.lot.qtyRemainingMilli - item.take,
        valueRemainingMinor: item.lot.valueRemainingMinor - item.value,
      })
      .where(eq(inventoryLots.id, item.lot.id));
  }
  return total;
}

/**
 * Weighted-average keeps lot quantities in FIFO order but redistributes the
 * remaining inventory value across the remaining quantities so the ledger and
 * the lot projection always reconcile.
 */
async function revalueWeightedLots(
  tx: Tx,
  businessId: string,
  productId: string,
  warehouseId: string,
  qtyToIssue: bigint,
  remainingValue: bigint,
) {
  const lots = await tx
    .select()
    .from(inventoryLots)
    .where(
      and(
        eq(inventoryLots.businessId, businessId),
        eq(inventoryLots.productId, productId),
        eq(inventoryLots.warehouseId, warehouseId),
        gt(inventoryLots.qtyRemainingMilli, 0n),
      ),
    )
    .orderBy(asc(inventoryLots.createdAt), asc(inventoryLots.id))
    .for("update");

  let toReduce = qtyToIssue;
  const remainingLots: Array<{ id: string; qty: bigint }> = [];
  for (const lot of lots) {
    let qty = lot.qtyRemainingMilli;
    if (toReduce > 0n) {
      const take = qty < toReduce ? qty : toReduce;
      qty -= take;
      toReduce -= take;
    }
    remainingLots.push({ id: lot.id, qty });
  }

  const totalQty = remainingLots.reduce((sum, l) => sum + l.qty, 0n);
  const target = remainingValue < 0n ? 0n : remainingValue;
  if (totalQty === 0n) {
    for (const lot of remainingLots) {
      await tx
        .update(inventoryLots)
        .set({ qtyRemainingMilli: 0n, valueRemainingMinor: 0n })
        .where(eq(inventoryLots.id, lot.id));
    }
    return;
  }

  const allocations = allocateProportionally(
    target,
    remainingLots.map((l) => l.qty),
  );
  for (let i = 0; i < remainingLots.length; i++) {
    await tx
      .update(inventoryLots)
      .set({ qtyRemainingMilli: remainingLots[i].qty, valueRemainingMinor: allocations[i] })
      .where(eq(inventoryLots.id, remainingLots[i].id));
  }
}

/** Moves stock between warehouses preserving its exact cost. */
export async function transferStock(
  tx: Tx,
  input: {
    businessId: string;
    productId: string;
    fromWarehouseId: string;
    toWarehouseId: string;
    qtyMilli: bigint;
    referenceId: string;
    userId?: string | null;
    note?: string | null;
    valuation: ValuationMethod;
  },
) {
  if (input.fromWarehouseId === input.toWarehouseId) {
    throw new InventoryError("لا يمكن التحويل إلى نفس المستودع");
  }
  const out = await issueStock(tx, {
    businessId: input.businessId,
    productId: input.productId,
    warehouseId: input.fromWarehouseId,
    type: "transfer_out",
    qtyMilli: input.qtyMilli,
    referenceType: "stock_transfer",
    referenceId: input.referenceId,
    userId: input.userId,
    note: input.note,
    valuation: input.valuation,
  });
  await receiveStock(tx, {
    businessId: input.businessId,
    productId: input.productId,
    warehouseId: input.toWarehouseId,
    type: "transfer_in",
    qtyMilli: input.qtyMilli,
    totalValueMinor: out.costMinor,
    referenceType: "stock_transfer",
    referenceId: input.referenceId,
    userId: input.userId,
    note: input.note,
  });
  return out;
}

export async function currentUnitCost(
  tx: Tx,
  businessId: string,
  productId: string,
  warehouseId: string,
): Promise<bigint> {
  const balance = await getBalance(tx, businessId, productId, warehouseId);
  if (!balance || balance.qtyMilli === 0n) return 0n;
  return mulDiv(balance.valueMinor, 1000n, balance.qtyMilli);
}

export async function rebuildBalancesFromMovements(tx: Tx, businessId: string) {
  const rows = await tx
    .select({
      productId: inventoryMovements.productId,
      warehouseId: inventoryMovements.warehouseId,
      qty: sql<string>`sum(${inventoryMovements.qtyMilli})`,
      value: sql<string>`sum(${inventoryMovements.valueMinor})`,
    })
    .from(inventoryMovements)
    .where(eq(inventoryMovements.businessId, businessId))
    .groupBy(inventoryMovements.productId, inventoryMovements.warehouseId);

  for (const row of rows) {
    await tx
      .insert(inventoryBalances)
      .values({
        businessId,
        productId: row.productId,
        warehouseId: row.warehouseId,
        qtyMilli: BigInt(row.qty),
        valueMinor: BigInt(row.value),
      })
      .onConflictDoUpdate({
        target: [inventoryBalances.productId, inventoryBalances.warehouseId],
        set: { qtyMilli: BigInt(row.qty), valueMinor: BigInt(row.value), updatedAt: new Date() },
      });
  }
}
