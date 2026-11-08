import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  accounts,
  cashboxes,
  cashTransactions,
  customers,
  expenses,
  inventoryBalances,
  journalEntries,
  journalLines,
  payments,
  productCategories,
  products,
  purchases,
  saleItems,
  sales,
  suppliers,
} from "@/db/schema";
import { ACCOUNT_CODES } from "@/lib/constants";
import { mulDiv } from "@/lib/money";
import { listCashboxes } from "./cashbox";
import { listCustomers, listSuppliers } from "./parties";
import { listSales } from "./sales";

export type Period = { from: Date; to: Date };

export async function salesTotals(tx: Tx, businessId: string, period: Period) {
  const [row] = await tx
    .select({
      sales: sql<string>`coalesce(sum(case when ${sales.kind} = 'sale' then ${sales.totalMinor} else 0 end), 0)`,
      returns: sql<string>`coalesce(sum(case when ${sales.kind} = 'return' then ${sales.totalMinor} else 0 end), 0)`,
      cogs: sql<string>`coalesce(sum(case when ${sales.kind} = 'sale' then ${sales.costTotalMinor} else 0 end), 0)`,
      cogsReturned: sql<string>`coalesce(sum(case when ${sales.kind} = 'return' then ${sales.costTotalMinor} else 0 end), 0)`,
      invoiceCount: sql<string>`count(*)`,
      due: sql<string>`coalesce(sum(${sales.dueMinor}), 0)`,
    })
    .from(sales)
    .where(
      and(
        eq(sales.businessId, businessId),
        eq(sales.status, "posted"),
        gte(sales.occurredAt, period.from),
        lte(sales.occurredAt, period.to),
      ),
    );
  const grossSales = BigInt(row.sales);
  const returns = BigInt(row.returns);
  const cogs = BigInt(row.cogs) - BigInt(row.cogsReturned);
  return {
    grossSalesMinor: grossSales,
    returnsMinor: returns,
    netSalesMinor: grossSales - returns,
    cogsMinor: cogs,
    grossProfitMinor: grossSales - returns - cogs,
    dueMinor: BigInt(row.due),
    invoiceCount: Number(row.invoiceCount),
  };
}

