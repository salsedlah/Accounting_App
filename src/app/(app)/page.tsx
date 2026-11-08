import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Boxes,
  HandCoins,
  ShoppingBag,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { formatMoney } from "@/lib/money";
import { formatQty } from "@/lib/quantity";
import { requireSession } from "@/server/auth";
import { getDashboard } from "@/server/services/reports";

export const metadata = { title: "لوحة التحكم" };
export const dynamic = "force-dynamic";

function money(value: bigint) {
  return formatMoney(value, 2);
}

export default async function DashboardPage() {
  await ensureReady();
  const session = await requireSession();
  const data = await transaction((tx) => getDashboard(tx, session.businessId));

  const stats = [
    {
      label: "مبيعات اليوم",
      value: `${money(data.todaySales.netSalesMinor)} ر.ي`,
      hint: `${data.todaySales.invoiceCount} فاتورة`,
      icon: TrendingUp,
      tone: "bg-brand-50 text-brand-700",
      href: "/invoices",
    },
    {
      label: "ربح الشهر",
      value: `${money(data.monthPnl.netProfitMinor)} ر.ي`,
      hint: `إيرادات ${money(data.monthPnl.totalRevenueMinor)}`,
      icon: ShoppingBag,
      tone: "bg-green-50 text-ok",
      href: "/reports",
    },
    {
      label: "مستحق على العملاء",
      value: `${money(data.receivableMinor)} ر.ي`,
      hint: `${data.overLimitCustomers.length} عميل تجاوز الحد`,
      icon: HandCoins,
      tone: "bg-amber-50 text-warn",
      href: "/debts",
    },
    {
      label: "النقد في الصناديق",
      value: `${money(data.cashMinor)} ر.ي`,
      hint: `${data.cashboxes.length} صندوق`,
      icon: Wallet,
      tone: "bg-blue-50 text-blue-700",
      href: "/cashbox",
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">أهلاً، {session.name.split(" ")[0]} 👋</h1>
          <p className="mt-1 text-sm text-ink-500">
            إليك ملخص أعمالك اليوم في {session.businessName}
          </p>
        </div>
        <Link
          href="/pos"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          فتح نقطة البيع <ArrowLeft className="h-4 w-4" />
        </Link>
      </div>

      {data.overLimitCustomers.length > 0 ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-warn">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">تنبيه حد الائتمان</p>
            <p className="text-xs">
              {data.overLimitCustomers.map((c) => c.name).slice(0, 4).join("، ")}
              {data.overLimitCustomers.length > 4 ? " وآخرون" : ""} تجاوزوا حد الائتمان
              المسموح.
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <Link
              key={stat.label}
              href={stat.href}
              className="rounded-2xl border border-ink-200 bg-white p-4 shadow-card transition hover:border-brand-300"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-500">{stat.label}</span>
                <span className={`grid h-8 w-8 place-items-center rounded-lg ${stat.tone}`}>
                  <Icon className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-2 text-lg font-bold tabular-nums" dir="ltr">
                {stat.value}
              </p>
              <p className="mt-0.5 text-[11px] text-ink-500">{stat.hint}</p>
            </Link>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="min-w-0 rounded-2xl border border-ink-200 bg-white shadow-card lg:col-span-2">
          <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">أحدث الفواتير</h2>
              <p className="text-xs text-ink-500">آخر 6 عمليات بيع</p>
            </div>
            <Link href="/invoices" className="text-xs text-brand-700 hover:underline">
              عرض الكل
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>الفاتورة</th>
                  <th>العميل</th>
                  <th>الإجمالي</th>
                  <th>المتبقي</th>
                  <th>التاريخ</th>
                </tr>
              </thead>
              <tbody>
                {data.recentSales.map((sale) => (
                  <tr key={sale.id}>
                    <td className="font-medium">
                      <Link href={`/invoices/${sale.id}`} className="hover:text-brand-700">
                        {sale.invoiceNo}
                      </Link>
                    </td>
                    <td>{sale.customerName ?? "عميل نقدي"}</td>
                    <td className="tabular-nums" dir="ltr">
                      {money(sale.totalMinor)}
                    </td>
                    <td className="tabular-nums" dir="ltr">
                      {money(sale.dueMinor)}
                    </td>
                    <td className="text-xs text-ink-500">
                      {new Intl.DateTimeFormat("ar-YE", {
                        dateStyle: "short",
                        timeStyle: "short",
                      }).format(sale.createdAt)}
                    </td>
                  </tr>
                ))}
                {!data.recentSales.length ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-sm text-ink-500">
                      لا توجد فواتير بعد. ابدأ من نقطة البيع.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <div className="min-w-0 space-y-4">
          <section className="rounded-2xl border border-ink-200 bg-white shadow-card">
            <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
              <h2 className="text-sm font-semibold">نواقص المخزون</h2>
              <Link href="/inventory" className="text-xs text-brand-700 hover:underline">
                المخزون
              </Link>
            </div>
            <ul className="divide-y divide-ink-100">
              {data.lowStock.map((item) => (
                <li key={item.id} className="flex items-center justify-between px-4 py-2.5">
                  <span className="truncate text-sm">{item.name}</span>
                  <span className="shrink-0 text-xs text-warn" dir="ltr">
                    {formatQty(item.qtyMilli)} / {formatQty(item.minStockMilli)}
                  </span>
                </li>
              ))}
              {!data.lowStock.length ? (
                <li className="px-4 py-6 text-center text-xs text-ink-500">
                  كل المنتجات فوق الحد الأدنى
                </li>
              ) : null}
            </ul>
          </section>

          <section className="rounded-2xl border border-ink-200 bg-white p-4 shadow-card">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Boxes className="h-4 w-4 text-brand-600" /> قيمة المخزون
            </div>
            <p className="mt-2 text-lg font-bold" dir="ltr">
              {money(data.inventoryValueMinor)} ر.ي
            </p>
            <p className="mt-1 text-xs text-ink-500">
              المستحق للموردين: {money(data.payableMinor)} ر.ي
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Link
                href="/purchases"
                className="rounded-lg bg-ink-50 px-3 py-2 text-center text-xs hover:bg-ink-100"
              >
                شراء جديد
              </Link>
              <Link
                href="/reports"
                className="rounded-lg bg-ink-50 px-3 py-2 text-center text-xs hover:bg-ink-100"
              >
                التقارير
              </Link>
            </div>
          </section>
        </div>
      </div>

      {data.topProducts.length ? (
        <section className="rounded-2xl border border-ink-200 bg-white shadow-card">
          <div className="border-b border-ink-100 px-4 py-3">
            <h2 className="text-sm font-semibold">الأكثر مبيعاً هذا الشهر</h2>
          </div>
          <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
            {data.topProducts.map((p, index) => (
              <div key={p.productId} className="rounded-xl bg-ink-50 p-3">
                <p className="text-[11px] text-ink-500">#{index + 1}</p>
                <p className="mt-0.5 truncate text-sm font-medium">{p.name}</p>
                <p className="mt-1 text-xs text-brand-700" dir="ltr">
                  {money(p.revenueMinor)} ر.ي
                </p>
                <p className="text-[11px] text-ink-500">{formatQty(p.qtyBaseMilli)} وحدة</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
