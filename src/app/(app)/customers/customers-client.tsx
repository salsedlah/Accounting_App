"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { MessageCircle, Pencil, Plus, Search, Wallet } from "lucide-react";
import { api, errorMessage, patchJson, postJson, wasQueuedOffline } from "@/lib/client/api";
import { formatMoney, moneyToInput } from "@/lib/money";
import { pendingOperations } from "@/lib/offline/db";
import { Alert, Badge, Button, Field, Modal } from "@/components/ui";
import { PaymentDialog } from "@/components/payment-dialog";

type Customer = {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  creditLimitMinor: string;
  isActive: boolean;
  lastTransactionAt: string | null;
  balanceMinor: string;
  overLimit: boolean;
};

type Reminder = {
  id: string;
  titleAr: string;
  bodyAr: string;
  status: string;
  createdAt: string;
  entityId: string | null;
};

type Form = {
  name: string;
  phone: string;
  address: string;
  notes: string;
  creditLimit: string;
  isActive: boolean;
};

export function CustomersClient() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [cashboxes, setCashboxes] = useState<Array<{ id: string; name: string }>>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [saving, setSaving] = useState(false);
  const [paymentFor, setPaymentFor] = useState<Customer | null>(null);
  const [reminder, setReminder] = useState<{
    name: string;
    eventId: string;
    message: string;
    link: string | null;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, lookups, queued] = await Promise.all([
        api<{ customers: Customer[]; reminders: Reminder[] }>("/api/customers"),
        api<{ cashboxes: Array<{ id: string; name: string }> }>("/api/lookups"),
        pendingOperations("customer.create"),
      ]);
      const localCustomers: Customer[] = queued.map((item) => ({
        id: item.id,
        name: String(item.payload.name ?? "عميل جديد"),
        phone: typeof item.payload.phone === "string" ? item.payload.phone : null,
        address: typeof item.payload.address === "string" ? item.payload.address : null,
        creditLimitMinor: "0",
        isActive: true,
        lastTransactionAt: item.createdAt,
        balanceMinor: "0",
        overLimit: false,
      }));
      const localIds = new Set(localCustomers.map((customer) => customer.id));
      setCustomers([...localCustomers, ...data.customers.filter((customer) => !localIds.has(customer.id))]);
      setReminders(data.reminders);
      setCashboxes(lookups.cashboxes);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.phone ?? "").includes(q),
    );
  }, [customers, search]);

  const totals = useMemo(
    () =>
      customers.reduce(
        (sum, c) => sum + (BigInt(c.balanceMinor) > 0n ? BigInt(c.balanceMinor) : 0n),
        0n,
      ),
    [customers],
  );

  function openNew() {
    setEditing(null);
    setForm({
      name: "",
      phone: "",
      address: "",
      notes: "",
      creditLimit: "0",
      isActive: true,
    });
  }

  function openEdit(customer: Customer) {
    setEditing(customer);
    setForm({
      name: customer.name,
      phone: customer.phone ?? "",
      address: customer.address ?? "",
      notes: "",
      creditLimit: moneyToInput(BigInt(customer.creditLimitMinor)),
      isActive: customer.isActive,
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: form.name,
        phone: form.phone || null,
        address: form.address || null,
        notes: form.notes || null,
        creditLimit: form.creditLimit || "0",
        isActive: form.isActive,
      };
      let result: unknown;
      if (editing) await patchJson(`/api/customers/${editing.id}`, payload);
      else result = await postJson("/api/customers", payload);
      setForm(null);
      setEditing(null);
      setMessage(editing ? "تم تحديث بيانات العميل" : wasQueuedOffline(result) ? "تم حفظ العميل محليًا وسيُزامن عند عودة الاتصال" : "تمت إضافة العميل");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function prepareReminder(customer: Customer) {
    try {
      const result = await postJson<{
        eventId: string;
        message: string;
        link: string | null;
      }>(`/api/customers/${customer.id}/reminder`, {
        action: "prepare",
        channel: "whatsapp",
      });
      setReminder({ name: customer.name, ...result });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function markSent(eventId: string) {
    try {
      await postJson("/api/customers/x/reminder", { action: "sent", eventId });
      await load();
    } catch {
      // non-blocking
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">العملاء</h1>
          <p className="text-xs text-ink-500">
            {customers.length} عميل · إجمالي المستحق{" "}
            <span dir="ltr">{formatMoney(totals)}</span> ر.ي
          </p>
        </div>
        <Button onClick={openNew}>
          <Plus className="h-4 w-4" /> عميل جديد
        </Button>
      </div>

      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-ink-400" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input pr-9"
          placeholder="بحث بالاسم أو الهاتف..."
        />
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>العميل</th>
              <th>الهاتف</th>
              <th>حد الائتمان</th>
              <th>الرصيد المستحق</th>
              <th>آخر تعامل</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((customer) => {
              const balance = BigInt(customer.balanceMinor);
              return (
                <tr key={customer.id}>
                  <td>
                    <div className="font-medium">{customer.name}</div>
                    {!customer.isActive ? <Badge tone="neutral">موقوف</Badge> : null}
                  </td>
                  <td dir="ltr" className="text-xs text-ink-500">
                    {customer.phone ?? "-"}
                  </td>
                  <td dir="ltr" className="text-xs tabular-nums">
                    {BigInt(customer.creditLimitMinor) > 0n
                      ? formatMoney(BigInt(customer.creditLimitMinor))
                      : "غير محدد"}
                  </td>
                  <td dir="ltr" className="tabular-nums">
                    <span className={balance > 0n ? "font-semibold" : "text-ink-500"}>
                      {formatMoney(balance)}
                    </span>
                    {customer.overLimit ? (
                      <Badge tone="danger">
                        <span className="mr-1">تجاوز الحد</span>
                      </Badge>
                    ) : null}
                  </td>
                  <td className="text-[11px] text-ink-400">
                    {customer.lastTransactionAt
                      ? new Intl.DateTimeFormat("ar-YE", { dateStyle: "short" }).format(
                          new Date(customer.lastTransactionAt),
                        )
                      : "-"}
                  </td>
                  <td>
                    <div className="flex items-center gap-1">
                      <Link
                        href={`/customers/${customer.id}`}
                        className="rounded-lg px-2 py-1 text-[11px] text-brand-700 hover:bg-brand-50"
                      >
                        كشف
                      </Link>
                      <button
                        type="button"
                        onClick={() => setPaymentFor(customer)}
                        className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100"
                        title="سند قبض"
                      >
                        <Wallet className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => openEdit(customer)}
                        className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100"
                        title="تعديل"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      {balance > 0n ? (
                        <button
                          type="button"
                          onClick={() => prepareReminder(customer)}
                          className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100"
                          title="تذكير"
                        >
                          <MessageCircle className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!filtered.length && !loading ? (
              <tr>
                <td colSpan={6} className="py-10 text-center text-sm text-ink-500">
                  لا يوجد عملاء مطابقون
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {reminders.length ? (
        <section className="rounded-2xl border border-ink-200 bg-white shadow-card">
          <div className="border-b border-ink-100 px-4 py-3">
            <h2 className="text-sm font-semibold">آخر التذكيرات</h2>
          </div>
          <ul className="divide-y divide-ink-100">
            {reminders.slice(0, 6).map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{item.titleAr}</p>
                  <p className="truncate text-[11px] text-ink-500">{item.bodyAr}</p>
                </div>
                <Badge tone={item.status === "sent" ? "success" : "warning"}>
                  {item.status === "sent" ? "مُرسل" : "مُعد"}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Modal
        open={Boolean(form)}
        onClose={() => {
          setForm(null);
          setEditing(null);
        }}
        title={editing ? "تعديل عميل" : "عميل جديد"}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setForm(null);
                setEditing(null);
              }}
            >
              إلغاء
            </Button>
            <Button form="customer-form" type="submit" loading={saving}>
              حفظ
            </Button>
          </>
        }
      >
        {form ? (
          <form id="customer-form" onSubmit={submit} className="space-y-3">
            <Field label="الاسم">
              <input
                className="input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="الهاتف">
                <input
                  className="input"
                  dir="ltr"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              </Field>
              <Field label="حد الائتمان (ر.ي)">
                <input
                  className="input"
                  dir="ltr"
                  inputMode="decimal"
                  value={form.creditLimit}
                  onChange={(e) => setForm({ ...form, creditLimit: e.target.value })}
                />
              </Field>
            </div>
            <Field label="العنوان">
              <input
                className="input"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
              />
            </Field>
            <Field label="ملاحظات">
              <input
                className="input"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </Field>
            <label className="flex items-center gap-2 text-xs text-ink-600">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              />
              عميل نشط
            </label>
          </form>
        ) : null}
      </Modal>

      {paymentFor ? (
        <PaymentDialog
          key={paymentFor.id}
          open={Boolean(paymentFor)}
          onClose={() => setPaymentFor(null)}
          direction="customer_receipt"
          partyId={paymentFor.id}
          partyName={paymentFor.name}
          cashboxes={cashboxes}
          defaultAmount={moneyToInput(BigInt(paymentFor.balanceMinor))}
          onSaved={async () => {
            setMessage("تم تسجيل سند القبض");
            await load();
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
                onClick={() => reminder && markSent(reminder.eventId)}
                className="rounded-lg bg-brand-600 px-3 py-2 text-sm text-white"
              >
                إرسال عبر واتساب
              </a>
            ) : null}
          </>
        }
      >
        {reminder ? (
          <div className="space-y-2">
            <p className="text-xs text-ink-500">رسالة جاهزة للعميل {reminder.name}</p>
            <pre className="whitespace-pre-wrap rounded-lg bg-ink-50 p-3 text-sm leading-6">
              {reminder.message}
            </pre>
            {!reminder.link ? (
              <Alert tone="warning">لا يوجد رقم هاتف صالح لهذا العميل.</Alert>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
