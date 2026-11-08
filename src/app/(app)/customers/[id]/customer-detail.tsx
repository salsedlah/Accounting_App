"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, FileDown, MessageCircle, Wallet } from "lucide-react";
import { api, errorMessage, postJson } from "@/lib/client/api";
import { formatMoney, moneyToInput } from "@/lib/money";
import { Alert, Badge, Button, Modal } from "@/components/ui";
import { PaymentDialog } from "@/components/payment-dialog";

type Detail = {
  customer: {
    id: string;
    name: string;
    phone: string | null;
    address: string | null;
    creditLimitMinor: string;
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
  invoices: Array<{
    id: string;
    invoiceNo: string;
    kind: string;
    totalMinor: string;
    paidMinor: string;
    dueMinor: string;
    createdAt: string;
  }>;
  payments: Array<{
    id: string;
    paymentNo: string;
    amountMinor: string;
    method: string;
    occurredAt: string;
  }>;
};

const ENTRY_LABELS: Record<string, string> = {
  sale: "فاتورة مبيعات",
  sale_return: "مرتجع مبيعات",
  payment: "سند قبض",
  receipt: "سند قبض",
  opening: "رصيد افتتاحي",
  adjustment: "تسوية",
};

export function CustomerDetailClient({ id }: { id: string }) {
  const [data, setData] = useState<Detail | null>(null);
  const [cashboxes, setCashboxes] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [payOpen, setPayOpen] = useState(false);
  const [reminder, setReminder] = useState<{ eventId: string; message: string; link: string | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [detail, lookups] = await Promise.all([
        api<Detail>(`/api/customers/${id}`),
        api<{ cashboxes: Array<{ id: string; name: string }> }>("/api/lookups"),
      ]);
      setData(detail);
      setCashboxes(lookups.cashboxes);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remind() {
    try {
      const result = await postJson<{ eventId: string; message: string; link: string | null }>(
        `/api/customers/${id}/reminder`,
        { action: "prepare", channel: "whatsapp" },
      );
      setReminder(result);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (loading) return <p className="py-10 text-center text-sm text-ink-500">جارٍ التحميل...</p>;
  if (!data) return <Alert tone="danger">{error ?? "تعذر تحميل كشف الحساب"}</Alert>;

  const balance = BigInt(data.balanceMinor);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href="/customers" className="mb-1 inline-flex items-center gap-1 text-xs text-ink-500 hover:text-brand-700">
            <ArrowRight className="h-3.5 w-3.5" /> العملاء
          </Link>
          <h1 className="text-xl font-bold">{data.customer.name}</h1>
          <p className="text-xs text-ink-500" dir="ltr">
            {data.customer.phone ?? "بدون هاتف"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={`/api/pdf?type=customer_statement&id=${id}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm"
          >
            <FileDown className="h-4 w-4" /> كشف PDF
          </a>
          <Button variant="secondary" onClick={remind}>
            <MessageCircle className="h-4 w-4" /> تذكير
          </Button>
          <Button onClick={() => setPayOpen(true)}>
            <Wallet className="h-4 w-4" /> سند قبض
          </Button>
        </div>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-ink-200 bg-white p-4 shadow-card">
          <p className="text-xs text-ink-500">الرصيد الحالي</p>
          <p className="mt-1 text-xl font-bold tabular-nums" dir="ltr">
            {formatMoney(balance)} <span className="text-xs font-normal">ر.ي</span>
          </p>
        </div>
        <div className="rounded-2xl border border-ink-200 bg-white p-4 shadow-card">
          <p className="text-xs text-ink-500">حد الائتمان</p>
          <p className="mt-1 text-xl font-bold tabular-nums" dir="ltr">
            {BigInt(data.customer.creditLimitMinor) > 0n
              ? formatMoney(BigInt(data.customer.creditLimitMinor))
              : "غير محدد"}
          </p>
        </div>
        <div className="rounded-2xl border border-ink-200 bg-white p-4 shadow-card">
          <p className="text-xs text-ink-500">عدد الفواتير</p>
          <p className="mt-1 text-xl font-bold">{data.invoices.length}</p>
        </div>
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
                <th>مدين</th>
                <th>دائن</th>
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
                    لا توجد حركات على الحساب
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-ink-200 bg-white shadow-card">
          <div className="border-b border-ink-100 px-4 py-3">
            <h2 className="text-sm font-semibold">الفواتير</h2>
          </div>
          <ul className="divide-y divide-ink-100">
            {data.invoices.map((invoice) => (
              <li key={invoice.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                <Link href={`/invoices/${invoice.id}`} className="text-xs font-medium hover:text-brand-700">
                  {invoice.invoiceNo}
                  {invoice.kind === "return" ? <Badge tone="warning">مرتجع</Badge> : null}
                </Link>
                <div className="text-left text-[11px] text-ink-500" dir="ltr">
                  {formatMoney(BigInt(invoice.totalMinor))}
                  {BigInt(invoice.dueMinor) > 0n ? (
                    <span className="mr-1 text-warn">/ {formatMoney(BigInt(invoice.dueMinor))}</span>
                  ) : null}
                </div>
              </li>
            ))}
            {!data.invoices.length ? (
              <li className="px-4 py-6 text-center text-xs text-ink-500">لا توجد فواتير</li>
            ) : null}
          </ul>
        </section>
        <section className="rounded-2xl border border-ink-200 bg-white shadow-card">
          <div className="border-b border-ink-100 px-4 py-3">
            <h2 className="text-sm font-semibold">سندات القبض</h2>
          </div>
          <ul className="divide-y divide-ink-100">
            {data.payments.map((payment) => (
              <li key={payment.id} className="flex items-center justify-between px-4 py-2.5">
                <span className="text-xs">{payment.paymentNo}</span>
                <span className="text-xs tabular-nums" dir="ltr">
                  {formatMoney(BigInt(payment.amountMinor))}
                </span>
              </li>
            ))}
            {!data.payments.length ? (
              <li className="px-4 py-6 text-center text-xs text-ink-500">لا توجد سندات</li>
            ) : null}
          </ul>
        </section>
      </div>

      {payOpen ? (
        <PaymentDialog
          open={payOpen}
          onClose={() => setPayOpen(false)}
          direction="customer_receipt"
          partyId={id}
          partyName={data.customer.name}
          cashboxes={cashboxes}
          defaultAmount={moneyToInput(balance > 0n ? balance : 0n)}
          onSaved={load}
        />
      ) : null}

      <Modal
        open={Boolean(reminder)}
        onClose={() => setReminder(null)}
        title="تذكير بالمديونية"
        footer={
          <>
            <Button variant="secondary" onClick={() => setReminder(null)}>
              إغلاق
            </Button>
            {reminder?.link ? (
              <a
                href={reminder.link}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg bg-brand-600 px-3 py-2 text-sm text-white"
              >
                إرسال عبر واتساب
              </a>
            ) : null}
          </>
        }
      >
        {reminder ? (
          <pre className="whitespace-pre-wrap rounded-lg bg-ink-50 p-3 text-sm leading-6">
            {reminder.message}
          </pre>
        ) : null}
      </Modal>
    </div>
  );
}
