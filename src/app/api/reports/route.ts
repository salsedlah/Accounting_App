import { z } from "zod";
import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { AppError, ok, route, searchParams } from "@/server/api";
import { requirePermission } from "@/server/auth";
import {
  balanceSheet,
  cashFlow,
  expenseBreakdown,
  inventoryValuation,
  listDocuments,
  lowStock,
  pnl,
  productPerformance,
  salesByDay,
  salesTotals,
  trialBalance,
  type Period,
} from "@/server/services/reports";

const reportTypeSchema = z.enum([
  "sales",
  "products",
  "pnl",
  "inventory",
  "trial",
  "balance",
  "cashflow",
  "expenses",
  "lowstock",
  "documents",
]);

function reportDate(value: string | null, fallback: Date): Date {
  if (!value) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError("صيغة التاريخ يجب أن تكون YYYY-MM-DD", 400);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new AppError("التاريخ غير صالح", 400);
  }
  return date;
}

export async function GET(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.reportsRead);
    const params = searchParams(request);
    const type = reportTypeSchema.parse(params.get("type") ?? "sales");
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const period: Period = {
      from: reportDate(params.get("from"), monthStart),
      to: reportDate(params.get("to"), now),
    };
    if (period.from > period.to) throw new AppError("بداية الفترة يجب أن تسبق نهايتها", 400);

    const data = await transaction(async (tx) => {
      switch (type) {
        case "sales":
          return {
            totals: await salesTotals(tx, session.businessId, period),
            daily: await salesByDay(tx, session.businessId, period),
          };
        case "products":
          return { products: await productPerformance(tx, session.businessId, period) };
        case "pnl":
          return pnl(tx, session.businessId, period);
        case "inventory":
          return { valuation: await inventoryValuation(tx, session.businessId) };
        case "trial":
          return { balance: await trialBalance(tx, session.businessId, period.to) };
        case "balance":
          return balanceSheet(tx, session.businessId, period.to, period);
        case "cashflow":
          return cashFlow(tx, session.businessId, period);
        case "expenses":
          return expenseBreakdown(tx, session.businessId, period);
        case "lowstock":
          return { products: await lowStock(tx, session.businessId) };
        case "documents":
          return { documents: await listDocuments(tx, session.businessId, 200) };
      }
      throw new AppError("نوع التقرير غير مدعوم", 400);
    });
    return ok(data);
  });
}
