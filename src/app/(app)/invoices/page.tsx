import Link from "next/link";
import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { formatMoney } from "@/lib/money";
import { listDocuments } from "@/server/services/reports";

export const metadata = { title: "الفواتير والمستندات" };
export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "all", label: "الكل" },
  { key: "sale", label: "مبيعات" },
  { key: "sale_return", label: "مرتجعات بيع" },
  { key: "purchase", label: "مشتريات" },
  { key: "purchase_return", label: "مرتجعات شراء" },
  { key: "receipt", label: "سندات قبض" },
  { key: "supplier_payment", label: "سندات صرف" },
  { key: "expense", label: "مصروفات" },
];

const TYPE_LABEL: Record<string, string> = {
  sale: "فاتورة بيع",
  sale_return: "مرتجع بيع",
  purchase: "فاتورة شراء",
  purchase_return: "مرتجع شراء",
  receipt: "سند قبض",
  supplier_payment: "سند صرف",
  expense: "مصروف",
};

const TYPE_TONE: Record<string, string> = {
  sale: "bg-brand-50 text-brand-700",
  sale_return: "bg-danger/10 text-danger",
  purchase: "bg-warning/10 text-warning",
  purchase_return: "bg-danger/10 text-danger",
  receipt: "bg-ok/10 text-ok",
  supplier_payment: "bg-warning/10 text-warning",
  expense: "bg-ink-100 text-ink-600",
};

function pdfType(docType: string): string {
  if (docType === "sale" || docType === "sale_return") return "sale";
  if (docType === "purchase" || docType === "purchase_return") return "purchase";
  if (docType === "receipt" || docType === "supplier_payment") return "payment";
  return "expense";
}

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  await ensureReady();
  const session = await requirePermission(PERMISSIONS.salesRead);
  const params = await searchParams;
  const type = FILTERS.some((f) => f.key === params.type) ? params.type! : "all";

  const rows = await transaction((tx) => listDocuments(tx, session.businessId, 300));
  const filtered = type === "all" ? rows : rows.filter((row) => row.docType === type);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">الفواتير والمستندات</h1>
        <p className="mt-1 text-xs text-ink-500">سجل موحد لكل الحركات المالية</p>
      </div>

      <nav className="flex flex-wrap gap-1 rounded-xl border border-ink-200 bg-white p-1 shadow-card">
        {FILTERS.map((filter) => (
          <Link
            key={filter.key}
            href={filter.key === "all" ? "/invoices" : `/invoices?type=${filter.key}`}
            className={`rounded-lg px-3 py-1.5 text-xs transition ${
              filter.key === type ? "bg-brand-600 text-white" : "text-ink-600 hover:bg-ink-100"
            }`}
          >
            {filter.label}
          </Link>
        ))}
      </nav>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>المستند</th>
              <th>النوع</th>
              <th>الطرف / البيان</th>
              <th>المبلغ</th>
              <th>التاريخ</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={`${row.docType}-${row.id}`}>
                <td className="text-xs font-medium" dir="ltr">
                  {row.docType === "sale" || row.docType === "sale_return" ? (
                    <Link href={`/invoices/${row.id}`} className="hover:text-brand-700">
                      {row.docNo}
                    </Link>
                  ) : (
                    row.docNo
                  )}
                </td>
                <td>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${TYPE_TONE[row.docType] ?? "bg-ink-100"}`}>
                    {TYPE_LABEL[row.docType] ?? row.docType}
                  </span>
                </td>
                <td className="max-w-[240px] truncate text-xs">{row.party ?? "-"}</td>
                <td dir="ltr" className="text-xs tabular-nums">{formatMoney(row.totalMinor)}</td>
                <td className="text-[11px] text-ink-400">
                  {new Intl.DateTimeFormat("ar-YE", { dateStyle: "short", timeStyle: "short" }).format(
                    row.createdAt,
                  )}
                </td>
                <td className="whitespace-nowrap">
                  <a
                    href={`/api/pdf?type=${pdfType(row.docType)}&id=${row.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-brand-700 hover:underline"
                  >
                    PDF
                  </a>
                </td>
              </tr>
            ))}
            {!filtered.length ? (
              <tr>
                <td colSpan={6} className="py-10 text-center text-sm text-ink-500">
                  لا توجد مستندات
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
