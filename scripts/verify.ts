import { and, eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../src/db/client";
import {
  businesses,
  customers,
  inventoryBalances,
  inventoryMovements,
  journalEntries,
  journalLines,
  products,
  sales,
} from "../src/db/schema";
import { getCustomerStatement } from "../src/server/services/parties";
import { pnl, salesTotals } from "../src/server/services/reports";
import { formatMoney } from "../src/lib/money";
import { formatQty } from "../src/lib/quantity";

try {
  process.loadEnvFile?.(".env");
} catch {
  /* ignore */
}

async function main() {
  const db = await getDb();
  const [business] = await db.select().from(businesses);
  const [water] = await db.select().from(products).where(eq(products.sku, "WTR-600"));
  const [balance] = await db
    .select()
    .from(inventoryBalances)
    .where(eq(inventoryBalances.productId, water.id));
  console.log("water stock:", formatQty(balance.qtyMilli), "value:", formatMoney(balance.valueMinor));

  const [saleTotals] = await db
    .select({
      debit: sql<string>`coalesce(sum(${journalLines.debitMinor}),0)`,
      credit: sql<string>`coalesce(sum(${journalLines.creditMinor}),0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(eq(journalEntries.businessId, business.id));
  console.log("journal debit:", saleTotals.debit, "credit:", saleTotals.credit, "balanced:", saleTotals.debit === saleTotals.credit);

  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const totals = await salesTotals(db as never, business.id, { from: start, to: now });
  console.log("net sales:", formatMoney(totals.netSalesMinor), "cogs:", formatMoney(totals.cogsMinor), "gross profit:", formatMoney(totals.grossProfitMinor));
  const statement = await getCustomerStatement(db as never, business.id, (await db.select().from(customers).limit(1))[0].id);
  console.log("first customer balance:", formatMoney(statement.balanceMinor));

  const [movementCount] = await db
    .select({ n: sql<string>`count(*)` })
    .from(inventoryMovements)
    .where(eq(inventoryMovements.businessId, business.id));
  console.log("movements:", movementCount.n);
  const saleRows = await db.select().from(sales).where(and(eq(sales.businessId, business.id)));
  console.log("sales total:", formatMoney(saleRows.reduce((s, r) => s + r.totalMinor, 0n)));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => closeDb());
