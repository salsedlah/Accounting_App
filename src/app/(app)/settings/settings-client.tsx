"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, Plus } from "lucide-react";
import { api, errorMessage, patchJson, postJson } from "@/lib/client/api";
import { qtyToInput } from "@/lib/quantity";
import { Alert, Badge, Button, Field, Modal } from "@/components/ui";

type Business = {
  id: string;
  name: string;
  legalName: string | null;
  phone: string | null;
  address: string | null;
  currency: string;
  taxEnabled: boolean;
  taxRateBp: number;
  valuationMethod: "weighted_average" | "fifo";
  offlineSellLimitMilli: string;
};

type Warehouse = {
  id: string;
  name: string;
  code: string | null;
  isDefault: boolean;
  isActive: boolean;
};

type Settings = {
  business: Business;
  warehouses: Warehouse[];
  units: Array<{ id: string; name: string; shortName: string | null }>;
  categories: Array<{ id: string; name: string }>;
};

export function SettingsClient() {
  const [data, setData] = useState<Settings | null>(null);
  const [form, setForm] = useState({
    name: "",
    legalName: "",
    phone: "",
    address: "",
    taxEnabled: false,
    taxPercent: "0",
    valuationMethod: "weighted_average",
    offlineSellLimit: "0",
  });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [warehouseOpen, setWarehouseOpen] = useState(false);
  const [warehouseName, setWarehouseName] = useState("");

  const load = useCallback(async () => {
    try {
      const settings = await api<Settings>("/api/settings");
      setData(settings);
      setForm({
        name: settings.business.name,
        legalName: settings.business.legalName ?? "",
        phone: settings.business.phone ?? "",
        address: settings.business.address ?? "",
        taxEnabled: settings.business.taxEnabled,
        taxPercent: String(settings.business.taxRateBp / 100),
        valuationMethod: settings.business.valuationMethod,
        offlineSellLimit: qtyToInput(BigInt(settings.business.offlineSellLimitMilli)),
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await patchJson("/api/settings", {
        name: form.name,
        legalName: form.legalName || null,
        phone: form.phone || null,
        address: form.address || null,
        taxEnabled: form.taxEnabled,
        taxRateBp: Math.round(Number(form.taxPercent || "0") * 100),
        valuationMethod: form.valuationMethod,
        offlineSellLimit: form.offlineSellLimit,
      });
      setMessage("تم حفظ الإعدادات");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function addWarehouse(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await postJson("/api/settings/warehouse", { name: warehouseName, isDefault: false });
      setWarehouseOpen(false);
      setWarehouseName("");
      setMessage("تمت إضافة المخزن");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function updateWarehouse(
    warehouse: Warehouse,
    patch: { isDefault?: boolean; isActive?: boolean },
  ) {
    setError(null);
    try {
      await patchJson("/api/settings/warehouse", { id: warehouse.id, ...patch });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">الإعدادات</h1>
        <p className="mt-1 text-xs text-ink-500">بيانات المؤسسة وسياسة التقييم والمخازن</p>
      </div>

      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <form onSubmit={save} className="space-y-4">
        <section className="rounded-2xl border border-ink-200 bg-white p-5 shadow-card">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
            <Building2 className="h-4 w-4 text-brand-600" /> بيانات المؤسسة
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="اسم المؤسسة">
              <input
                className="input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </Field>
            <Field label="الاسم القانوني">
              <input
                className="input"
                value={form.legalName}
                onChange={(e) => setForm({ ...form, legalName: e.target.value })}
              />
            </Field>
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
        </section>

        <section className="rounded-2xl border border-ink-200 bg-white p-5 shadow-card">
          <h2 className="mb-4 text-sm font-semibold">السياسة المحاسبية</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="طريقة تقييم المخزون" hint="لا يمكن تغييرها بعد وجود حركات مخزون">
              <select
                className="input"
                value={form.valuationMethod}
                onChange={(e) => setForm({ ...form, valuationMethod: e.target.value })}
              >
                <option value="weighted_average">المتوسط المرجح</option>
                <option value="fifo">الوارد أولاً صادر أولاً (FIFO)</option>
              </select>
            </Field>
            <Field label="حد البيع دون اتصال (بالوحدة الأساس)">
              <input
                className="input"
                dir="ltr"
                inputMode="decimal"
                value={form.offlineSellLimit}
                onChange={(e) => setForm({ ...form, offlineSellLimit: e.target.value })}
              />
            </Field>
            <Field label="تفعيل الضريبة">
              <label className="flex h-10 items-center gap-2 rounded-lg border border-ink-200 px-3">
                <input
                  type="checkbox"
                  checked={form.taxEnabled}
                  onChange={(e) => setForm({ ...form, taxEnabled: e.target.checked })}
                />
                <span className="text-xs">تطبيق ضريبة على المبيعات</span>
              </label>
            </Field>
            <Field label="نسبة الضريبة %">
              <input
                className="input"
                dir="ltr"
                inputMode="decimal"
                disabled={!form.taxEnabled}
                value={form.taxPercent}
                onChange={(e) => setForm({ ...form, taxPercent: e.target.value })}
              />
            </Field>
          </div>
        </section>

        <div className="flex justify-end">
          <Button type="submit" loading={saving}>
            حفظ الإعدادات
          </Button>
        </div>
      </form>

      <section className="rounded-2xl border border-ink-200 bg-white shadow-card">
        <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
          <h2 className="text-sm font-semibold">المخازن</h2>
          <Button variant="secondary" onClick={() => setWarehouseOpen(true)}>
            <Plus className="h-4 w-4" /> مخزن
          </Button>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>الاسم</th>
                <th>الرمز</th>
                <th>الحالة</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.warehouses.map((warehouse) => (
                <tr key={warehouse.id}>
                  <td className="flex items-center gap-2 text-xs font-medium">
                    {warehouse.name}
                    {warehouse.isDefault ? <Badge tone="brand">افتراضي</Badge> : null}
                  </td>
                  <td dir="ltr" className="text-xs text-ink-500">{warehouse.code ?? "-"}</td>
                  <td>
                    <Badge tone={warehouse.isActive ? "success" : "neutral"}>
                      {warehouse.isActive ? "نشط" : "معطل"}
                    </Badge>
                  </td>
                  <td>
                    <div className="flex gap-1">
                      {!warehouse.isDefault ? (
                        <button
                          type="button"
                          onClick={() => updateWarehouse(warehouse, { isDefault: true })}
                          className="rounded-lg px-2 py-1 text-[11px] text-brand-700 hover:bg-brand-50"
                        >
                          تعيين افتراضي
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => updateWarehouse(warehouse, { isActive: !warehouse.isActive })}
                        className="rounded-lg px-2 py-1 text-[11px] text-ink-600 hover:bg-ink-100"
                      >
                        {warehouse.isActive ? "تعطيل" : "تفعيل"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-ink-200 bg-white p-4 shadow-card">
          <h2 className="text-sm font-semibold">الوحدات</h2>
          <div className="mt-2 flex flex-wrap gap-1">
            {data?.units.map((unit) => (
              <span key={unit.id} className="rounded-full bg-ink-100 px-2 py-1 text-[11px]">
                {unit.name}
                {unit.shortName ? ` (${unit.shortName})` : ""}
              </span>
            ))}
          </div>
        </section>
        <section className="rounded-2xl border border-ink-200 bg-white p-4 shadow-card">
          <h2 className="text-sm font-semibold">التصنيفات</h2>
          <div className="mt-2 flex flex-wrap gap-1">
            {data?.categories.map((category) => (
              <span key={category.id} className="rounded-full bg-ink-100 px-2 py-1 text-[11px]">
                {category.name}
              </span>
            ))}
          </div>
        </section>
      </div>

      <Modal
        open={warehouseOpen}
        onClose={() => setWarehouseOpen(false)}
        title="مخزن جديد"
        footer={
          <>
            <Button variant="secondary" onClick={() => setWarehouseOpen(false)}>
              إلغاء
            </Button>
            <Button form="warehouse-form" type="submit" loading={saving}>
              إضافة
            </Button>
          </>
        }
      >
        <form id="warehouse-form" onSubmit={addWarehouse} className="space-y-3">
          <Field label="اسم المخزن">
            <input
              className="input"
              value={warehouseName}
              onChange={(e) => setWarehouseName(e.target.value)}
              required
            />
          </Field>
        </form>
      </Modal>
    </div>
  );
}
