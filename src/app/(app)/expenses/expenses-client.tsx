"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { api, errorMessage, idempotencyKey, isNetworkFailure, postJson, wasQueuedOffline } from "@/lib/client/api";
import { formatMoney, parseMoney } from "@/lib/money";
import { pendingOperations, queueOfflineOperation } from "@/lib/offline/db";
import { Alert, Badge, Button, Field, Modal } from "@/components/ui";

type Expense = {
  id: string;
  expenseNo: string;
  category: string;
  description: string;
  amountMinor: string;
  cashboxId: string;
  reference: string | null;
  paidAt: string;
  syncStatus?: "pending" | "syncing" | "failed" | "conflict";
};

export function ExpensesClient() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [cashboxes, setCashboxes] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    category: "تشغيلية",
    description: "",
    amount: "",
    cashboxId: "",
    reference: "",
  });

  const load = useCallback(async () => {
    let localExpenses: Expense[] = [];
    try {
      const queued = await pendingOperations("expense.create");
      localExpenses = queued.map((item) => ({
        id: item.id,
        expenseNo: `محلي-${item.id.slice(-6)}`,
        category: String(item.payload.category ?? ""),
        description: String(item.payload.description ?? ""),
        amountMinor: item.totalMinor,
        cashboxId: typeof item.payload.cashboxId === "string" ? item.payload.cashboxId : "",
        reference: typeof item.payload.reference === "string" ? item.payload.reference : null,
        paidAt: item.createdAt,
        syncStatus: item.status,
      }));
      setExpenses(localExpenses);
      const [list, lookups] = await Promise.all([
        api<{ expenses: Expense[] }>("/api/expenses?limit=200"),
        api<{ cashboxes: Array<{ id: string; name: string }> }>("/api/lookups"),
      ]);
      setExpenses([...localExpenses, ...list.expenses]);
      setCashboxes(lookups.cashboxes);
      setForm((prev) => ({
        ...prev,
        cashboxId: prev.cashboxId || lookups.cashboxes[0]?.id || "",
      }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
    window.addEventListener("offline-sync-complete", load);
    return () => window.removeEventListener("offline-sync-complete", load);
  }, [load]);

  const total = useMemo(
    () => expenses.reduce((sum, e) => sum + BigInt(e.amountMinor), 0n),
    [expenses],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = {
        category: form.category,
        description: form.description,
        amount: form.amount,
        cashboxId: form.cashboxId || null,
        reference: form.reference || undefined,
        idempotencyKey: idempotencyKey("exp"),
      };
      let result: unknown;
      try {
        result = await postJson("/api/expenses", payload);
      } catch (err) {
        if (!isNetworkFailure(err)) throw err;
        await queueOfflineOperation("expense.create", payload, parseMoney(form.amount).toString());
        result = { offlineQueued: true };
      }
      setOpen(false);
      setForm({
        category: "تشغيلية",
        description: "",
        amount: "",
        cashboxId: cashboxes[0]?.id ?? "",
        reference: "",
      });
      setMessage(wasQueuedOffline(result) ? "تم حفظ المصروف على هذا الجهاز وسيُزامن عند عودة الاتصال" : "تم تسجيل المصروف وترحيل القيد");
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
          <h1 className="text-xl font-bold">المصروفات</h1>
          <p className="text-xs text-ink-500">
            {expenses.length} مصروف · إجمالي <span dir="ltr">{formatMoney(total)}</span> ر.ي
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> مصروف جديد
        </Button>
      </div>

      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>السند</th>
              <th>التصنيف</th>
              <th>الوصف</th>
              <th>المبلغ</th>
              <th>التاريخ</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {expenses.map((expense) => (
              <tr key={expense.id}>
                <td className="font-medium">
                  {expense.expenseNo}
                  {expense.syncStatus ? (
                    <Badge tone={expense.syncStatus === "conflict" ? "danger" : "warning"}>
                      {expense.syncStatus === "conflict"
                        ? "يحتاج مراجعة"
                        : expense.syncStatus === "failed"
                          ? "تعذرت المزامنة"
                          : expense.syncStatus === "syncing"
                            ? "جارٍ المزامنة"
                            : "بانتظار المزامنة"}
                    </Badge>
                  ) : null}
                </td>
                <td>
                  <Badge tone="neutral">{expense.category}</Badge>
                </td>
                <td className="max-w-[260px] truncate text-xs">{expense.description}</td>
                <td dir="ltr" className="tabular-nums">
                  {formatMoney(BigInt(expense.amountMinor))}
                </td>
                <td className="text-[11px] text-ink-400">
                  {new Intl.DateTimeFormat("ar-YE", { dateStyle: "short" }).format(
                    new Date(expense.paidAt),
                  )}
                </td>
                <td>
                  <a
                    href={`/api/pdf?type=expense&id=${expense.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-brand-700 hover:underline"
                  >
                    PDF
                  </a>
                </td>
              </tr>
            ))}
            {!expenses.length ? (
              <tr>
                <td colSpan={6} className="py-10 text-center text-sm text-ink-500">
                  لا توجد مصروفات مسجلة
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="مصروف جديد"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              إلغاء
            </Button>
            <Button form="expense-form" type="submit" loading={saving}>
              حفظ
            </Button>
          </>
        }
      >
        <form id="expense-form" onSubmit={submit} className="space-y-3">
          <Field label="التصنيف">
            <input
              className="input"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              required
            />
          </Field>
          <Field label="الوصف">
            <input
              className="input"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              required
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="المبلغ (ر.ي)">
              <input
                className="input"
                dir="ltr"
                inputMode="decimal"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                required
              />
            </Field>
            <Field label="الصندوق">
              <select
                className="input"
                value={form.cashboxId}
                onChange={(e) => setForm({ ...form, cashboxId: e.target.value })}
              >
                {cashboxes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="المرجع">
            <input
              className="input"
              dir="ltr"
              value={form.reference}
              onChange={(e) => setForm({ ...form, reference: e.target.value })}
            />
          </Field>
        </form>
      </Modal>
    </div>
  );
}
