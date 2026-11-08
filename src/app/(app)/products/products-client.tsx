"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Search } from "lucide-react";
import { api, errorMessage, patchJson, postJson } from "@/lib/client/api";
import { formatMoney, moneyToInput } from "@/lib/money";
import { formatQty, qtyToInput } from "@/lib/quantity";
import { formatExpiryDate, getExpiryStatus } from "@/lib/expiry";
import { Badge, Button, Field, Modal } from "@/components/ui";

type UnitOption = { id: string; name: string; symbol: string };
type Category = { id: string; name: string };
type Supplier = { id: string; name: string };

type ProductUnit = {
  unitId: string;
  unitName: string;
  factorMilli: string;
  isBase: boolean;
  retailPriceMinor: string | null;
  wholesalePriceMinor: string | null;
  allowFraction: boolean;
};

type Product = {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  categoryId: string | null;
  categoryName?: string | null;
  baseUnitId: string;
  baseUnitName?: string;
  purchaseCostMinor: string;
  retailPriceMinor: string;
  wholesalePriceMinor: string;
  minStockMilli: string;
  defaultSupplierId: string | null;
  expiryDate: string | null;
  isActive: boolean;
  qtyMilli: string;
  units: ProductUnit[];
};

type UnitRow = {
  unitId: string;
  factor: string;
  retailPrice: string;
  wholesalePrice: string;
  allowFraction: boolean;
};

type FormState = {
  name: string;
  sku: string;
  barcode: string;
  categoryId: string;
  baseUnitId: string;
  purchaseCost: string;
  retailPrice: string;
  wholesalePrice: string;
  minStock: string;
  defaultSupplierId: string;
  expiryDate: string;
  isActive: boolean;
  units: UnitRow[];
};

const emptyForm = (baseUnitId: string): FormState => ({
  name: "",
  sku: "",
  barcode: "",
  categoryId: "",
  baseUnitId,
  purchaseCost: "0",
  retailPrice: "0",
  wholesalePrice: "0",
  minStock: "0",
  defaultSupplierId: "",
  expiryDate: "",
  isActive: true,
  units: [
    { unitId: baseUnitId, factor: "1", retailPrice: "", wholesalePrice: "", allowFraction: false },
  ],
});

