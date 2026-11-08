"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, PlusCircle, Search } from "lucide-react";
import { api, errorMessage, postJson } from "@/lib/client/api";
import { formatMoney } from "@/lib/money";
import { formatQty } from "@/lib/quantity";
import { formatExpiryDate, getExpiryStatus } from "@/lib/expiry";
import { Alert, Badge, Button, Field, Modal } from "@/components/ui";

type Balance = {
  productId: string;
  productName: string;
  sku: string;
  barcode: string | null;
  unitSymbol: string;
  warehouseId: string;
  warehouseName: string;
  qtyMilli: string;
  valueMinor: string;
  minStockMilli: string;
  updatedAt: string;
};

type Movement = {
  id: string;
  type: string;
  qtyMilli: string;
  valueMinor: string;
  referenceType: string;
  note: string | null;
  createdAt: string;
  productName: string;
  sku: string;
  unitSymbol: string;
  warehouseName: string;
};

type Low = { id: string; name: string; sku: string; qtyMilli: string; minStockMilli: string };
type Warehouse = { id: string; name: string };
type Product = {
  id: string;
  name: string;
  sku: string;
  qtyMilli: string;
  expiryDate: string | null;
  baseUnitName?: string;
};

const MOVEMENT_LABELS: Record<string, string> = {
  purchase: "شراء",
  purchase_return: "مرتجع شراء",
  sale: "بيع",
  sale_return: "مرتجع بيع",
  adjustment_in: "تسوية زيادة",
  adjustment_out: "تسوية نقص",
  damage: "تالف",
  transfer_in: "تحويل وارد",
  transfer_out: "تحويل صادر",
  stocktake: "جرد",
  opening: "رصيد افتتاحي",
};

