import Link from "next/link";
import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { formatMoney } from "@/lib/money";
import { formatQty } from "@/lib/quantity";
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

export const metadata = { title: "التقارير" };
export const dynamic = "force-dynamic";

const TABS = [
  { key: "overview", label: "ملخص" },
  { key: "sales", label: "المبيعات اليومية" },
  { key: "products", label: "أداء الأصناف" },
  { key: "pnl", label: "الأرباح والخسائر" },
  { key: "inventory", label: "تقييم المخزون" },
  { key: "trial", label: "ميزان المراجعة" },
  { key: "balance", label: "الميزانية" },
  { key: "cashflow", label: "التدفق النقدي" },
  { key: "expenses", label: "المصروفات" },
  { key: "lowstock", label: "مخزون منخفض" },
  { key: "documents", label: "المستندات" },
];

function parseDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function inputDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function Money({ value, tone }: { value: bigint; tone?: "ok" | "danger" }) {
  return (
    <span
      dir="ltr"
      className={`tabular-nums ${tone === "ok" ? "text-ok" : tone === "danger" ? "text-danger" : ""}`}
    >
      {formatMoney(value)}
    </span>
  );
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; from?: string; to?: string }>;
}) {
  await ensureReady();
  const session = await requirePermission(PERMISSIONS.reportsRead);
  const params = await searchParams;
  const tab = TABS.some((t) => t.key === params.tab) ? params.tab! : "overview";

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const from = parseDate(params.from, monthStart);
  const to = parseDate(params.to, now);
  to.setHours(23, 59, 59, 999);
  const period: Period = { from, to };
  const businessId = session.businessId;

  const overview =
    tab === "overview"
      ? await transaction(async (tx) => ({
          totals: await salesTotals(tx, businessId, period),
          top: (await productPerformance(tx, businessId, period))
            .sort((a, b) => Number(b.revenueMinor - a.revenueMinor))
            .slice(0, 8),
          lows: (await lowStock(tx, businessId)).slice(0, 8),
        }))
      : null;

  const salesRows =
    tab === "sales" ? await transaction((tx) => salesByDay(tx, businessId, period)) : null;

  const productRows =
    tab === "products"
      ? (await transaction((tx) => productPerformance(tx, businessId, period))).sort((a, b) =>
          Number(b.revenueMinor - a.revenueMinor),
        )
      : null;

  const pnlReport = tab === "pnl" ? await transaction((tx) => pnl(tx, businessId, period)) : null;
  const valuation =
    tab === "inventory" ? await transaction((tx) => inventoryValuation(tx, businessId)) : null;
  const trial =
    tab === "trial" ? await transaction((tx) => trialBalance(tx, businessId, to)) : null;
  const sheet =
    tab === "balance"
      ? await transaction((tx) => balanceSheet(tx, businessId, to, period))
      : null;
  const cash = tab === "cashflow" ? await transaction((tx) => cashFlow(tx, businessId, period)) : null;
  const expenseRows =
    tab === "expenses" ? await transaction((tx) => expenseBreakdown(tx, businessId, period)) : null;
  const lowRows = tab === "lowstock" ? await transaction((tx) => lowStock(tx, businessId)) : null;
  const documentRows =
    tab === "documents" ? await transaction((tx) => listDocuments(tx, businessId, 200)) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">التقارير</h1>
          <p className="text-xs text-ink-500">تحليل مالي وتشغيلي من القيود الفعلية</p>
        </div>
        <form className="flex flex-wrap items-end gap-2" method="get">
          <input type="hidden" name="tab" value={tab} />
          <label className="text-[11px] text-ink-500">
            من
            <input
              type="date"
              name="from"
              defaultValue={inputDate(from)}
              className="input mt-1 h-9 py-1"
            />
          </label>
          <label className="text-[11px] text-ink-500">
            إلى
            <input
              type="date"
              name="to"
              defaultValue={inputDate(to)}
              className="input mt-1 h-9 py-1"
            />
          </label>
          <button type="submit" className="h-9 rounded-lg bg-ink-800 px-3 text-xs text-white">
            تطبيق
          </button>
        </form>
      </div>

      <nav className="flex flex-wrap gap-1 rounded-xl border border-ink-200 bg-white p-1 shadow-card">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/reports?tab=${t.key}&from=${inputDate(from)}&to=${inputDate(to)}`}
            className={`rounded-lg px-3 py-1.5 text-xs transition ${
              t.key === tab ? "bg-brand-600 text-white" : "text-ink-600 hover:bg-ink-100"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {overview ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "إجمالي المبيعات", value: overview.totals.grossSalesMinor },
              { label: "صافي المبيعات", value: overview.totals.netSalesMinor },
              { label: "الربح الإجمالي", value: overview.totals.grossProfitMinor },
              { label: "مستحق الفواتير", value: overview.totals.dueMinor },
            ].map((card) => (
              <div key={card.label} className="rounded-2xl border border-ink-200 bg-white p-4 shadow-card">
                <p className="text-xs text-ink-500">{card.label}</p>
                <p className="mt-2 text-lg font-bold tabular-nums" dir="ltr">
                  {formatMoney(card.value)}
                </p>
              </div>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>الأكثر مبيعاً</th>
                    <th>الكمية</th>
                    <th>الإيراد</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.top.map((row) => (
                    <tr key={row.productId}>
                      <td className="text-xs">{row.name}</td>
                      <td className="tabular-nums text-xs">{formatQty(row.qtyBaseMilli)}</td>
                      <td className="tabular-nums text-xs">
                        <Money value={row.revenueMinor} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>مخزون منخفض</th>
                    <th>المتوفر</th>
                    <th>الحد</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.lows.map((row) => (
                    <tr key={row.id}>
                      <td className="text-xs">{row.name}</td>
                      <td className="tabular-nums text-xs text-danger">{formatQty(row.qtyMilli)}</td>
                      <td className="tabular-nums text-xs">{formatQty(row.minStockMilli)}</td>
                    </tr>
                  ))}
                  {!overview.lows.length ? (
                    <tr>
                      <td colSpan={3} className="py-8 text-center text-xs text-ink-500">
                        لا توجد أصناف منخفضة
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </section>
          </div>
        </div>
      ) : null}

      {salesRows ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>اليوم</th>
                <th>الفواتير</th>
                <th>المبيعات</th>
                <th>المرتجعات</th>
                <th>الصافي</th>
                <th>التكلفة</th>
                <th>الربح الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              {salesRows.map((row) => (
                <tr key={row.day}>
                  <td dir="ltr" className="text-xs tabular-nums">{row.day}</td>
                  <td className="tabular-nums text-xs">{row.count}</td>
                  <td className="text-xs"><Money value={row.salesMinor} /></td>
                  <td className="text-xs"><Money value={row.returnsMinor} tone="danger" /></td>
                  <td className="text-xs"><Money value={row.netMinor} /></td>
                  <td className="text-xs"><Money value={row.cogsMinor} /></td>
                  <td className="text-xs"><Money value={row.grossProfitMinor} tone="ok" /></td>
                </tr>
              ))}
              {!salesRows.length ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-sm text-ink-500">
                    لا توجد مبيعات في هذه الفترة
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {productRows ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>الصنف</th>
                <th>التصنيف</th>
                <th>الكمية</th>
                <th>الإيراد</th>
                <th>التكلفة</th>
                <th>الربح</th>
                <th>الفواتير</th>
              </tr>
            </thead>
            <tbody>
              {productRows.map((row) => (
                <tr key={row.productId}>
                  <td className="text-xs">
                    <p className="font-medium">{row.name}</p>
                    <p className="text-[10px] text-ink-400" dir="ltr">{row.sku ?? "-"}</p>
                  </td>
                  <td className="text-xs text-ink-500">{row.category ?? "-"}</td>
                  <td className="text-xs tabular-nums">{formatQty(row.qtyBaseMilli)}</td>
                  <td className="text-xs"><Money value={row.revenueMinor} /></td>
                  <td className="text-xs"><Money value={row.costMinor} /></td>
                  <td className="text-xs"><Money value={row.profitMinor} tone={row.profitMinor >= 0n ? "ok" : "danger"} /></td>
                  <td className="text-xs tabular-nums">{row.salesCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {pnlReport ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-ink-200 bg-white shadow-card">
            <h2 className="border-b border-ink-100 px-4 py-3 text-sm font-semibold">الإيرادات</h2>
            <table className="table">
              <tbody>
                {pnlReport.revenue.map((row) => (
                  <tr key={row.code}>
                    <td className="text-xs">{row.name}</td>
                    <td className="text-xs"><Money value={row.amountMinor} /></td>
                  </tr>
                ))}
                <tr className="bg-ink-50 font-semibold">
                  <td className="text-xs">إجمالي الإيرادات</td>
                  <td className="text-xs"><Money value={pnlReport.totalRevenueMinor} /></td>
                </tr>
              </tbody>
            </table>
          </section>
          <section className="rounded-2xl border border-ink-200 bg-white shadow-card">
            <h2 className="border-b border-ink-100 px-4 py-3 text-sm font-semibold">المصروفات والتكاليف</h2>
            <table className="table">
              <tbody>
                {pnlReport.expense.map((row) => (
                  <tr key={row.code}>
                    <td className="text-xs">{row.name}</td>
                    <td className="text-xs"><Money value={row.amountMinor} /></td>
                  </tr>
                ))}
                <tr className="bg-ink-50 font-semibold">
                  <td className="text-xs">إجمالي المصروفات</td>
                  <td className="text-xs"><Money value={pnlReport.totalExpenseMinor} tone="danger" /></td>
                </tr>
              </tbody>
            </table>
          </section>
          <div className="rounded-2xl border border-brand-200 bg-brand-50 p-5 lg:col-span-2">
            <p className="text-xs text-brand-700">صافي الربح</p>
            <p className="mt-1 text-2xl font-bold"><Money value={pnlReport.netProfitMinor} tone={pnlReport.netProfitMinor >= 0n ? "ok" : "danger"} /></p>
          </div>
        </div>
      ) : null}

      {valuation ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>الصنف</th>
                <th>الكمية</th>
                <th>متوسط التكلفة</th>
                <th>القيمة</th>
              </tr>
            </thead>
            <tbody>
              {valuation.items.map((row) => (
                <tr key={row.productId}>
                  <td className="text-xs">
                    <p className="font-medium">{row.name}</p>
                    <p className="text-[10px] text-ink-400" dir="ltr">{row.sku ?? "-"}</p>
                  </td>
                  <td className="text-xs tabular-nums">{formatQty(row.qtyMilli)}</td>
                  <td className="text-xs"><Money value={row.avgCostMinor} /></td>
                  <td className="text-xs"><Money value={row.valueMinor} /></td>
                </tr>
              ))}
              <tr className="bg-ink-50 font-semibold">
                <td className="text-xs" colSpan={3}>إجمالي قيمة المخزون</td>
                <td className="text-xs"><Money value={valuation.totalValueMinor} /></td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}

      {trial ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>الحساب</th>
                <th>مدين</th>
                <th>دائن</th>
              </tr>
            </thead>
            <tbody>
              {trial.items.map((row) => (
                <tr key={row.accountId}>
                  <td className="text-xs"><span dir="ltr" className="text-ink-400">{row.code}</span> {row.name}</td>
                  <td className="text-xs"><Money value={row.debitBalanceMinor} /></td>
                  <td className="text-xs"><Money value={row.creditBalanceMinor} /></td>
                </tr>
              ))}
              <tr className="bg-ink-50 font-semibold">
                <td className="text-xs">الإجمالي</td>
                <td className="text-xs"><Money value={trial.totalDebitMinor} /></td>
                <td className="text-xs"><Money value={trial.totalCreditMinor} /></td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}

      {sheet ? (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-2xl border border-ink-200 bg-white shadow-card">
              <h2 className="border-b border-ink-100 px-4 py-3 text-sm font-semibold">الأصول</h2>
              <table className="table">
                <tbody>
                  {sheet.assets.map((row) => (
                    <tr key={row.accountId}>
                      <td className="text-xs">{row.name}</td>
                      <td className="text-xs"><Money value={row.debitBalanceMinor - row.creditBalanceMinor} /></td>
                    </tr>
                  ))}
                  <tr className="bg-ink-50 font-semibold">
                    <td className="text-xs">إجمالي الأصول</td>
                    <td className="text-xs"><Money value={sheet.totalAssetsMinor} /></td>
                  </tr>
                </tbody>
              </table>
            </section>
            <section className="rounded-2xl border border-ink-200 bg-white shadow-card">
              <h2 className="border-b border-ink-100 px-4 py-3 text-sm font-semibold">الالتزامات وحقوق الملكية</h2>
              <table className="table">
                <tbody>
                  {sheet.liabilities.map((row) => (
                    <tr key={row.accountId}>
                      <td className="text-xs">{row.name}</td>
                      <td className="text-xs"><Money value={row.creditBalanceMinor - row.debitBalanceMinor} /></td>
                    </tr>
                  ))}
                  {sheet.equity.map((row) => (
                    <tr key={row.accountId}>
                      <td className="text-xs">{row.name}</td>
                      <td className="text-xs"><Money value={row.creditBalanceMinor - row.debitBalanceMinor} /></td>
                    </tr>
                  ))}
                  <tr>
                    <td className="text-xs">صافي ربح الفترة</td>
                    <td className="text-xs"><Money value={sheet.netProfitMinor} /></td>
                  </tr>
                  <tr className="bg-ink-50 font-semibold">
                    <td className="text-xs">الإجمالي</td>
                    <td className="text-xs"><Money value={sheet.totalLiabilitiesMinor + sheet.totalEquityMinor + sheet.netProfitMinor} /></td>
                  </tr>
                </tbody>
              </table>
            </section>
          </div>
          <p className="text-center text-xs text-ink-500">
            {sheet.balanced ? "الميزانية متوازنة" : "تنبيه: الميزانية غير متوازنة"}
          </p>
        </div>
      ) : null}

      {cash ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-ink-200 bg-white p-4">
              <p className="text-xs text-ink-500">المقبوضات</p>
              <p className="mt-1 text-lg font-bold"><Money value={cash.inflowMinor} tone="ok" /></p>
            </div>
            <div className="rounded-2xl border border-ink-200 bg-white p-4">
              <p className="text-xs text-ink-500">المدفوعات</p>
              <p className="mt-1 text-lg font-bold"><Money value={cash.outflowMinor} tone="danger" /></p>
            </div>
            <div className="rounded-2xl border border-ink-200 bg-white p-4">
              <p className="text-xs text-ink-500">الصافي</p>
              <p className="mt-1 text-lg font-bold"><Money value={cash.netMinor} tone={cash.netMinor >= 0n ? "ok" : "danger"} /></p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>المصدر</th>
                  <th>الاتجاه</th>
                  <th>الإجمالي</th>
                </tr>
              </thead>
              <tbody>
                {cash.rows.map((row) => (
                  <tr key={`${row.sourceType}-${row.direction}`}>
                    <td dir="ltr" className="text-xs">{row.sourceType}</td>
                    <td className="text-xs">{row.direction === "inflow" ? "قبض" : "صرف"}</td>
                    <td className="text-xs"><Money value={row.totalMinor} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {expenseRows ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>التصنيف</th>
                <th>عدد المصروفات</th>
                <th>الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              {expenseRows.map((row) => (
                <tr key={row.category}>
                  <td className="text-xs">{row.category}</td>
                  <td className="text-xs tabular-nums">{row.count}</td>
                  <td className="text-xs"><Money value={row.totalMinor} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {lowRows ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>الصنف</th>
                <th>المتوفر</th>
                <th>حد الطلب</th>
                <th>تاريخ الانتهاء</th>
              </tr>
            </thead>
            <tbody>
              {lowRows.map((row) => (
                <tr key={row.id}>
                  <td className="text-xs">
                    <p className="font-medium">{row.name}</p>
                    <p className="text-[10px] text-ink-400" dir="ltr">{row.sku ?? "-"}</p>
                  </td>
                  <td className="text-xs tabular-nums text-danger">{formatQty(row.qtyMilli)}</td>
                  <td className="text-xs tabular-nums">{formatQty(row.minStockMilli)}</td>
                  <td className="text-xs">
                    {row.expiryDate ? new Intl.DateTimeFormat("ar-YE").format(new Date(row.expiryDate)) : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {documentRows ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>المستند</th>
                <th>النوع</th>
                <th>الطرف</th>
                <th>المبلغ</th>
                <th>التاريخ</th>
              </tr>
            </thead>
            <tbody>
              {documentRows.map((row) => (
                <tr key={`${row.docType}-${row.id}`}>
                  <td className="text-xs font-medium" dir="ltr">{row.docNo}</td>
                  <td className="text-xs text-ink-500">{row.docType}</td>
                  <td className="text-xs">{row.party ?? "-"}</td>
                  <td className="text-xs"><Money value={row.totalMinor} /></td>
                  <td className="text-xs text-ink-400">
                    {new Intl.DateTimeFormat("ar-YE", { dateStyle: "short" }).format(row.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
