import Link from "next/link";
import { notFound } from "next/navigation";
import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { formatMoney } from "@/lib/money";
import { formatQty, qtyToInput } from "@/lib/quantity";
import { getSaleDetail } from "@/server/services/sales";
import { PrintButton } from "@/components/print-button";

export const dynamic = "force-dynamic";

const PAYMENT_LABEL: Record<string, string> = {
  cash: "نقداً",
  credit: "آجل",
  mixed: "مختلط",
};

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await ensureReady();
  const session = await requirePermission(PERMISSIONS.salesRead);
  const { id } = await params;

  let data: Awaited<ReturnType<typeof getSaleDetail>> | null = null;
  try {
    data = await transaction((tx) => getSaleDetail(tx, session.businessId, id));
  } catch {
    data = null;
  }
  if (!data) notFound();

  const sale = data;
  const isReturn = sale.kind === "return";

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <div>
          <h1 className="text-xl font-bold">
            {isReturn ? "مرتجع بيع" : "فاتورة بيع"} <span dir="ltr">{sale.invoiceNo}</span>
          </h1>
          <p className="mt-1 text-xs text-ink-500">
            {new Intl.DateTimeFormat("ar-YE", { dateStyle: "full", timeStyle: "short" }).format(
              sale.occurredAt,
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/invoices"
            className="rounded-lg border border-ink-200 bg-white px-3 py-2 text-xs text-ink-700 hover:bg-ink-50"
          >
            رجوع
          </Link>
          <PrintButton />
          <a
            href={`/api/pdf?type=sale&id=${sale.id}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg bg-brand-600 px-3 py-2 text-xs text-white hover:bg-brand-700"
          >
            PDF
          </a>
        </div>
      </div>

      <section className="rounded-2xl border border-ink-200 bg-white p-6 shadow-card print:border-0 print:shadow-none">
        <div className="flex items-start justify-between gap-4 border-b border-ink-100 pb-4">
          <div>
            <h2 className="text-lg font-bold text-brand-700">مؤسسة النور للتجارة</h2>
            <p className="mt-1 text-xs text-ink-500">نظام حساب — فاتورة ضريبية مبسطة</p>
          </div>
          <div className="text-left text-xs">
            <p className="font-semibold">{sale.invoiceNo}</p>
            <p className="text-ink-500">
              {new Intl.DateTimeFormat("ar-YE", { dateStyle: "short" }).format(sale.occurredAt)}
            </p>
            <p className="text-ink-500">{PAYMENT_LABEL[sale.paymentType] ?? sale.paymentType}</p>
          </div>
        </div>

        <div className="grid gap-4 py-4 sm:grid-cols-2">
          <div className="rounded-lg bg-ink-50 p-3 text-xs">
            <p className="text-ink-500">العميل</p>
            <p className="mt-1 font-semibold">{sale.customer?.name ?? "عميل نقدي"}</p>
            {sale.customer?.phone ? (
              <p dir="ltr" className="mt-0.5 text-ink-500">{sale.customer.phone}</p>
            ) : null}
            {sale.customer?.address ? (
              <p className="mt-0.5 text-ink-500">{sale.customer.address}</p>
            ) : null}
          </div>
          <div className="rounded-lg bg-ink-50 p-3 text-xs">
            <p className="text-ink-500">الحالة</p>
            <p className="mt-1 font-semibold">{sale.status === "posted" ? "مُرحّلة" : sale.status}</p>
            {sale.notes ? <p className="mt-1 text-ink-500">{sale.notes}</p> : null}
          </div>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>الصنف</th>
              <th>الوحدة</th>
              <th>الكمية</th>
              <th>السعر</th>
              <th>الخصم</th>
              <th>الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {sale.items.map((item, index) => (
              <tr key={item.id}>
                <td className="text-xs tabular-nums">{index + 1}</td>
                <td className="text-xs">
                  <p className="font-medium">{item.productName}</p>
                  <p className="text-[10px] text-ink-400" dir="ltr">
                    {item.sku ?? "-"} · {formatQty(item.qtyBaseMilli)} وحدة أساس
                  </p>
                </td>
                <td className="text-xs">{item.unitName}</td>
                <td className="text-xs tabular-nums">{qtyToInput(item.qtyMilli)}</td>
                <td className="text-xs tabular-nums" dir="ltr">{formatMoney(item.unitPriceMinor)}</td>
                <td className="text-xs tabular-nums" dir="ltr">{formatMoney(item.discountMinor)}</td>
                <td className="text-xs tabular-nums" dir="ltr">{formatMoney(item.lineTotalMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-4 ms-auto w-full max-w-xs space-y-1 text-xs">
          <div className="flex justify-between"><span className="text-ink-500">الإجمالي الفرعي</span><span dir="ltr" className="tabular-nums">{formatMoney(sale.subtotalMinor)}</span></div>
          {sale.discountMinor > 0n ? (
            <div className="flex justify-between"><span className="text-ink-500">الخصم</span><span dir="ltr" className="tabular-nums text-danger">-{formatMoney(sale.discountMinor)}</span></div>
          ) : null}
          {sale.taxMinor > 0n ? (
            <div className="flex justify-between"><span className="text-ink-500">الضريبة</span><span dir="ltr" className="tabular-nums">{formatMoney(sale.taxMinor)}</span></div>
          ) : null}
          <div className="flex justify-between border-t border-ink-200 pt-1 text-sm font-bold"><span>الإجمالي</span><span dir="ltr" className="tabular-nums">{formatMoney(sale.totalMinor)}</span></div>
          <div className="flex justify-between"><span className="text-ink-500">المدفوع</span><span dir="ltr" className="tabular-nums text-ok">{formatMoney(sale.paidMinor)}</span></div>
          <div className="flex justify-between"><span className="text-ink-500">المتبقي</span><span dir="ltr" className="tabular-nums text-danger">{formatMoney(sale.dueMinor)}</span></div>
        </div>

        <p className="mt-8 border-t border-ink-100 pt-3 text-center text-[10px] text-ink-400">
          شكراً لتعاملكم معنا · أُصدرت هذه الفاتورة إلكترونياً
        </p>
      </section>
    </div>
  );
}
