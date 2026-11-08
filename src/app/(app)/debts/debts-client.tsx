"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { MessageCircle, Wallet, Plus, History } from "lucide-react";
import { api, errorMessage, postJson } from "@/lib/client/api";
import { formatMoney, moneyToInput } from "@/lib/money";
import { Alert, Badge, Button, Modal } from "@/components/ui";
import { PaymentDialog } from "@/components/payment-dialog";

type Party = {
  id: string;
  name: string;
  phone?: string | null;
  balanceMinor: string;
  creditLimitMinor?: string;
  overLimit?: boolean;
};

type Debts = {
  customers: Party[];
  suppliers: Party[];
  totalReceivableMinor: string;
  totalPayableMinor: string;
};
type Entry = { id: string; entryType: string; amountMinor: string; note: string | null; createdAt: string; runningBalanceMinor: string };
type CustomerStatement = { entries: Entry[] };

export function DebtsClient({ mode }: { mode: "customers" | "suppliers" }) {
  const [data, setData] = useState<Debts | null>(null);
  const [cashboxes, setCashboxes] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [payFor, setPayFor] = useState<Party | null>(null);
  const [reminder, setReminder] = useState<{ eventId: string; message: string; link: string | null } | null>(null);
  const [addDebt, setAddDebt] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState("");
  const [debtAmount, setDebtAmount] = useState("");
  const [debtNote, setDebtNote] = useState("");
  const [history, setHistory] = useState<Record<string, Entry[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [savingDebt, setSavingDebt] = useState(false);

  const load = useCallback(async () => {
    try {
      const [debts, lookups] = await Promise.all([
        api<Debts>("/api/debts"),
        api<{ cashboxes: Array<{ id: string; name: string }> }>("/api/lookups"),
      ]);
      setData(debts);
      setCashboxes(lookups.cashboxes);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const parties = useMemo(
    () =>
      (mode === "customers" ? data?.customers : data?.suppliers) ??
      [],
    [data, mode],
  );

  const total = BigInt(
    (mode === "customers" ? data?.totalReceivableMinor : data?.totalPayableMinor) ?? "0",
  );

  async function remind(party: Party) {
    try {
      const result = await postJson<{ eventId: string; message: string; link: string | null }>(
        `/api/customers/${party.id}/reminder`,
        { action: "prepare", channel: "whatsapp" },
      );
      setReminder(result);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function toggleHistory(party: Party) {
    if (expanded === party.id) { setExpanded(null); return; }
    setExpanded(party.id);
    if (history[party.id]) return;
    try {
      const statement = await api<CustomerStatement>(`/api/debts/${party.id}`);
      setHistory((current) => ({ ...current, [party.id]: statement.entries }));
    } catch (err) {
      setError(errorMessage(err));
      setExpanded((current) => (current === party.id ? null : current));
    }
  }

  async function saveDebt() {
    if (!selectedCustomer || !debtAmount) return;
    setSavingDebt(true);
    setError(null);
    try {
      await postJson("/api/debts", { customerId: selectedCustomer, amount: debtAmount, note: debtNote });
      setAddDebt(false); setDebtAmount(""); setDebtNote("");
      setMessage("تمت إضافة الدين"); await load();
      setHistory((current) => { const next = { ...current }; delete next[selectedCustomer]; return next; });
      setExpanded(selectedCustomer);
      const statement = await api<CustomerStatement>(`/api/debts/${selectedCustomer}`);
      setHistory((current) => ({ ...current, [selectedCustomer]: statement.entries }));
    } catch (err) {
      setError(errorMessage(err));
      setExpanded(null);
    }
    finally { setSavingDebt(false); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">
          {mode === "customers" ? "ديون العملاء" : "ديون الموردين"}
        </h1>
        <p className="mt-1 text-sm text-ink-500">
          {mode === "customers" ? "المبالغ المستحقة لك على العملاء" : "المبالغ المستحقة عليك للموردين"}
        </p>
        {mode === "customers" ? <Button className="mt-3" onClick={() => setAddDebt(true)}><Plus className="h-4 w-4"/> إضافة دين</Button> : null}
      </div>

      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-card">
        <p className="text-xs text-ink-500">
          {mode === "customers" ? "إجمالي المستحق" : "إجمالي المطلوب دفعه"}
        </p>
        <p className="mt-1 text-2xl font-bold tabular-nums" dir="ltr">
          {formatMoney(total)} <span className="text-sm font-normal">ر.ي</span>
        </p>
        <p className="mt-1 text-xs text-ink-500">{parties.length} حساب</p>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{mode === "customers" ? "العميل" : "المورد"}</th>
              <th>الهاتف</th>
              <th>الرصيد</th>
              {mode === "customers" ? <th>حد الائتمان</th> : null}
              <th />
            </tr>
          </thead>
          <tbody>
            {parties.map((party) => {
              const entries = history[party.id] ?? [];
              const totalDebt = entries.reduce((sum, entry) => {
                const amount = BigInt(entry.amountMinor);
                return amount > 0n ? sum + amount : sum;
              }, 0n);
              const totalPaid = entries.reduce((sum, entry) => {
                const amount = BigInt(entry.amountMinor);
                return entry.entryType === "payment" && amount < 0n ? sum - amount : sum;
              }, 0n);

              return (
                <Fragment key={party.id}>
                  <tr>
                    <td>
                      <Link
                        href={`/${mode === "customers" ? "customers" : "suppliers"}/${party.id}`}
                        className="font-medium hover:text-brand-700"
                      >
                        {party.name}
                      </Link>
                      {party.overLimit ? <Badge tone="danger">تجاوز الحد</Badge> : null}
                    </td>
                    <td dir="ltr" className="text-xs text-ink-500">
                      {party.phone ?? "-"}
                    </td>
                    <td dir="ltr" className="tabular-nums font-medium">
                      {formatMoney(BigInt(party.balanceMinor))}
                    </td>
                    {mode === "customers" ? (
                      <td dir="ltr" className="text-xs tabular-nums text-ink-500">
                        {party.creditLimitMinor && BigInt(party.creditLimitMinor) > 0n
                          ? formatMoney(BigInt(party.creditLimitMinor))
                          : "-"}
                      </td>
                    ) : null}
                    <td>
                      <div className="flex flex-wrap items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setPayFor(party)}
                          disabled={BigInt(party.balanceMinor) <= 0n}
                          className="inline-flex items-center gap-1 rounded-lg bg-brand-50 px-2 py-1 text-[11px] text-brand-700 hover:bg-brand-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Wallet className="h-3 w-3" />
                          {mode === "customers" ? "تحصيل" : "سداد"}
                        </button>
                        {mode === "customers" ? (
                          <>
                            <button
                              type="button"
                              onClick={() => remind(party)}
                              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-ink-600 hover:bg-ink-100"
                            >
                              <MessageCircle className="h-3 w-3" /> تذكير
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleHistory(party)}
                              aria-expanded={expanded === party.id}
                              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-brand-700 hover:bg-brand-50"
                            >
                              <History className="h-3 w-3" />
                              {expanded === party.id ? "إخفاء الكشف" : "كشف الديون والسداد"}
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  {mode === "customers" && expanded === party.id ? (
                    <tr>
                      <td colSpan={5} className="bg-ink-50/70 p-3">
                        {history[party.id] ? (
                          <>
                            <div className="mb-3 grid gap-2 sm:grid-cols-3">
                              <div className="rounded-lg bg-white p-3">
                                <p className="text-xs text-ink-500">إجمالي الديون المسجلة</p>
                                <p className="mt-1 font-semibold tabular-nums" dir="ltr">
                                  {formatMoney(totalDebt)} ر.ي
                                </p>
                              </div>
                              <div className="rounded-lg bg-white p-3">
                                <p className="text-xs text-ink-500">إجمالي ما تم سداده</p>
                                <p className="mt-1 font-semibold tabular-nums text-ok" dir="ltr">
                                  {formatMoney(totalPaid)} ر.ي
                                </p>
                              </div>
                              <div className="rounded-lg bg-white p-3">
                                <p className="text-xs text-ink-500">المتبقي على العميل</p>
                                <p className="mt-1 font-semibold tabular-nums text-warn" dir="ltr">
                                  {formatMoney(BigInt(party.balanceMinor))} ر.ي
                                </p>
                              </div>
                            </div>
                            <div className="overflow-x-auto rounded-lg bg-white">
                              <table className="table">
                                <thead>
                                  <tr>
                                    <th>التاريخ</th>
                                    <th>النوع</th>
                                    <th>التفاصيل</th>
                                    <th>المبلغ</th>
                                    <th>الرصيد بعد الحركة</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {entries.map((entry) => {
                                    const amount = BigInt(entry.amountMinor);
                                    const isPayment = entry.entryType === "payment";
                                    return (
                                      <tr key={entry.id}>
                                        <td className="text-xs">
                                          {new Intl.DateTimeFormat("ar-YE", { dateStyle: "short" }).format(
                                            new Date(entry.createdAt),
                                          )}
                                        </td>
                                        <td>
                                          <Badge
                                            tone={
                                              isPayment
                                                ? "success"
                                                : amount < 0n
                                                  ? "neutral"
                                                  : "warning"
                                            }
                                          >
                                            {isPayment ? "سداد" : amount < 0n ? "تخفيض دين" : "دين"}
                                          </Badge>
                                        </td>
                                        <td className="text-xs">
                                          {entry.note || (entry.entryType === "sale" ? "فاتورة مبيعات" : "—")}
                                        </td>
                                        <td dir="ltr" className="tabular-nums text-xs">
                                          {formatMoney(amount < 0n ? -amount : amount)}
                                        </td>
                                        <td dir="ltr" className="tabular-nums text-xs">
                                          {formatMoney(BigInt(entry.runningBalanceMinor))}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                  {!entries.length ? (
                                    <tr>
                                      <td colSpan={5} className="py-6 text-center text-sm text-ink-500">
                                        لا توجد حركات مسجلة لهذا العميل
                                      </td>
                                    </tr>
                                  ) : null}
                                </tbody>
                              </table>
                            </div>
                          </>
                        ) : (
                          <p className="py-3 text-center text-sm text-ink-500">
                            جارٍ تحميل كشف الحساب...
                          </p>
                        )}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
            {!parties.length ? (
              <tr>
                <td colSpan={mode === "customers" ? 5 : 4} className="py-10 text-center text-sm text-ink-500">
                  لا توجد مديونيات حالياً
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <Modal
        open={addDebt}
        onClose={() => setAddDebt(false)}
        title="إضافة دين على عميل"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddDebt(false)}>إلغاء</Button>
            <Button form="add-debt-form" type="submit" loading={savingDebt}>حفظ الدين</Button>
          </>
        }
      >
        <form
          id="add-debt-form"
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void saveDebt();
          }}
        >
          <label className="block">
            <span className="label">العميل</span>
            <select className="input" value={selectedCustomer} onChange={(e) => setSelectedCustomer(e.target.value)} required>
              <option value="">اختر العميل</option>
              {(data?.customers ?? []).map((customer) => (
                <option key={customer.id} value={customer.id}>{customer.name}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">مبلغ الدين</span>
            <input className="input" inputMode="decimal" value={debtAmount} onChange={(e) => setDebtAmount(e.target.value)} placeholder="0.00" required />
          </label>
          <label className="block">
            <span className="label">البيان</span>
            <input className="input" value={debtNote} onChange={(e) => setDebtNote(e.target.value)} placeholder="سبب أو تفاصيل الدين" />
          </label>
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </form>
      </Modal>

      {payFor ? (
        <PaymentDialog
          key={payFor.id}
          open={Boolean(payFor)}
          onClose={() => setPayFor(null)}
          direction={mode === "customers" ? "customer_receipt" : "supplier_payment"}
          partyId={payFor.id}
          partyName={payFor.name}
          cashboxes={cashboxes}
          defaultAmount={moneyToInput(BigInt(payFor.balanceMinor))}
          onSaved={async () => {
            setMessage("تم تسجيل السند");
            await load();
            if (mode === "customers") {
              setHistory((current) => {
                const next = { ...current };
                delete next[payFor.id];
                return next;
              });
              try {
                const statement = await api<CustomerStatement>(`/api/debts/${payFor.id}`);
                setHistory((current) => ({ ...current, [payFor.id]: statement.entries }));
              } catch (err) {
                setError(errorMessage(err));
                setExpanded((current) => (current === payFor.id ? null : current));
              }
            }
          }}
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
