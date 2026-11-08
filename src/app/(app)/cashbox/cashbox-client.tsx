"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Scale, Wallet } from "lucide-react";
import { api, errorMessage, postJson } from "@/lib/client/api";
import { formatMoney, moneyToInput } from "@/lib/money";
import { Alert, Badge, Button, Field, Modal } from "@/components/ui";

type Cashbox = {
  id: string;
  name: string;
  openingBalanceMinor: string;
  isDefault: boolean;
  isActive: boolean;
  inflowMinor: string;
  outflowMinor: string;
  expectedBalanceMinor: string;
};

type Transaction = {
  id: string;
  direction: "inflow" | "outflow";
  amountMinor: string;
  description: string;
  referenceType: string;
  createdAt: string;
};

export function CashboxClient() {
  const [cashboxes, setCashboxes] = useState<Cashbox[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [cashboxId, setCashboxId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [manual, setManual] = useState({
    direction: "inflow",
    amount: "",
    description: "",
  });
  const [counted, setCounted] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api<{ cashboxes: Cashbox[]; transactions: Transaction[] }>(
        "/api/cashbox",
      );
      setCashboxes(data.cashboxes);
      setTransactions(data.transactions);
      setCashboxId((prev) => prev || data.cashboxes[0]?.id || "");
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = cashboxes.find((c) => c.id === cashboxId) ?? cashboxes[0] ?? null;
  const totalExpected = cashboxes.reduce(
    (sum, c) => sum + BigInt(c.expectedBalanceMinor),
    0n,
  );

  async function submitManual(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await postJson("/api/cashbox/manual", {
        cashboxId: cashboxId || null,
        direction: manual.direction,
        amount: manual.amount,
        description: manual.description,
        occurredAt: new Date().toISOString(),
      });
      setManualOpen(false);
      setManual({ direction: "inflow", amount: "", description: "" });
      setMessage("تم تسجيل حركة الصندوق");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function submitReconcile(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const result = await postJson<{
        expectedMinor: string;
        countedMinor: string;
        differenceMinor: string;
      }>("/api/cashbox/reconcile", { cashboxId: selected.id, counted });
      const diff = BigInt(result.differenceMinor);
      setMessage(
        diff === 0n
          ? "مطابق تماماً. الصندوق متوازن."
          : `فرق ${formatMoney(diff)} ر.ي بين المتوقع والفعلي`,
      );
      setReconcileOpen(false);
      setCounted("");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">الصندوق</h1>
          <p className="text-xs text-ink-500">
            النقد المتوقع الإجمالي <span dir="ltr">{formatMoney(totalExpected)}</span> ر.ي
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setReconcileOpen(true)} disabled={!selected}>
            <Scale className="h-4 w-4" /> مطابقة
          </Button>
          <Button onClick={() => setManualOpen(true)}>
            <Wallet className="h-4 w-4" /> حركة يدوية
          </Button>
        </div>
      </div>

      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cashboxes.map((box) => (
          <button
            key={box.id}
            type="button"
            onClick={() => setCashboxId(box.id)}
            className={`rounded-2xl border bg-white p-4 text-right shadow-card transition ${
              box.id === cashboxId ? "border-brand-500 ring-2 ring-brand-100" : "border-ink-200"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-500">{box.name}</span>
              {box.isDefault ? <Badge tone="brand">افتراضي</Badge> : null}
            </div>
            <p className="mt-2 text-lg font-bold tabular-nums" dir="ltr">
              {formatMoney(BigInt(box.expectedBalanceMinor))}
            </p>
            <div className="mt-1 flex justify-between text-[11px] text-ink-500" dir="ltr">
              <span className="text-ok">+{formatMoney(BigInt(box.inflowMinor))}</span>
              <span className="text-danger">-{formatMoney(BigInt(box.outflowMinor))}</span>
            </div>
          </button>
        ))}
      </div>

      <section className="rounded-2xl border border-ink-200 bg-white shadow-card">
        <div className="border-b border-ink-100 px-4 py-3">
          <h2 className="text-sm font-semibold">آخر الحركات النقدية</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>النوع</th>
                <th>الوصف</th>
                <th>المصدر</th>
                <th>المبلغ</th>
                <th>التاريخ</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Badge tone={t.direction === "inflow" ? "success" : "danger"}>
                      {t.direction === "inflow" ? (
                        <span className="inline-flex items-center gap-1">
                          <ArrowDownLeft className="h-3 w-3" /> قبض
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <ArrowUpRight className="h-3 w-3" /> صرف
                        </span>
                      )}
                    </Badge>
                  </td>
                  <td className="max-w-[240px] truncate text-xs">{t.description}</td>
                  <td className="text-[11px] text-ink-400">{t.referenceType}</td>
                  <td dir="ltr" className={`tabular-nums ${t.direction === "inflow" ? "text-ok" : "text-danger"}`}>
                    {formatMoney(BigInt(t.amountMinor))}
                  </td>
                  <td className="text-[11px] text-ink-400">
                    {new Intl.DateTimeFormat("ar-YE", {
                      dateStyle: "short",
                      timeStyle: "short",
                    }).format(new Date(t.createdAt))}
                  </td>
                </tr>
              ))}
              {!transactions.length ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-xs text-ink-500">
                    لا توجد حركات نقدية
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <Modal
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        title="حركة صندوق يدوية"
        footer={
          <>
            <Button variant="secondary" onClick={() => setManualOpen(false)}>
              إلغاء
            </Button>
            <Button form="manual-form" type="submit" loading={saving}>
              حفظ
            </Button>
          </>
        }
      >
        <form id="manual-form" onSubmit={submitManual} className="space-y-3">
          <Field label="النوع">
            <select
              className="input"
              value={manual.direction}
              onChange={(e) => setManual({ ...manual, direction: e.target.value })}
            >
              <option value="inflow">إيداع / قبض</option>
              <option value="outflow">سحب / صرف</option>
            </select>
          </Field>
          <Field label="المبلغ">
            <input
              className="input"
              dir="ltr"
              inputMode="decimal"
              value={manual.amount}
              onChange={(e) => setManual({ ...manual, amount: e.target.value })}
              required
            />
          </Field>
          <Field label="الوصف">
            <input
              className="input"
              value={manual.description}
              onChange={(e) => setManual({ ...manual, description: e.target.value })}
              required
            />
          </Field>
          <Field label="الصندوق">
            <select
              className="input"
              value={cashboxId}
              onChange={(e) => setCashboxId(e.target.value)}
            >
              {cashboxes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </form>
      </Modal>

      <Modal
        open={reconcileOpen}
        onClose={() => setReconcileOpen(false)}
        title="مطابقة الصندوق"
        footer={
          <>
            <Button variant="secondary" onClick={() => setReconcileOpen(false)}>
              إلغاء
            </Button>
            <Button form="reconcile-form" type="submit" loading={saving}>
              مطابقة
            </Button>
          </>
        }
      >
        <form id="reconcile-form" onSubmit={submitReconcile} className="space-y-3">
          {selected ? (
            <div className="rounded-lg bg-ink-50 px-3 py-2 text-xs">
              <p>{selected.name}</p>
              <p className="mt-1 text-ink-500">
                المتوقع: <span dir="ltr">{formatMoney(BigInt(selected.expectedBalanceMinor))}</span> ر.ي
              </p>
            </div>
          ) : null}
          <Field label="المبلغ الفعلي المعدود" hint="أدخل النقد الموجود فعلياً في الصندوق">
            <input
              className="input"
              dir="ltr"
              inputMode="decimal"
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
              placeholder={selected ? moneyToInput(BigInt(selected.expectedBalanceMinor)) : ""}
              required
            />
          </Field>
        </form>
      </Modal>
    </div>
  );
}