export function ProductsClient() {
  const [products, setProducts] = useState<Product[]>([]);
  const [units, setUnits] = useState<UnitOption[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [editing, setEditing] = useState<Product | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, lookups] = await Promise.all([
        api<{ products: Product[] }>("/api/products?all=1"),
        api<{
          units: UnitOption[];
          categories: Category[];
          suppliers: Supplier[];
        }>("/api/lookups"),
      ]);
      setProducts(list.products);
      setUnits(lookups.units);
      setCategories(lookups.categories);
      setSuppliers(lookups.suppliers);
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
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.barcode ?? "").toLowerCase().includes(q),
    );
  }, [products, search]);

  function openNew() {
    if (!units.length) {
      setError("أضف وحدة قياس أولاً من الإعدادات");
      return;
    }
    const base = units.find((u) => u.symbol === "قطعة") ?? units[0];
    setEditing(null);
    setForm(emptyForm(base.id));
  }

  function openEdit(product: Product) {
    setEditing(product);
    setForm({
      name: product.name,
      sku: product.sku,
      barcode: product.barcode ?? "",
      categoryId: product.categoryId ?? "",
      baseUnitId: product.baseUnitId,
      purchaseCost: moneyToInput(BigInt(product.purchaseCostMinor)),
      retailPrice: moneyToInput(BigInt(product.retailPriceMinor)),
      wholesalePrice: moneyToInput(BigInt(product.wholesalePriceMinor)),
      minStock: qtyToInput(BigInt(product.minStockMilli)),
      defaultSupplierId: product.defaultSupplierId ?? "",
      expiryDate: product.expiryDate ?? "",
      isActive: product.isActive,
      units: product.units.map((u) => ({
        unitId: u.unitId,
        factor: formatQty(BigInt(u.factorMilli)),
        retailPrice: u.retailPriceMinor ? moneyToInput(BigInt(u.retailPriceMinor)) : "",
        wholesalePrice: u.wholesalePriceMinor ? moneyToInput(BigInt(u.wholesalePriceMinor)) : "",
        allowFraction: u.allowFraction,
      })),
    });
  }

  function updateUnitRow(index: number, patch: Partial<UnitRow>) {
    setForm((prev) =>
      prev
        ? { ...prev, units: prev.units.map((u, i) => (i === index ? { ...u, ...patch } : u)) }
        : prev,
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: form.name.trim(),
        sku: form.sku.trim(),
        barcode: form.barcode.trim() || null,
        categoryId: form.categoryId || null,
        baseUnitId: form.baseUnitId,
        purchaseCost: form.purchaseCost || "0",
        retailPrice: form.retailPrice || "0",
        wholesalePrice: form.wholesalePrice || "0",
        minStock: form.minStock || "0",
        defaultSupplierId: form.defaultSupplierId || null,
        expiryDate: form.expiryDate || null,
        isActive: form.isActive,
        units: form.units.map((u) => ({
          unitId: u.unitId,
          factor: u.factor || "1",
          retailPrice: u.retailPrice || undefined,
          wholesalePrice: u.wholesalePrice || undefined,
          allowFraction: u.allowFraction,
        })),
      };
      if (editing) {
        await patchJson(`/api/products/${editing.id}`, payload);
      } else {
        await postJson("/api/products", payload);
      }
      setForm(null);
      setEditing(null);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(product: Product) {
    try {
      await patchJson(`/api/products/${product.id}`, { isActive: !product.isActive });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">المنتجات</h1>
          <p className="text-xs text-ink-500">{products.length} منتج في الكتالوج</p>
        </div>
        <Button onClick={openNew}>
          <Plus className="h-4 w-4" /> منتج جديد
        </Button>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      ) : null}

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-ink-400" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input pr-9"
          placeholder="بحث بالاسم أو SKU أو الباركود..."
        />
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>المنتج</th>
              <th>SKU</th>
              <th>التصنيف</th>
              <th>التكلفة</th>
              <th>سعر البيع</th>
              <th>المخزون</th>
              <th>تاريخ الانتهاء</th>
              <th>الحالة</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((product) => (
              <tr key={product.id}>
                <td>
                  <div className="font-medium">{product.name}</div>
                  {product.barcode ? (
                    <div className="text-[11px] text-ink-400" dir="ltr">
                      {product.barcode}
                    </div>
                  ) : null}
                </td>
                <td dir="ltr" className="text-xs text-ink-500">
                  {product.sku}
                </td>
                <td className="text-xs text-ink-500">{product.categoryName ?? "-"}</td>
                <td dir="ltr" className="tabular-nums">
                  {formatMoney(BigInt(product.purchaseCostMinor))}
                </td>
                <td dir="ltr" className="tabular-nums">
                  {formatMoney(BigInt(product.retailPriceMinor))}
                </td>
                <td dir="ltr" className="tabular-nums">
                  {formatQty(BigInt(product.qtyMilli))} {product.baseUnitName ?? ""}
                </td>
                <td className="text-xs">
                  {product.expiryDate ? (
                    <>
                      <div>{formatExpiryDate(product.expiryDate)}</div>
                      {(() => {
                        const status = getExpiryStatus(product.expiryDate);
                        return status ? (
                          <Badge tone={status.type === "expired" ? "danger" : "warning"}>
                            {status.type === "expired" ? "منتهي الصلاحية" : "قرب الانتهاء"}
                          </Badge>
                        ) : null;
                      })()}
                    </>
                  ) : (
                    "-"
                  )}
                </td>
                <td>
                  {product.isActive ? (
                    <Badge tone="success">نشط</Badge>
                  ) : (
                    <Badge tone="neutral">موقوف</Badge>
                  )}
                </td>
                <td>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openEdit(product)}
                      className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100"
                      aria-label="تعديل"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleActive(product)}
                      className="rounded-lg px-2 py-1 text-[11px] text-ink-500 hover:bg-ink-100"
                    >
                      {product.isActive ? "إيقاف" : "تنشيط"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!filtered.length && !loading ? (
              <tr>
                <td colSpan={9} className="py-10 text-center text-sm text-ink-500">
                  لا توجد منتجات مطابقة
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
        title={editing ? "تعديل منتج" : "منتج جديد"}
        wide
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
            <Button form="product-form" type="submit" loading={saving}>
              حفظ
            </Button>
          </>
        }
      >
        {form ? (
          <form id="product-form" onSubmit={submit} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="اسم المنتج">
                <input
                  className="input"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                />
              </Field>
              <Field label="رمز SKU">
                <input
                  className="input"
                  dir="ltr"
                  value={form.sku}
                  onChange={(e) => setForm({ ...form, sku: e.target.value })}
                  required
                />
              </Field>
              <Field label="الباركود">
                <input
                  className="input"
                  dir="ltr"
                  value={form.barcode}
                  onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                />
              </Field>
              <Field label="التصنيف">
                <select
                  className="input"
                  value={form.categoryId}
                  onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                >
                  <option value="">بدون تصنيف</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="التكلفة (ر.ي)">
                <input
                  className="input"
                  dir="ltr"
                  inputMode="decimal"
                  value={form.purchaseCost}
                  onChange={(e) => setForm({ ...form, purchaseCost: e.target.value })}
                />
              </Field>
              <Field label="سعر التجزئة (ر.ي)">
                <input
                  className="input"
                  dir="ltr"
                  inputMode="decimal"
                  value={form.retailPrice}
                  onChange={(e) => setForm({ ...form, retailPrice: e.target.value })}
                  required
                />
              </Field>
              <Field label="سعر الجملة (ر.ي)">
                <input
                  className="input"
                  dir="ltr"
                  inputMode="decimal"
                  value={form.wholesalePrice}
                  onChange={(e) => setForm({ ...form, wholesalePrice: e.target.value })}
                />
              </Field>
              <Field label="تاريخ انتهاء الصلاحية">
                <input
                  className="input"
                  type="date"
                  dir="ltr"
                  value={form.expiryDate}
                  onChange={(e) => setForm({ ...form, expiryDate: e.target.value })}
                />
              </Field>
              <Field label="حد المخزون الأدنى">
                <input
                  className="input"
                  dir="ltr"
                  inputMode="decimal"
                  value={form.minStock}
                  onChange={(e) => setForm({ ...form, minStock: e.target.value })}
                />
              </Field>
              <Field label="المورد الافتراضي">
                <select
                  className="input"
                  value={form.defaultSupplierId}
                  onChange={(e) => setForm({ ...form, defaultSupplierId: e.target.value })}
                >
                  <option value="">بدون</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="الوحدة الأساسية">
                <select
                  className="input"
                  value={form.baseUnitId}
                  disabled={Boolean(editing)}
                  onChange={(e) => {
                    const base = e.target.value;
                    setForm({
                      ...form,
                      baseUnitId: base,
                      units: form.units.map((u, i) =>
                        i === 0 ? { ...u, unitId: base, factor: "1" } : u,
                      ),
                    });
                  }}
                >
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {(() => {
              const status = getExpiryStatus(form.expiryDate);
              if (!status) return null;
              return (
                <div
                  className={`rounded-lg border px-3 py-2 text-sm ${
                    status.type === "expired"
                      ? "border-red-200 bg-red-50 text-danger"
                      : "border-amber-200 bg-amber-50 text-warn"
                  }`}
                  role="status"
                >
                  {status.type === "expired"
                    ? "تنبيه: المنتج منتهي الصلاحية."
                    : status.daysRemaining === 0
                      ? "تنبيه: تنتهي صلاحية المنتج اليوم."
                      : `تنبيه: المنتج قريب الانتهاء، تبقى ${status.daysRemaining} يومًا.`}
                </div>
              );
            })()}

            <div className="rounded-xl border border-ink-200 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium text-ink-600">وحدات القياس والأسعار</p>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setForm({
                      ...form,
                      units: [
                        ...form.units,
                        {
                          unitId: units[0]?.id ?? form.baseUnitId,
                          factor: "1",
                          retailPrice: "",
                          wholesalePrice: "",
                          allowFraction: false,
                        },
                      ],
                    })
                  }
                >
                  <Plus className="h-3 w-3" /> وحدة
                </Button>
              </div>
              <div className="space-y-2">
                {form.units.map((row, index) => {
                  const isBase = index === 0;
                  return (
                    <div key={index} className="grid gap-2 sm:grid-cols-5">
                      <select
                        className="input text-xs"
                        value={row.unitId}
                        disabled={isBase}
                        onChange={(e) => updateUnitRow(index, { unitId: e.target.value })}
                      >
                        {units.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                      </select>
                      <input
                        className="input text-xs"
                        dir="ltr"
                        title="عدد الوحدات الأساسية في هذه الوحدة"
                        placeholder="عامل التحويل"
                        value={row.factor}
                        disabled={isBase}
                        onChange={(e) => updateUnitRow(index, { factor: e.target.value })}
                      />
                      <input
                        className="input text-xs"
                        dir="ltr"
                        placeholder="سعر التجزئة"
                        value={row.retailPrice}
                        onChange={(e) => updateUnitRow(index, { retailPrice: e.target.value })}
                      />
                      <input
                        className="input text-xs"
                        dir="ltr"
                        placeholder="سعر الجملة"
                        value={row.wholesalePrice}
                        onChange={(e) => updateUnitRow(index, { wholesalePrice: e.target.value })}
                      />
                      <div className="flex items-center justify-between gap-1">
                        <label className="flex items-center gap-1 text-[11px] text-ink-600">
                          <input
                            type="checkbox"
                            checked={row.allowFraction}
                            onChange={(e) => updateUnitRow(index, { allowFraction: e.target.checked })}
                          />
                          كسور
                        </label>
                        {!isBase ? (
                          <button
                            type="button"
                            className="text-[11px] text-danger"
                            onClick={() =>
                              setForm({
                                ...form,
                                units: form.units.filter((_, i) => i !== index),
                              })
                            }
                          >
                            حذف
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-[11px] text-ink-400">
                عامل التحويل = كم وحدة أساسية تحتويها الوحدة (مثال: الكرتون 24).
              </p>
            </div>

            <label className="flex items-center gap-2 text-xs text-ink-600">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              />
              منتج نشط
            </label>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}