export async function pnl(tx: Tx, businessId: string, period: Period) {
  const rows = await tx
    .select({
      accountId: accounts.id,
      code: accounts.code,
      name: accounts.nameAr,
      type: accounts.type,
      debit: sql<string>`coalesce(sum(${journalLines.debitMinor}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.creditMinor}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(
      and(
        eq(journalEntries.businessId, businessId),
        gte(journalEntries.entryDate, period.from),
        lte(journalEntries.entryDate, period.to),
      ),
    )
    .groupBy(accounts.id, accounts.code, accounts.nameAr, accounts.type);

  const revenue: Array<{ code: string; name: string; amountMinor: bigint }> = [];
  const expense: Array<{ code: string; name: string; amountMinor: bigint }> = [];
  for (const row of rows) {
    const debit = BigInt(row.debit);
    const credit = BigInt(row.credit);
    if (row.type === "revenue") {
      const amount = credit - debit;
      if (amount !== 0n) revenue.push({ code: row.code, name: row.name, amountMinor: amount });
    } else if (row.type === "expense") {
      const amount = debit - credit;
      if (amount !== 0n) expense.push({ code: row.code, name: row.name, amountMinor: amount });
    }
  }
  const totalRevenue = revenue.reduce((s, r) => s + r.amountMinor, 0n);
  const totalExpense = expense.reduce((s, r) => s + r.amountMinor, 0n);
  return {
    period,
    revenue,
    expense,
    totalRevenueMinor: totalRevenue,
    totalExpenseMinor: totalExpense,
    netProfitMinor: totalRevenue - totalExpense,
  };
}

export async function salesByDay(tx: Tx, businessId: string, period: Period) {
  const dayExpr = sql<string>`to_char(${sales.occurredAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await tx
    .select({
      day: dayExpr,
      sales: sql<string>`coalesce(sum(case when ${sales.kind} = 'sale' then ${sales.totalMinor} else 0 end), 0)`,
      returns: sql<string>`coalesce(sum(case when ${sales.kind} = 'return' then ${sales.totalMinor} else 0 end), 0)`,
      cogs: sql<string>`coalesce(sum(case when ${sales.kind} = 'sale' then ${sales.costTotalMinor} else -${sales.costTotalMinor} end), 0)`,
      count: sql<string>`count(*)`,
    })
    .from(sales)
    .where(
      and(
        eq(sales.businessId, businessId),
        eq(sales.status, "posted"),
        gte(sales.occurredAt, period.from),
        lte(sales.occurredAt, period.to),
      ),
    )
    .groupBy(dayExpr)
    .orderBy(dayExpr);
  return rows.map((r) => ({
    day: r.day,
    salesMinor: BigInt(r.sales),
    returnsMinor: BigInt(r.returns),
    netMinor: BigInt(r.sales) - BigInt(r.returns),
    cogsMinor: BigInt(r.cogs),
    grossProfitMinor: BigInt(r.sales) - BigInt(r.returns) - BigInt(r.cogs),
    count: Number(r.count),
  }));
}

export async function productPerformance(tx: Tx, businessId: string, period: Period) {
  const rows = await tx
    .select({
      productId: products.id,
      name: products.name,
      sku: products.sku,
      category: productCategories.name,
      qtyBaseMilli: sql<string>`coalesce(sum(case when ${sales.id} is not null then ${saleItems.qtyBaseMilli} else 0 end), 0)`,
      revenueMinor: sql<string>`coalesce(sum(case when ${sales.id} is not null then ${saleItems.lineTotalMinor} else 0 end), 0)`,
      costMinor: sql<string>`coalesce(sum(case when ${sales.id} is not null then ${saleItems.costTotalMinor} else 0 end), 0)`,
      salesCount: sql<string>`count(${sales.id})`,
    })
    .from(products)
    .leftJoin(productCategories, eq(productCategories.id, products.categoryId))
    .leftJoin(saleItems, eq(saleItems.productId, products.id))
    .leftJoin(
      sales,
      and(
        eq(sales.id, saleItems.saleId),
        eq(sales.kind, "sale"),
        eq(sales.status, "posted"),
        gte(sales.occurredAt, period.from),
        lte(sales.occurredAt, period.to),
      ),
    )
    .where(eq(products.businessId, businessId))
    .groupBy(products.id, products.name, products.sku, productCategories.name);
  return rows.map((r) => ({
    ...r,
    qtyBaseMilli: BigInt(r.qtyBaseMilli),
    revenueMinor: BigInt(r.revenueMinor),
    costMinor: BigInt(r.costMinor),
    profitMinor: BigInt(r.revenueMinor) - BigInt(r.costMinor),
    salesCount: Number(r.salesCount),
  }));
}

export async function inventoryValuation(tx: Tx, businessId: string) {
  const rows = await tx
    .select({
      productId: products.id,
      name: products.name,
      sku: products.sku,
      baseUnitId: products.baseUnitId,
      qtyMilli: sql<string>`coalesce(sum(${inventoryBalances.qtyMilli}), 0)`,
      valueMinor: sql<string>`coalesce(sum(${inventoryBalances.valueMinor}), 0)`,
    })
    .from(products)
    .leftJoin(inventoryBalances, eq(inventoryBalances.productId, products.id))
    .where(and(eq(products.businessId, businessId), eq(products.isActive, true)))
    .groupBy(products.id, products.name, products.sku, products.baseUnitId)
    .orderBy(desc(sql`sum(${inventoryBalances.valueMinor})`));
  const items = rows.map((r) => {
    const qty = BigInt(r.qtyMilli);
    const value = BigInt(r.valueMinor);
    return {
      ...r,
      qtyMilli: qty,
      valueMinor: value,
      avgCostMinor: qty > 0n ? mulDiv(value, 1000n, qty) : 0n,
    };
  });
  return {
    items,
    totalQtyMilli: items.reduce((s, i) => s + i.qtyMilli, 0n),
    totalValueMinor: items.reduce((s, i) => s + i.valueMinor, 0n),
  };
}

export async function trialBalance(tx: Tx, businessId: string, asOf: Date) {
  const rows = await tx
    .select({
      accountId: accounts.id,
      code: accounts.code,
      name: accounts.nameAr,
      type: accounts.type,
      debit: sql<string>`coalesce(sum(${journalLines.debitMinor}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.creditMinor}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(journalEntries.businessId, businessId), lte(journalEntries.entryDate, asOf)))
    .groupBy(accounts.id, accounts.code, accounts.nameAr, accounts.type)
    .orderBy(accounts.code);
  const items = rows.map((r) => {
    const debit = BigInt(r.debit);
    const credit = BigInt(r.credit);
    const net = debit - credit;
    return {
      ...r,
      debitMinor: debit,
      creditMinor: credit,
      debitBalanceMinor: net > 0n ? net : 0n,
      creditBalanceMinor: net < 0n ? -net : 0n,
    };
  });
  return {
    items,
    totalDebitMinor: items.reduce((s, i) => s + i.debitBalanceMinor, 0n),
    totalCreditMinor: items.reduce((s, i) => s + i.creditBalanceMinor, 0n),
  };
}

export async function balanceSheet(tx: Tx, businessId: string, asOf: Date, period: Period) {
  const tb = await trialBalance(tx, businessId, asOf);
  const profit = await pnl(tx, businessId, period);
  const assets = tb.items.filter((i) => i.type === "asset");
  const liabilities = tb.items.filter((i) => i.type === "liability");
  const equity = tb.items.filter((i) => i.type === "equity");
  const totalAssets = assets.reduce((s, i) => s + i.debitBalanceMinor - i.creditBalanceMinor, 0n);
  const totalLiabilities = liabilities.reduce(
    (s, i) => s + i.creditBalanceMinor - i.debitBalanceMinor,
    0n,
  );
  const totalEquity = equity.reduce((s, i) => s + i.creditBalanceMinor - i.debitBalanceMinor, 0n);
  return {
    asOf,
    assets,
    liabilities,
    equity,
    netProfitMinor: profit.netProfitMinor,
    totalAssetsMinor: totalAssets,
    totalLiabilitiesMinor: totalLiabilities,
    totalEquityMinor: totalEquity,
    balanced:
      totalAssets === totalLiabilities + totalEquity + profit.netProfitMinor,
  };
}

export async function cashFlow(tx: Tx, businessId: string, period: Period) {
  const rows = await tx
    .select({
      sourceType: cashTransactions.sourceType,
      direction: cashTransactions.direction,
      total: sql<string>`coalesce(sum(${cashTransactions.amountMinor}), 0)`,
    })
    .from(cashTransactions)
    .where(
      and(
        eq(cashTransactions.businessId, businessId),
        gte(cashTransactions.createdAt, period.from),
        lte(cashTransactions.createdAt, period.to),
      ),
    )
    .groupBy(cashTransactions.sourceType, cashTransactions.direction);
  const inflow = rows
    .filter((r) => r.direction === "inflow")
    .reduce((s, r) => s + BigInt(r.total), 0n);
  const outflow = rows
    .filter((r) => r.direction === "outflow")
    .reduce((s, r) => s + BigInt(r.total), 0n);
  return {
    rows: rows.map((r) => ({ ...r, totalMinor: BigInt(r.total) })),
    inflowMinor: inflow,
    outflowMinor: outflow,
    netMinor: inflow - outflow,
  };
}

export async function expenseBreakdown(tx: Tx, businessId: string, period: Period) {
  const rows = await tx
    .select({
      category: expenses.category,
      total: sql<string>`coalesce(sum(${expenses.amountMinor}), 0)`,
      count: sql<string>`count(*)`,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.businessId, businessId),
        gte(expenses.paidAt, period.from),
        lte(expenses.paidAt, period.to),
      ),
    )
    .groupBy(expenses.category)
    .orderBy(desc(sql`sum(${expenses.amountMinor})`));
  return rows.map((r) => ({ ...r, totalMinor: BigInt(r.total), count: Number(r.count) }));
}

export async function lowStock(tx: Tx, businessId: string) {
  const rows = await tx
    .select({
      id: products.id,
      name: products.name,
      sku: products.sku,
      minStockMilli: products.minStockMilli,
      qtyMilli: sql<string>`coalesce(sum(${inventoryBalances.qtyMilli}), 0)`,
      expiryDate: products.expiryDate,
    })
    .from(products)
    .leftJoin(inventoryBalances, eq(inventoryBalances.productId, products.id))
    .where(and(eq(products.businessId, businessId), eq(products.isActive, true)))
    .groupBy(products.id, products.name, products.sku, products.minStockMilli, products.expiryDate);
  return rows
    .map((r) => ({ ...r, qtyMilli: BigInt(r.qtyMilli) }))
    .filter((r) => r.minStockMilli > 0n && r.qtyMilli <= r.minStockMilli)
    .sort((a, b) => Number(a.qtyMilli - b.qtyMilli));
}

export async function getDashboard(tx: Tx, businessId: string) {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const today: Period = { from: todayStart, to: now };
  const month: Period = { from: monthStart, to: now };

  const [todaySales, monthPnl, cashboxesList, customersList, suppliersList, inventory, low, recent, performance] =
    await Promise.all([
      salesTotals(tx, businessId, today),
      pnl(tx, businessId, month),
      listCashboxes(tx, businessId),
      listCustomers(tx, businessId),
      listSuppliers(tx, businessId),
      inventoryValuation(tx, businessId),
      lowStock(tx, businessId),
      listSales(tx, businessId, 6),
      productPerformance(tx, businessId, month),
    ]);

  const cashMinor = cashboxesList.reduce((s, c) => s + c.expectedBalanceMinor, 0n);
  const receivable = customersList.reduce(
    (s, c) => s + (c.balanceMinor > 0n ? c.balanceMinor : 0n),
    0n,
  );
  const payable = suppliersList.reduce(
    (s, s2) => s + (s2.balanceMinor > 0n ? s2.balanceMinor : 0n),
    0n,
  );
  const overLimitCustomers = customersList.filter((c) => c.overLimit);

  return {
    todaySales,
    monthPnl,
    cashMinor,
    receivableMinor: receivable,
    payableMinor: payable,
    inventoryValueMinor: inventory.totalValueMinor,
    lowStockCount: low.length,
    lowStock: low.slice(0, 8),
    recentSales: recent,
    topProducts: performance
      .filter((p) => p.qtyBaseMilli > 0n)
      .sort((a, b) => Number(b.revenueMinor - a.revenueMinor))
      .slice(0, 5),
    overLimitCustomers,
    cashboxes: cashboxesList,
  };
}

export async function listDocuments(tx: Tx, businessId: string, limit = 100) {
  const [saleRows, purchaseRows, paymentRows, expenseRows] = await Promise.all([
    tx
      .select({
        id: sales.id,
        kind: sales.kind,
        docNo: sales.invoiceNo,
        party: customers.name,
        totalMinor: sales.totalMinor,
        status: sales.status,
        createdAt: sales.createdAt,
        docType: sql<string>`case when ${sales.kind} = 'sale' then 'sale' else 'sale_return' end`,
      })
      .from(sales)
      .leftJoin(customers, eq(customers.id, sales.customerId))
      .where(eq(sales.businessId, businessId))
      .orderBy(desc(sales.createdAt))
      .limit(limit),
    tx
      .select({
        id: purchases.id,
        kind: purchases.kind,
        docNo: purchases.invoiceNo,
        party: suppliers.name,
        totalMinor: purchases.totalMinor,
        status: purchases.status,
        createdAt: purchases.createdAt,
        docType: sql<string>`case when ${purchases.kind} = 'purchase' then 'purchase' else 'purchase_return' end`,
      })
      .from(purchases)
      .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
      .where(eq(purchases.businessId, businessId))
      .orderBy(desc(purchases.createdAt))
      .limit(limit),
    tx
      .select({
        id: payments.id,
        docNo: payments.paymentNo,
        party: sql<string>`coalesce(${customers.name}, ${suppliers.name})`,
        totalMinor: payments.amountMinor,
        createdAt: payments.createdAt,
        docType: sql<string>`case when ${payments.direction} = 'customer_receipt' then 'receipt' else 'supplier_payment' end`,
      })
      .from(payments)
      .leftJoin(customers, eq(customers.id, payments.customerId))
      .leftJoin(suppliers, eq(suppliers.id, payments.supplierId))
      .where(eq(payments.businessId, businessId))
      .orderBy(desc(payments.createdAt))
      .limit(limit),
    tx
      .select({
        id: expenses.id,
        docNo: expenses.expenseNo,
        party: expenses.description,
        totalMinor: expenses.amountMinor,
        createdAt: expenses.paidAt,
        docType: sql<string>`'expense'`,
      })
      .from(expenses)
      .where(eq(expenses.businessId, businessId))
      .orderBy(desc(expenses.paidAt))
      .limit(limit),
  ]);

  return [...saleRows, ...purchaseRows, ...paymentRows, ...expenseRows]
    .map((row) => ({ status: "posted", ...row }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}

export async function totalCash(tx: Tx, businessId: string) {
  const [boxes, txns] = await Promise.all([
    tx.select().from(cashboxes).where(eq(cashboxes.businessId, businessId)),
    tx
      .select({
        direction: cashTransactions.direction,
        total: sql<string>`coalesce(sum(${cashTransactions.amountMinor}), 0)`,
      })
      .from(cashTransactions)
      .where(eq(cashTransactions.businessId, businessId))
      .groupBy(cashTransactions.direction),
  ]);
  const opening = boxes.reduce((s, b) => s + b.openingBalanceMinor, 0n);
  const inflow = BigInt(txns.find((t) => t.direction === "inflow")?.total ?? "0");
  const outflow = BigInt(txns.find((t) => t.direction === "outflow")?.total ?? "0");
  return opening + inflow - outflow;
}

export { ACCOUNT_CODES };
