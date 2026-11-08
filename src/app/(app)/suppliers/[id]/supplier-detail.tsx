"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, FileDown, Wallet } from "lucide-react";
import { api, errorMessage } from "@/lib/client/api";
import { formatMoney, moneyToInput } from "@/lib/money";
import { Alert, Button } from "@/components/ui";
import { PaymentDialog } from "@/components/payment-dialog";

type Detail = {
  supplier: {
    id: string;
    name: string;
    phone: string | null;
    address: string | null;
  };
  balanceMinor: string;
  entries: Array<{
    id: string;
    entryType: string;
    amountMinor: string;
    note: string | null;
    createdAt: string;
    runningBalanceMinor: string;
  }>;
};

const ENTRY_LABELS: Record<string, string> = {
  purchase: "فاتورة مشتريات",
  purchase_return: "مرتجع مشتريات",
  payment: "سند صرف",
  opening: "رصيد افتتاحي",
  adjustment: "تسوية",
};

export function SupplierDetailClient({ id }: { id: string }) {
  const [data, setData] = useState<Detail | null>(null);
  const [cashboxes, setCashboxes] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [detail, lookups] = await Promise.all([
        api<Detail>(`/api/suppliers/${id}`),
        api<{ cashboxes: Array<{ id: string; name: string }> }>("/api/lookups"),
      ]);
      setData(detail);
      setCashboxes(lookups.cashboxes);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) {
    return error ? <Alert tone="danger">{error}</Alert> : <p className="py-10 text-center text-sm text-ink-500">جارٍ التحميل...</p>;
  }

  const balance = BigInt(data.balanceMinor);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href="/suppliers" className="mb-1 inline-flex items-center gap-1 text-xs text-ink-500 hover:text-brand-700">
            <ArrowRight className="h-3.5 w-3.5" /> الموردون
          </Link>
          <h1 className="text-xl font-bold">{data.supplier.name}</h1>
          <p className="text-xs text-ink-500" dir="ltr">
            {data.supplier.phone ?? "بدون هاتف"}
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href={`/api/pdf?type=supplier_statement&id=${id}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm"
          >
            <FileDown className="h-4 w-4" /> كشف PDF
          </a>
          <Button onClick={() => setPayOpen(true)}>
            <Wallet className="h-4 w-4" /> سند صرف
          </Button>
        </div>
      </div>

      <div className="rounded-2xl border border-ink-200 bg-white p-4 shadow-card">
        <p className="text-xs text-ink-500">المستحق للمورد</p>
        <p className="mt-1 text-xl font-bold tabular-nums" dir="ltr">
          {formatMoney(balance)} <span className="text-xs font-normal">ر.ي</span>
        </p>
      </div>

      <section className="rounded-2xl border border-ink-200 bg-white shadow-card">
        <div className="border-b border-ink-100 px-4 py-3">
          <h2 className="text-sm font-semibold">حركة الحساب</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>التاريخ</th>
                <th>البيان</th>
                <th>دائن</th>
                <th>مدين</th>
                <th>الرصيد</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry) => {
                const amount = BigInt(entry.amountMinor);
                return (
                  <tr key={entry.id}>
                    <td className="text-[11px] text-ink-400">
                      {new Intl.DateTimeFormat("ar-YE", { dateStyle: "short" }).format(
                        new Date(entry.createdAt),
                      )}
                    </td>
                    <td className="text-xs">
                      {entry.note ?? ENTRY_LABELS[entry.entryType] ?? entry.entryType}
                    </td>
                    <td dir="ltr" className="tabular-nums text-xs">
                      {amount > 0n ? formatMoney(amount) : "-"}
                    </td>
                    <td dir="ltr" className="tabular-nums text-xs">
                      {amount < 0n ? formatMoney(-amount) : "-"}
                    </td>
                    <td dir="ltr" className="tabular-nums text-xs font-medium">
                      {formatMoney(BigInt(entry.runningBalanceMinor))}
                    </td>
                  </tr>
                );
              })}
              {!data.entries.length ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-xs text-ink-500">
                    لا توجد حركات
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {payOpen ? (
        <PaymentDialog
          open={payOpen}
          onClose={() => setPayOpen(false)}
          direction="supplier_payment"
          partyId={id}
          partyName={data.supplier.name}
          cashboxes={cashboxes}
          defaultAmount={moneyToInput(balance > 0n ? balance : 0n)}
          onSaved={load}
        />
      ) : null}
    </div>
  );
}