export function InventoryClient() {
  const [balances, setBalances] = useState<Balance[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [lowStock, setLowStock] = useState<Low[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouseId, setWarehouseId] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [adjust, setAdjust] = useState({
    productId: "",
    direction: "increase",
    qty: "",
    unitCost: "",
    reason: "",
  });
  const [transfer, setTransfer] = useState({
    productId: "",
    fromWarehouseId: "",
    toWarehouseId: "",
    qty: "",
    note: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [inventory, catalog] = await Promise.all([
        api<{
          balances: Balance[];
          movements: Movement[];
          lowStock: Low[];
          warehouses: Warehouse[];
        }>(`/api/inventory${warehouseId ? `?warehouseId=${warehouseId}` : ""}`),
        api<{ products: Product[] }>("/api/products?all=1"),
      ]);
      setBalances(inventory.balances);
      setMovements(inventory.movements);
      setLowStock(inventory.lowStock);
      setWarehouses(inventory.warehouses);
      setProducts(catalog.products);
      setTransfer((prev) => ({
        ...prev,
        fromWarehouseId:
          prev.fromWarehouseId || inventory.warehouses[0]?.id || "",
        toWarehouseId:
          prev.toWarehouseId ||
          inventory.warehouses.find((w) => w.id !== inventory.warehouses[0]?.id)?.id ||
          "",
      }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [warehouseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return balances;
    return balances.filter(
      (b) =>
        b.productName.toLowerCase().includes(q) ||
        b.sku.toLowerCase().includes(q) ||
        (b.barcode ?? "").toLowerCase().includes(q),
    );
  }, [balances, search]);

  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products],
  );

  const expiringProducts = useMemo(() => {
    const stockedProductIds = new Set(
      balances.filter((balance) => BigInt(balance.qtyMilli) > 0n).map((balance) => balance.productId),
    );
    return products.flatMap((product) => {
      if (!stockedProductIds.has(product.id)) return [];
      const status = getExpiryStatus(product.expiryDate);
      return status ? [{ product, status }] : [];
    }).sort((a, b) => a.status.daysRemaining - b.status.daysRemaining);
  }, [balances, products]);

  async function submitAdjust(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await postJson("/api/inventory/adjust", {
        productId: adjust.productId,
        warehouseId: warehouseId || undefined,
        direction: adjust.direction,
        qty: adjust.qty,
        unitCost: adjust.direction === "increase" ? adjust.unitCost || undefined : undefined,
        reason: adjust.reason,
      });
      setAdjustOpen(false);
      setMessage("تم تسجيل التسوية المخزنية");
      setAdjust({ productId: "", direction: "increase", qty: "", unitCost: "", reason: "" });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function submitTransfer(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await postJson("/api/inventory/transfer", {
        productId: transfer.productId,
        fromWarehouseId: transfer.fromWarehouseId,
        toWarehouseId: transfer.toWarehouseId,
        qty: transfer.qty,
        note: transfer.note || undefined,
      });
      setTransferOpen(false);
      setMessage("تم تحويل الكمية بين المخازن");
      setTransfer({ ...transfer, productId: "", qty: "", note: "" });
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
          <h1 className="text-xl font-bold">المخزون</h1>
          <p className="text-xs text-ink-500">
            {balances.length} رصيد صنف · {lowStock.length} تحت الحد الأدنى
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setTransferOpen(true)}>
            <ArrowLeftRight className="h-4 w-4" /> تحويل
          </Button>
          <Button onClick={() => setAdjustOpen(true)}>
            <PlusCircle className="h-4 w-4" /> تسوية مخزون
          </Button>
        </div>
      </div>

      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {expiringProducts.length ? (
        <Alert
          tone={expiringProducts.some((item) => item.status.type === "expired") ? "danger" : "warning"}
        >
          <p className="font-medium">تنبيه صلاحية: توجد أصناف منتهية أو ستنتهي خلال 30 يومًا.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {expiringProducts.map(({ product, status }) => (
              <span
                key={product.id}
                className="rounded-full bg-white/80 px-2 py-1 text-xs"
              >
                {product.name} · {formatExpiryDate(product.expiryDate!)} ·{" "}
                {status.type === "expired"
                  ? "منتهي الصلاحية"
                  : status.daysRemaining === 0
                    ? "ينتهي اليوم"
                    : `ينتهي خلال ${status.daysRemaining} يومًا`}
              </span>
            ))}
          </div>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={warehouseId}
          onChange={(e) => setWarehouseId(e.target.value)}
          className="input max-w-[220px]"
        >
          <option value="">كل المخازن</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-ink-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input pr-9"
            placeholder="بحث في الأصناف..."
          />
        </div>
      </div>

      {lowStock.length ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs font-medium text-warn">نواقص تحتاج إعادة طلب</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {lowStock.slice(0, 10).map((item) => (
              <span
                key={item.id}
                className="rounded-full bg-white px-2 py-1 text-[11px] text-warn"
                dir="ltr"
              >
                {item.name} · {formatQty(BigInt(item.qtyMilli))}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>الصنف</th>
              <th>المخزن</th>
              <th>الكمية</th>
              <th>القيمة</th>
              <th>الحد الأدنى</th>
              <th>الصلاحية</th>
              <th>آخر تحديث</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((b) => {
              const below = BigInt(b.minStockMilli) > 0n && BigInt(b.qtyMilli) <= BigInt(b.minStockMilli);
              const product = productsById.get(b.productId);
              const expiryStatus = getExpiryStatus(product?.expiryDate);
              return (
                <tr key={`${b.productId}:${b.warehouseId}`}>
                  <td>
                    <div className="font-medium">{b.productName}</div>
                    <div className="text-[11px] text-ink-400" dir="ltr">
                      {b.sku}
                    </div>
                  </td>
                  <td className="text-xs text-ink-500">{b.warehouseName}</td>
                  <td dir="ltr" className="tabular-nums">
                    <span className={below ? "font-semibold text-warn" : ""}>
                      {formatQty(BigInt(b.qtyMilli))}
                    </span>{" "}
                    <span className="text-[11px] text-ink-400">{b.unitSymbol}</span>
                    {below ? (
                      <Badge tone="warning">
                        <span className="mr-1">منخفض</span>
                      </Badge>
                    ) : null}
                  </td>
                  <td dir="ltr" className="tabular-nums">
                    {formatMoney(BigInt(b.valueMinor))}
                  </td>
                  <td dir="ltr" className="tabular-nums text-xs text-ink-500">
                    {formatQty(BigInt(b.minStockMilli))}
                  </td>
                  <td className="text-xs">
                    {product?.expiryDate ? (
                      <>
                        <div>{formatExpiryDate(product.expiryDate)}</div>
                        {expiryStatus ? (
                          <Badge tone={expiryStatus.type === "expired" ? "danger" : "warning"}>
                            {expiryStatus.type === "expired" ? "منتهي الصلاحية" : "قرب الانتهاء"}
                          </Badge>
                        ) : null}
                      </>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="text-[11px] text-ink-400">
                    {new Intl.DateTimeFormat("ar-YE", { dateStyle: "short" }).format(
                      new Date(b.updatedAt),
                    )}
                  </td>
                </tr>
              );
            })}
            {!filtered.length && !loading ? (
              <tr>
                <td colSpan={7} className="py-10 text-center text-sm text-ink-500">
                  لا توجد أرصدة مخزنية
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <section className="rounded-2xl border border-ink-200 bg-white shadow-card">
        <div className="border-b border-ink-100 px-4 py-3">
          <h2 className="text-sm font-semibold">آخر الحركات</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>النوع</th>
                <th>الصنف</th>
                <th>المخزن</th>
                <th>الكمية</th>
                <th>ملاحظة</th>
                <th>التاريخ</th>
              </tr>
            </thead>
            <tbody>
              {movements.slice(0, 30).map((m) => (
                <tr key={m.id}>
                  <td>
                    <Badge
                      tone={
                        m.qtyMilli.startsWith("-") ? "warning" : m.type === "damage" ? "danger" : "success"
                      }
                    >
                      {MOVEMENT_LABELS[m.type] ?? m.type}
                    </Badge>
                  </td>
                  <td className="text-xs">
                    {m.productName}
                    <span className="mr-1 text-[10px] text-ink-400" dir="ltr">
                      {m.sku}
                    </span>
                  </td>
                  <td className="text-xs text-ink-500">{m.warehouseName}</td>
                  <td dir="ltr" className="tabular-nums text-xs">
                    {formatQty(BigInt(m.qtyMilli))}
                  </td>
                  <td className="max-w-[180px] truncate text-xs text-ink-500">{m.note ?? "-"}</td>
                  <td className="text-[11px] text-ink-400">
                    {new Intl.DateTimeFormat("ar-YE", {
                      dateStyle: "short",
                      timeStyle: "short",
                    }).format(new Date(m.createdAt))}
                  </td>
                </tr>
              ))}
              {!movements.length ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-xs text-ink-500">
                    لا توجد حركات بعد
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <Modal
        open={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        title="تسوية مخزون"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdjustOpen(false)}>
              إلغاء
            </Button>
            <Button form="adjust-form" type="submit" loading={saving}>
              حفظ التسوية
            </Button>
          </>
        }
      >
        <form id="adjust-form" onSubmit={submitAdjust} className="space-y-3">
          <Field label="الصنف">
            <select
              className="input"
              value={adjust.productId}
              onChange={(e) => setAdjust({ ...adjust, productId: e.target.value })}
              required
            >
              <option value="">اختر الصنف</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.sku})
                </option>
              ))}
            </select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="نوع التسوية">
              <select
                className="input"
                value={adjust.direction}
                onChange={(e) => setAdjust({ ...adjust, direction: e.target.value })}
              >
                <option value="increase">زيادة</option>
                <option value="decrease">نقص</option>
                <option value="damage">تالف</option>
              </select>
            </Field>
            <Field label="الكمية (بالوحدة الأساسية)">
              <input
                className="input"
                dir="ltr"
                inputMode="decimal"
                value={adjust.qty}
                onChange={(e) => setAdjust({ ...adjust, qty: e.target.value })}
                required
              />
            </Field>
            {adjust.direction === "increase" ? (
              <Field label="تكلفة الوحدة (اختياري)">
                <input
                  className="input"
                  dir="ltr"
                  inputMode="decimal"
                  value={adjust.unitCost}
                  onChange={(e) => setAdjust({ ...adjust, unitCost: e.target.value })}
                />
              </Field>
            ) : null}
            <Field label="السبب">
              <input
                className="input"
                value={adjust.reason}
                onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })}
                required
              />
            </Field>
          </div>
        </form>
      </Modal>

      <Modal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        title="تحويل بين المخازن"
        footer={
          <>
            <Button variant="secondary" onClick={() => setTransferOpen(false)}>
              إلغاء
            </Button>
            <Button form="transfer-form" type="submit" loading={saving}>
              تنفيذ التحويل
            </Button>
          </>
        }
      >
        <form id="transfer-form" onSubmit={submitTransfer} className="space-y-3">
          <Field label="الصنف">
            <select
              className="input"
              value={transfer.productId}
              onChange={(e) => setTransfer({ ...transfer, productId: e.target.value })}
              required
            >
              <option value="">اختر الصنف</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.sku}) — {formatQty(BigInt(p.qtyMilli))}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="من مخزن">
              <select
                className="input"
                value={transfer.fromWarehouseId}
                onChange={(e) => setTransfer({ ...transfer, fromWarehouseId: e.target.value })}
                required
              >
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="إلى مخزن">
              <select
                className="input"
                value={transfer.toWarehouseId}
                onChange={(e) => setTransfer({ ...transfer, toWarehouseId: e.target.value })}
                required
              >
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="الكمية">
              <input
                className="input"
                dir="ltr"
                inputMode="decimal"
                value={transfer.qty}
                onChange={(e) => setTransfer({ ...transfer, qty: e.target.value })}
                required
              />
            </Field>
            <Field label="ملاحظة">
              <input
                className="input"
                value={transfer.note}
                onChange={(e) => setTransfer({ ...transfer, note: e.target.value })}
              />
            </Field>
          </div>
        </form>
      </Modal>
    </div>
  );
}
