"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Minus, Plus, Trash2 } from "lucide-react";
import { api, errorMessage, idempotencyKey, postJson } from "@/lib/client/api";
import { formatMoney, moneyToInput, mulDiv, parseMoney } from "@/lib/money";
import { parseQty, qtyToInput } from "@/lib/quantity";
import { Alert, Badge, Button, Field, Modal } from "@/components/ui";

type Supplier = { id: string; name: string };
type Warehouse = { id: string; name: string };
type Product = {
  id: string;
  name: string;
  sku: string;
  purchaseCostMinor: string;
  units: Array<{
    unitId: string;
    unitName: string;
    factorMilli: string;
    isBase: boolean;
    allowFraction: boolean;
  }>;
};

type Purchase = {
  id: string;
  kind: "purchase" | "return";
  invoiceNo: string;
  totalMinor: string;
  paidMinor: string;
  dueMinor: string;
  status: string;
  createdAt: string;
  supplierName: string;
};

type Line = {
  key: string;
  productId: string;
  unitId: string;
  qty: string;
  unitCost: string;
  discount: string;
};

export function PurchasesClient() {
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [supplierId, setSupplierId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [kind, setKind] = useState<"purchase" | "return">("purchase");
  const [discount, setDiscount] = useState("");
  const [extraCost, setExtraCost] = useState("");
  const [paid, setPaid] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [purchaseData, lookups, catalog] = await Promise.all([
        api<{ purchases: Purchase[] }>("/api/purchases?limit=100"),
        api<{ suppliers: Supplier[]; warehouses: Warehouse[] }>("/api/lookups"),
        api<{ products: Product[] }>("/api/products?all=1"),
      ]);
      setPurchases(purchaseData.purchases);
      setSuppliers(lookups.suppliers);
      setWarehouses(lookups.warehouses);
      setProducts(catalog.products);
      setSupplierId((prev) => prev || lookups.suppliers[0]?.id || "");
      setWarehouseId((prev) => prev || lookups.warehouses[0]?.id || "");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const total = useMemo(() => {
    const subtotal = lines.reduce((sum, line) => {
      const qty = parseQty(line.qty || "0");
      const cost = parseMoney(line.unitCost || "0");
      return sum + mulDiv(cost, qty, 1000n);
    }, 0n);
    const net = subtotal - parseMoney(discount || "0") + parseMoney(extraCost || "0");
    return net > 0n ? net : 0n;
  }, [lines, discount, extraCost]);

  function addLine() {
    const product = products[0];
    if (!product) return;
    const unit = product.units.find((u) => u.isBase) ?? product.units[0];
    const cost = mulDiv(BigInt(product.purchaseCostMinor), BigInt(unit.factorMilli), 1000n);
    setLines((prev) => [
      ...prev,
      {
        key: `${Date.now()}-${prev.length}`,
        productId: product.id,
        unitId: unit.unitId,
        qty: "1",
        unitCost: moneyToInput(cost),
        discount: "",
      },
    ]);
  }

  function changeProduct(line: Line, productId: string) {
    const product = products.find((p) => p.id === productId);
    if (!product) return;
    const unit = product.units.find((u) => u.isBase) ?? product.units[0];
    const cost = mulDiv(BigInt(product.purchaseCostMinor), BigInt(unit.factorMilli), 1000n);
    setLines((prev) =>
      prev.map((l) =>
        l.key === line.key
          ? {
              ...l,
              productId,
              unitId: unit.unitId,
              unitCost: moneyToInput(cost),
            }
          : l,
      ),
    );
  }

  function changeUnit(line: Line, unitId: string) {
    const product = products.find((p) => p.id === line.productId);
    const unit = product?.units.find((u) => u.unitId === unitId);
    if (!product || !unit) return;
    const cost = mulDiv(BigInt(product.purchaseCostMinor), BigInt(unit.factorMilli), 1000n);
    setLines((prev) =>
      prev.map((l) =>
        l.key === line.key ? { ...l, unitId, unitCost: moneyToInput(cost) } : l,
      ),
    );
  }

  async function submit() {
    if (!supplierId) {
      setError("اختر المورد");
      return;
    }
    if (!lines.length) {
      setError("أضف صنفاً واحداً على الأقل");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await postJson("/api/purchases", {
        kind,
        supplierId,
        warehouseId: warehouseId || null,
        items: lines.map((line) => ({
          productId: line.productId,
          unitId: line.unitId,
          qty: line.qty,
          unitCost: line.unitCost,
          discount: line.discount || undefined,
        })),
        discount: discount || undefined,
        extraCost: extraCost || undefined,
        paid: paid || undefined,
        notes: notes || undefined,
        occurredAt: new Date().toISOString(),
        idempotencyKey: idempotencyKey("purchase"),
      });
      setOpen(false);
      setLines([]);
      setDiscount("");
      setExtraCost("");
      setPaid("");
      setNotes("");
      setMessage("تم تسجيل فاتورة المشتريات وترحيل القيد");
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
          <h1 className="text-xl font-bold">المشتريات</h1>
          <p className="text-xs text-ink-500">{purchases.length} فاتورة</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> فاتورة مشتريات
        </Button>
      </div>

      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>الفاتورة</th>
              <th>النوع</th>
              <th>المورد</th>
              <th>الإجمالي</th>
              <th>المدفوع</th>
              <th>المتبقي</th>
              <th>التاريخ</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {purchases.map((purchase) => (
              <tr key={purchase.id}>
                <td className="font-medium">{purchase.invoiceNo}</td>
                <td>
                  <Badge tone={purchase.kind === "return" ? "warning" : "brand"}>
                    {purchase.kind === "return" ? "مرتجع" : "شراء"}
                  </Badge>
                </td>
                <td className="text-xs">{purchase.supplierName}</td>
                <td dir="ltr" className="tabular-nums">
                  {formatMoney(BigInt(purchase.totalMinor))}
                </td>
                <td dir="ltr" className="tabular-nums text-xs">
                  {formatMoney(BigInt(purchase.paidMinor))}
                </td>
                <td dir="ltr" className="tabular-nums text-xs">
                  {BigInt(purchase.dueMinor) > 0n ? (
                    <span className="text-warn">{formatMoney(BigInt(purchase.dueMinor))}</span>
                  ) : (
                    formatMoney(0n)
                  )}
                </td>
                <td className="text-[11px] text-ink-400">
                  {new Intl.DateTimeFormat("ar-YE", { dateStyle: "short" }).format(
                    new Date(purchase.createdAt),
                  )}
                </td>
                <td>
                  <a
                    href={`/api/pdf?type=purchase&id=${purchase.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-brand-700 hover:underline"
                  >
                    PDF
                  </a>
                </td>
              </tr>
            ))}
            {!purchases.length && !loading ? (
              <tr>
                <td colSpan={8} className="py-10 text-center text-sm text-ink-500">
                  لا توجد فواتير مشتريات بعد
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="فاتورة مشتريات جديدة"
        wide
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              إلغاء
            </Button>
            <Button onClick={submit} loading={saving}>
              حفظ وترحيل
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="المورد">
              <select
                className="input"
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
              >
                <option value="">اختر المورد</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="المخزن">
              <select
                className="input"
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
              >
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="النوع">
              <select
                className="input"
                value={kind}
                onChange={(e) => setKind(e.target.value as "purchase" | "return")}
              >
                <option value="purchase">شراء</option>
                <option value="return">مرتجع شراء</option>
              </select>
            </Field>
          </div>

          <div className="space-y-2">
            {lines.map((line) => {
              const product = products.find((p) => p.id === line.productId);
              return (
                <div key={line.key} className="rounded-lg border border-ink-200 p-2">
                  <div className="grid gap-2 sm:grid-cols-12">
                    <div className="sm:col-span-4">
                      <select
                        className="input text-xs"
                        value={line.productId}
                        onChange={(e) => changeProduct(line, e.target.value)}
                      >
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.sku})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <select
                        className="input text-xs"
                        value={line.unitId}
                        onChange={(e) => changeUnit(line, e.target.value)}
                      >
                        {product?.units.map((u) => (
                          <option key={u.unitId} value={u.unitId}>
                            {u.unitName}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <input
                        className="input text-xs"
                        dir="ltr"
                        placeholder="الكمية"
                        value={line.qty}
                        onChange={(e) =>
                          setLines((prev) =>
                            prev.map((l) => (l.key === line.key ? { ...l, qty: e.target.value } : l)),
                          )
                        }
                        inputMode="decimal"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <input
                        className="input text-xs"
                        dir="ltr"
                        placeholder="سعر الوحدة"
                        value={line.unitCost}
                        onChange={(e) =>
                          setLines((prev) =>
                            prev.map((l) =>
                              l.key === line.key ? { ...l, unitCost: e.target.value } : l,
                            ),
                          )
                        }
                        inputMode="decimal"
                      />
                    </div>
                    <div className="sm:col-span-2 flex items-center justify-between gap-1">
                      <span className="text-xs font-medium tabular-nums" dir="ltr">
                        {formatMoney(mulDiv(parseMoney(line.unitCost || "0"), parseQty(line.qty || "0"), 1000n))}
                      </span>
                      <button
                        type="button"
                        onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                        className="text-ink-400 hover:text-danger"
                        aria-label="حذف"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            <Button variant="secondary" size="sm" onClick={addLine}>
              <Plus className="h-3 w-3" /> إضافة صنف
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="خصم إجمالي">
              <input
                className="input"
                dir="ltr"
                inputMode="decimal"
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
              />
            </Field>
            <Field label="تكاليف إضافية">
              <input
                className="input"
                dir="ltr"
                inputMode="decimal"
                value={extraCost}
                onChange={(e) => setExtraCost(e.target.value)}
              />
            </Field>
            <Field label="المدفوع للمورد">
              <input
                className="input"
                dir="ltr"
                inputMode="decimal"
                value={paid}
                onChange={(e) => setPaid(e.target.value)}
                placeholder="اتركه فارغاً للدفع الكامل"
              />
            </Field>
          </div>
          <Field label="ملاحظات">
            <input
              className="input"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>

          <div className="flex items-center justify-between rounded-lg bg-ink-50 px-3 py-2">
            <span className="text-xs text-ink-500">الإجمالي المتوقع</span>
            <span className="text-sm font-bold tabular-nums" dir="ltr">
              {formatMoney(total)} ر.ي
            </span>
          </div>
          <p className="text-[11px] text-ink-400">
            سيتم تحديث تكلفة المخزون تلقائياً حسب طريقة التقييم في الإعدادات.{" "}
            <Link href="/suppliers" className="text-brand-700 hover:underline">
              إدارة الموردين
            </Link>
          </p>
        </div>
      </Modal>
    </div>
  );
}
