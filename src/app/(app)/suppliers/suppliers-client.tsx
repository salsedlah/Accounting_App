"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Pencil, Plus, Search, Wallet } from "lucide-react";
import { api, errorMessage, patchJson, postJson } from "@/lib/client/api";
import { formatMoney, moneyToInput } from "@/lib/money";
import { Alert, Button, Field, Modal } from "@/components/ui";
import { PaymentDialog } from "@/components/payment-dialog";

type Supplier = {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  balanceMinor: string;
  isActive: boolean;
};

type Form = {
  name: string;
  phone: string;
  address: string;
  notes: string;
  isActive: boolean;
};

export function SuppliersClient() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [cashboxes, setCashboxes] = useState<Array<{ id: string; name: string }>>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [saving, setSaving] = useState(false);
  const [paymentFor, setPaymentFor] = useState<Supplier | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [data, lookups] = await Promise.all([
        api<{ suppliers: Supplier[] }>("/api/suppliers"),
        api<{ cashboxes: Array<{ id: string; name: string }> }>("/api/lookups"),
      ]);
      setSuppliers(data.suppliers);
      setCashboxes(lookups.cashboxes);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.phone ?? "").includes(q),
    );
  }, [suppliers, search]);

  function openNew() {
    setEditing(null);
    setForm({ name: "", phone: "", address: "", notes: "", isActive: true });
  }

  function openEdit(supplier: Supplier) {
    setEditing(supplier);
    setForm({
      name: supplier.name,
      phone: supplier.phone ?? "",
      address: supplier.address ?? "",
      notes: "",
      isActive: supplier.isActive,
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
        isActive: form.isActive,
      };
      if (editing) await patchJson(`/api/suppliers/${editing.id}`, payload);
      else await postJson("/api/suppliers", payload);
      setForm(null);
      setEditing(null);
      setMessage(editing ? "تم تحديث المورد" : "تمت إضافة المورد");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const payable = suppliers.reduce(
    (sum, s) => sum + (BigInt(s.balanceMinor) > 0n ? BigInt(s.balanceMinor) : 0n),
    0n,
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">الموردون</h1>
          <p className="text-xs text-ink-500">
            {suppliers.length} مورد · مستحق{" "}
            <span dir="ltr">{formatMoney(payable)}</span> ر.ي
          </p>
        </div>
        <Button onClick={openNew}>
          <Plus className="h-4 w-4" /> مورد جديد
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
              <th>المورد</th>
              <th>الهاتف</th>
              <th>العنوان</th>
              <th>المستحق</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((supplier) => (
              <tr key={supplier.id}>
                <td className="font-medium">{supplier.name}</td>
                <td dir="ltr" className="text-xs text-ink-500">
                  {supplier.phone ?? "-"}
                </td>
                <td className="text-xs text-ink-500">{supplier.address ?? "-"}</td>
                <td dir="ltr" className="tabular-nums">
                  {formatMoney(BigInt(supplier.balanceMinor))}
                </td>
                <td>
                  <div className="flex items-center gap-1">
                    <Link
                      href={`/suppliers/${supplier.id}`}
                      className="rounded-lg px-2 py-1 text-[11px] text-brand-700 hover:bg-brand-50"
                    >
                      كشف
                    </Link>
                    <button
                      type="button"
                      onClick={() => setPaymentFor(supplier)}
                      className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100"
                      title="سند صرف"
                    >
                      <Wallet className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(supplier)}
                      className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100"
                      title="تعديل"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!filtered.length ? (
              <tr>
                <td colSpan={5} className="py-10 text-center text-sm text-ink-500">
                  لا يوجد موردون مطابقون
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <Modal
        open={Boolean(form)}
        onClose={() => {
          setForm(null);
          setEditing(null);
        }}
        title={editing ? "تعديل مورد" : "مورد جديد"}
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
            <Button form="supplier-form" type="submit" loading={saving}>
              حفظ
            </Button>
          </>
        }
      >
        {form ? (
          <form id="supplier-form" onSubmit={submit} className="space-y-3">
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
              <Field label="العنوان">
                <input
                  className="input"
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                />
              </Field>
            </div>
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
              مورد نشط
            </label>
          </form>
        ) : null}
      </Modal>

      {paymentFor ? (
        <PaymentDialog
          key={paymentFor.id}
          open={Boolean(paymentFor)}
          onClose={() => setPaymentFor(null)}
          direction="supplier_payment"
          partyId={paymentFor.id}
          partyName={paymentFor.name}
          cashboxes={cashboxes}
          defaultAmount={moneyToInput(BigInt(paymentFor.balanceMinor))}
          onSaved={async () => {
            setMessage("تم تسجيل سند الصرف");
            await load();
          }}
        />
      ) : null}
    </div>
  );
}
