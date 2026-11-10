"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Barcode,
  CheckCircle2,
  Minus,
  Plus,
  RefreshCw,
  Search,
  ShoppingCart,
  Trash2,
  WifiOff,
} from "lucide-react";
import { formatMoney, moneyToInput, mulDiv, parseMoney } from "@/lib/money";
import { formatQty, qtyToInput } from "@/lib/quantity";
import { api, ApiRequestError, errorMessage, idempotencyKey } from "@/lib/client/api";
import {
  baseQtyInCart,
  isLowStock,
  parseQtySafe,
  POS_STOCK_MESSAGES,
  productStock,
  remainingMessage,
  stockLabel,
  stockWithUnitConversion,
  sumBaseQtyByProduct,
  toBaseQtySafe,
} from "@/lib/pos-stock";
import {
  cachePosData,
  decrementCachedStock,
  markPendingFailed,
  pendingSales,
  queueSale,
  readCachedPosData,
  retryFailedSales,
  syncPending,
  type CachedCustomer,
  type CachedProduct,
  type CachedUnit,
  type PendingSale,
} from "@/lib/offline/db";
import { Alert, Badge, Button, Field, Modal } from "@/components/ui";
import { BarcodeScanner } from "@/components/barcode-scanner";
import { ROLE_PERMISSIONS, PERMISSIONS, type Permission } from "@/lib/constants";

type PosProduct = CachedProduct & { categoryName?: string | null; isActive?: boolean };

type PosData = {
  products: PosProduct[];
  warehouse: { id: string; name: string } | null;
  customers: CachedCustomer[];
  cashboxes: Array<{ id: string; name: string; expectedBalanceMinor: string; isDefault: boolean }>;
  business: {
    currency: string;
    taxEnabled: boolean;
    taxRateBp: number;
    offlineSellLimitMilli: string;
  };
};

type CartLine = {
  key: string;
  productId: string;
  productName: string;
  unitId: string;
  unitName: string;
  factorMilli: string;
  qty: string;
  price: string;
  priceTier: "retail" | "wholesale";
  allowFraction: boolean;
};

type SaleResult = {
  invoiceNo: string;
  totalMinor: string;
  dueMinor: string;
  id: string;
  customerName?: string | null;
};

function lineTotal(line: CartLine): bigint {
  const qty = parseQtySafe(line.qty) ?? 0n;
  return mulDiv(parseMoney(line.price || "0"), qty, 1000n);
}

function unitPrice(
  product: PosProduct,
  unit: CachedUnit,
  tier: "retail" | "wholesale",
): bigint {
  const basePrice = BigInt(
    tier === "wholesale" ? product.wholesalePriceMinor : product.retailPriceMinor,
  );
  const override = tier === "wholesale" ? unit.wholesalePriceMinor : unit.retailPriceMinor;
  if (override !== null && override !== "") return BigInt(override);
  return unit.isBase ? basePrice : mulDiv(basePrice, BigInt(unit.factorMilli), 1000n);
}

function lineBaseQtyOrNull(line: CartLine): bigint | null {
  const qty = parseQtySafe(line.qty);
  if (qty === null) return null;
  return toBaseQtySafe(qty, BigInt(line.factorMilli));
}

function lineBaseQty(line: CartLine): bigint {
  return lineBaseQtyOrNull(line) ?? 0n;
}

export function PosClient({ role }: { role: string }) {
  const permissions = (ROLE_PERMISSIONS[role] ?? []) as Permission[];
  const [data, setData] = useState<PosData | null>(null);
  const [offlineData, setOfflineData] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [cashboxId, setCashboxId] = useState("");
  const [paymentType, setPaymentType] = useState<"cash" | "credit" | "mixed">("cash");
  const [paid, setPaid] = useState("");
  const [discount, setDiscount] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [pending, setPending] = useState<PendingSale[]>([]);
  const [lastSale, setLastSale] = useState<SaleResult | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const barcodeInputRef = useRef<HTMLInputElement | null>(null);
  const barcodeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBarcodeRef = useRef({ value: "", at: 0 });
  const barcodeAudioContextRef = useRef<AudioContext | null>(null);

  function unlockBarcodeAudio() {
    try {
      const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;
      barcodeAudioContextRef.current ??= new AudioContextClass();
      if (barcodeAudioContextRef.current.state === "suspended") {
        void barcodeAudioContextRef.current.resume().catch(() => undefined);
      }
    } catch { /* Browser audio can be unavailable or muted. */ }
  }

  function playBarcodeBeep() {
    try {
      const context = barcodeAudioContextRef.current;
      if (!context || context.state !== "running") return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "square";
      oscillator.frequency.value = 2100;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.11);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.115);
    } catch { /* Browser audio can be unavailable or muted. */ }
  }
  const cartRef = useRef<CartLine[]>([]);

  const commitCart = useCallback((next: CartLine[]) => {
    cartRef.current = next;
    setCart(next);
  }, []);

  useEffect(() => {
    cartRef.current = cart;
  }, [cart]);

  const canDiscount = permissions.includes(PERMISSIONS.discounts);
  const canCustomPrice = permissions.includes(PERMISSIONS.customPrice);

  const load = useCallback(async (opts?: { keepError?: boolean }) => {
    setLoading(true);
    if (!opts?.keepError) setError(null);
    try {
      const fresh = await api<PosData>("/api/pos/data");
      setData(fresh);
      setOfflineData(false);
      setCachedAt(null);
      setCashboxId((prev) => prev || fresh.cashboxes.find((c) => c.isDefault)?.id || fresh.cashboxes[0]?.id || "");
      await cachePosData({
        products: fresh.products,
        customers: fresh.customers,
        settings: {
          warehouse: fresh.warehouse,
          cashboxes: fresh.cashboxes,
          business: fresh.business,
        },
      });
    } catch (err) {
      const cached = await readCachedPosData();
      if (cached.products.length) {
        setData({
          products: cached.products,
          warehouse: cached.settings?.warehouse ?? null,
          customers: cached.customers,
          cashboxes: cached.settings?.cashboxes ?? [],
          business: cached.settings?.business ?? {
            currency: "YER", taxEnabled: false, taxRateBp: 0, offlineSellLimitMilli: "0",
          },
        });
        setOfflineData(true);
        setCachedAt(cached.cachedAt);
        setMessage("تعذر الاتصال. تم تحميل بيانات مخزّنة مؤقتاً — البيع متاح دون اتصال.");
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setLoading(false);
      setPending(await pendingSales());
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handleOnline = () => {
      void load();
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [load]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const product of data?.products ?? []) {
      if (product.categoryName) set.add(product.categoryName);
    }
    return Array.from(set);
  }, [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.products ?? []).filter((product) => {
      if (category !== "all" && product.categoryName !== category) return false;
      if (!q) return true;
      return (
        product.name.toLowerCase().includes(q) ||
        product.sku.toLowerCase().includes(q) ||
        (product.barcode ?? "").toLowerCase().includes(q)
      );
    });
  }, [data, search, category]);

  const stockByProduct = useMemo(() => {
    const map = new Map<string, bigint>();
    for (const product of data?.products ?? []) map.set(product.id, BigInt(product.qtyMilli));
    return map;
  }, [data]);

  const baseUnitNameByProduct = useMemo(() => {
    const map = new Map<string, string>();
    for (const product of data?.products ?? []) {
      map.set(
        product.id,
        product.baseUnitName ?? product.units.find((u) => u.isBase)?.unitName ?? "",
      );
    }
    return map;
  }, [data]);

  const cartBaseByProduct = useMemo(
    () =>
      sumBaseQtyByProduct(
        cart.map((line) => ({ productId: line.productId, qtyBaseMilli: lineBaseQty(line) })),
      ),
    [cart],
  );

  const subtotal = cart.reduce((sum, line) => sum + lineTotal(line), 0n);
  const discountMinor = canDiscount ? parseMoney(discount || "0") : 0n;
  const netBeforeTax = subtotal - discountMinor > 0n ? subtotal - discountMinor : 0n;
  const taxMinor =
    data?.business.taxEnabled && data.business.taxRateBp > 0
      ? mulDiv(netBeforeTax, BigInt(data.business.taxRateBp), 10000n)
      : 0n;
  const total = netBeforeTax + taxMinor;

  const selectedCustomer = data?.customers.find((c) => c.id === customerId) ?? null;
  const customerDue = selectedCustomer ? BigInt(selectedCustomer.balanceMinor) : 0n;
  const creditLimit = selectedCustomer ? BigInt(selectedCustomer.creditLimitMinor) : 0n;
  const dueForThis = paymentType === "cash" ? 0n : paymentType === "credit" ? total : total - parseMoney(paid || "0");
  const creditWarning =
    selectedCustomer && creditLimit > 0n && customerDue + (dueForThis > 0n ? dueForThis : 0n) > creditLimit;

  function handleScan(value: string) {
    setScannerOpen(false);
    const q = value.trim().toLowerCase();
    const product = (data?.products ?? []).find(
      (p) => (p.barcode ?? "").toLowerCase() === q || p.sku.toLowerCase() === q,
    );
    if (product) {
      playBarcodeBeep();
      addProduct(product);
      setMessage(`أضيف ${product.name}`);
      setTimeout(() => setMessage(null), 2000);
    } else {
      setSearch(value);
      setError("لم يتم العثور على منتج بهذا الباركود");
    }
  }

  function handleKeyboardBarcode(value: string) {
    const code = value.trim();
    if (!code) return;
    const now = Date.now();
    if (lastBarcodeRef.current.value === code && now - lastBarcodeRef.current.at < 700) return;
    lastBarcodeRef.current = { value: code, at: now };
    const product = (data?.products ?? []).find((p) => (p.barcode ?? "").trim() === code);
    if (!product) {
      setError(`لم يتم العثور على منتج بالباركود: ${code}`);
      return;
    }
    playBarcodeBeep();
    addProduct(product);
    setError(null);
    setMessage(`أضيف ${product.name}`);
    window.setTimeout(() => setMessage(null), 1800);
    if (barcodeInputRef.current) barcodeInputRef.current.value = "";
    window.requestAnimationFrame(() => barcodeInputRef.current?.focus());
  }

  function stockLines(lines: CartLine[]) {
    return lines.map((line) => ({
      productId: line.productId,
      qtyBaseMilli: lineBaseQty(line),
    }));
  }

  function addProduct(product: PosProduct, unitId?: string) {
    const units = product.units;
    if (!units.length) return;
    const unit = units.find((u) => u.unitId === unitId) ?? units.find((u) => u.isBase) ?? units[0];
    const available = stockByProduct.get(product.id) ?? 0n;
    if (available <= 0n) {
      setError(POS_STOCK_MESSAGES.outOfStock);
      return;
    }

    const unitBase = BigInt(unit.factorMilli);
    const prev = cartRef.current;
    const inCart = baseQtyInCart(stockLines(prev), product.id);
    const remaining = available - inCart;
    if (remaining < unitBase) {
      setError(remainingMessage(remaining));
      return;
    }

    const tier: "retail" | "wholesale" = "retail";
    const priceMinor = unitPrice(product, unit, tier);
    const key = `${product.id}:${unit.unitId}`;
    const existing = prev.find((l) => l.key === key);
    const next = existing
      ? prev.map((l) =>
          l.key === key ? { ...l, qty: increment(l.qty, unit.allowFraction) } : l,
        )
      : [
          ...prev,
          {
            key,
            productId: product.id,
            productName: product.name,
            unitId: unit.unitId,
            unitName: unit.unitName,
            factorMilli: unit.factorMilli,
            qty: "1",
            price: moneyToInput(priceMinor),
            priceTier: tier,
            allowFraction: unit.allowFraction,
          },
        ];
    commitCart(next);
    setSearch("");
    setError(null);
    setMessage(null);
  }

  function increment(qty: string, allowFraction: boolean): string {
    const parsed = parseQtySafe(qty) ?? 0n;
    const next = parsed + 1000n;
    return allowFraction ? qtyToInput(next) : String(next / 1000n);
  }

  function incrementLine(line: CartLine) {
    const available = stockByProduct.get(line.productId) ?? 0n;
    const prev = cartRef.current;
    const inCart = baseQtyInCart(stockLines(prev), line.productId);
    const remaining = available - inCart;
    if (remaining < BigInt(line.factorMilli)) {
      setError(remainingMessage(remaining));
      return;
    }
    commitCart(
      prev.map((l) =>
        l.key === line.key ? { ...l, qty: increment(l.qty, l.allowFraction) } : l,
      ),
    );
    setError(null);
  }

  function decrementLine(line: CartLine) {
    const prev = cartRef.current;
    const parsed = parseQtySafe(line.qty) ?? 0n;
    const next = parsed - 1000n > 0n ? parsed - 1000n : 0n;
    if (next === 0n) {
      commitCart(prev.filter((l) => l.key !== line.key));
      return;
    }
    commitCart(
      prev.map((l) =>
        l.key === line.key
          ? { ...l, qty: l.allowFraction ? qtyToInput(next) : String(next / 1000n) }
          : l,
      ),
    );
  }

  function changeQty(line: CartLine, value: string) {
    const prev = cartRef.current;
    if (value.trim() === "") {
      commitCart(prev.map((l) => (l.key === line.key ? { ...l, qty: value } : l)));
      return;
    }
    const qty = parseQtySafe(value);
    if (qty === null) {
      setError(POS_STOCK_MESSAGES.invalidQty);
      return;
    }
    if (!line.allowFraction && qty % 1000n !== 0n) {
      setError(POS_STOCK_MESSAGES.fractionNotAllowed);
      return;
    }
    const base = toBaseQtySafe(qty, BigInt(line.factorMilli));
    if (base === null) {
      setError(POS_STOCK_MESSAGES.invalidQty);
      return;
    }
    const others = prev.filter((l) => l.key !== line.key);
    const otherBase = baseQtyInCart(stockLines(others), line.productId);
    const available = stockByProduct.get(line.productId) ?? 0n;
    if (otherBase + base > available) {
      setError(remainingMessage(available - otherBase));
      return;
    }
    commitCart(prev.map((l) => (l.key === line.key ? { ...l, qty: value } : l)));
    setError(null);
  }

  function removeLine(key: string) {
    commitCart(cartRef.current.filter((line) => line.key !== key));
  }

  function clearCart() {
    commitCart([]);
  }

  function changeUnit(line: CartLine, unitId: string) {
    const product = data?.products.find((p) => p.id === line.productId);
    const unit = product?.units.find((u) => u.unitId === unitId);
    if (!unit) return;

    const prev = cartRef.current;
    const newKey = `${line.productId}:${unit.unitId}`;
    if (prev.some((l) => l.key === newKey && l.key !== line.key)) {
      setError("هذه الوحدة مضافة بالفعل في السلة");
      return;
    }
    const qty = parseQtySafe(line.qty) ?? 0n;
    if (!unit.allowFraction && qty % 1000n !== 0n) {
      setError(POS_STOCK_MESSAGES.fractionNotAllowed);
      return;
    }
    const base = toBaseQtySafe(qty, BigInt(unit.factorMilli));
    if (base === null) {
      setError(POS_STOCK_MESSAGES.invalidQty);
      return;
    }
    const others = prev.filter((l) => l.key !== line.key);
    const otherBase = baseQtyInCart(stockLines(others), line.productId);
    const available = stockByProduct.get(line.productId) ?? 0n;
    if (otherBase + base > available) {
      setError(remainingMessage(available - otherBase));
      return;
    }

    const price = product ? unitPrice(product, unit, line.priceTier) : 0n;
    commitCart(
      prev.map((l) =>
        l.key === line.key
          ? {
              ...l,
              key: newKey,
              unitId: unit.unitId,
              unitName: unit.unitName,
              factorMilli: unit.factorMilli,
              allowFraction: unit.allowFraction,
              price: moneyToInput(price),
            }
          : l,
      ),
    );
    setError(null);
  }

  function resetSale() {
    commitCart([]);
    setCustomerId("");
    setPaymentType("cash");
    setPaid("");
    setDiscount("");
    setNotes("");
  }

  async function submit() {
    const lines = cartRef.current;
    if (!lines.length) {
      setError("أضف منتجاً واحداً على الأقل");
      return;
    }
    setError(null);
    setMessage(null);

    const requested = new Map<string, bigint>();
    for (const line of lines) {
      const base = lineBaseQtyOrNull(line);
      if (base === null || base <= 0n) {
        setError("تحقق من الكميات المدخلة قبل إتمام البيع");
        return;
      }
      requested.set(line.productId, (requested.get(line.productId) ?? 0n) + base);
    }
    for (const [productId, qty] of requested) {
      const available = stockByProduct.get(productId) ?? 0n;
      if (qty > available) {
        setError(remainingMessage(available));
        void load({ keepError: true });
        return;
      }
    }

    const baseQty = lines.reduce((sum, line) => sum + lineBaseQty(line), 0n);
    const limit = data ? BigInt(data.business.offlineSellLimitMilli || "0") : 0n;
    const online = typeof navigator === "undefined" ? true : navigator.onLine;
    if (!online && limit > 0n && baseQty > limit) {
      setError("تجاوزت كمية البيع المسموحة دون اتصال. اتصل بالإنترنت لإتمام هذه الفاتورة.");
      return;
    }
    if (paymentType === "credit" && !customerId) {
      setError("البيع الآجل يتطلب اختيار عميل");
      return;
    }
    if (paymentType === "mixed") {
      const paidMinor = parseMoney(paid || "0");
      if (paidMinor < 0n || paidMinor > total) {
        setError("المبلغ المدفوع غير صالح");
        return;
      }
      if (!customerId && paidMinor < total) {
        setError("المتبقي يتطلب اختيار عميل");
        return;
      }
    }

    setSubmitting(true);
    const key = idempotencyKey("sale");
    const payload = {
      kind: "sale",
      customerId: customerId || null,
      warehouseId: data?.warehouse?.id ?? undefined,
      cashboxId: cashboxId || null,
      items: lines.map((line) => ({
        productId: line.productId,
        unitId: line.unitId,
        qty: line.qty,
        unitPrice: line.price,
        priceTier: line.priceTier,
      })),
      discount: canDiscount && discount ? discount : undefined,
      paymentType,
      paid:
        paymentType === "cash"
          ? moneyToInput(total)
          : paymentType === "credit"
            ? "0"
            : paid,
      notes: notes || undefined,
      idempotencyKey: key,
      clientUuid: key,
      offline: !online,
      occurredAt: new Date().toISOString(),
    };

    try {
      if (!online) {
        const deltas = lines.map((line) => ({
          productId: line.productId,
          qtyBaseMilli: lineBaseQty(line).toString(),
        }));
        await queueSale({ ...payload, __totalMinor: total.toString() }, deltas);
        const cached = await readCachedPosData();
        const cachedById = new Map(cached.products.map((product) => [product.id, product]));
        setData((prev) =>
          prev
            ? {
                ...prev,
                products: prev.products.map((product) => cachedById.get(product.id) ?? product),
              }
            : prev,
        );
        setMessage(`تم حفظ الفاتورة محلياً (${formatMoney(total)} ر.ي) وستُزامن عند عودة الاتصال.`);
        setPending(await pendingSales());
        resetSale();
        return;
      }

      const result = await api<{ sale: { id: string; invoiceNo: string; totalMinor: string; dueMinor: string; customer?: { name: string } | null }; creditWarning: unknown; duplicate: boolean }>(
        "/api/sales",
        { method: "POST", body: JSON.stringify(payload) },
      );
      await decrementCachedStock(
        lines.map((line) => ({
          productId: line.productId,
          qtyBaseMilli: lineBaseQty(line).toString(),
        })),
      );
      setLastSale({
        id: result.sale.id,
        invoiceNo: result.sale.invoiceNo,
        totalMinor: result.sale.totalMinor,
        dueMinor: result.sale.dueMinor,
        customerName: result.sale.customer?.name ?? null,
      });
      resetSale();
      void load();
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiRequestError && err.code === "insufficient_stock") {
        void load({ keepError: true });
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function submitPending() {
    try {
      const result = await syncPending();
      setPending(await pendingSales());
      setMessage(
        result.failed
          ? `تمت مزامنة ${result.done} فاتورة، وفشل ${result.failed}${result.conflicts ? `، وتوجد ${result.conflicts} عملية متعارضة للمراجعة` : ""}`
          : result.conflicts
            ? `تمت مزامنة ${result.done} فاتورة، وتوجد ${result.conflicts} عملية متعارضة للمراجعة`
          : `تمت مزامنة ${result.done} فاتورة بنجاح`,
      );
      if (result.done) void load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function retryFailed() {
    try {
      await retryFailedSales();
      await submitPending();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-ink-500">
        جارٍ تحميل نقطة البيع...
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="space-y-3">
        <Alert tone="danger">{error}</Alert>
        <Button onClick={() => void load()}>
          <RefreshCw className="h-4 w-4" /> إعادة المحاولة
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">نقطة البيع</h1>
          <p className="text-xs text-ink-500">
            {data?.warehouse?.name ? `المخزن: ${data.warehouse.name}` : "وضع دون اتصال"}
            {offlineData
              ? ` — المخزون حسب آخر مزامنة${
                  cachedAt ? `: ${new Date(cachedAt).toLocaleString("ar")}` : ""
                }`
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {offlineData ? (
            <Badge tone="warning">
              <WifiOff className="ml-1 h-3 w-3" /> دون اتصال
            </Badge>
          ) : (
            <Badge tone="success">متصل</Badge>
          )}
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" /> تحديث
          </Button>
        </div>
      </div>

      {pending.length ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-warn">
          <span>
              {pending.filter((p) => p.status === "pending" || p.status === "syncing").length} فاتورة بانتظار المزامنة
              {pending.some((p) => p.status === "failed") ? ` — ${pending.filter((p) => p.status === "failed").length} فشل` : ""}
              {pending.some((p) => p.status === "conflict") ? ` — ${pending.filter((p) => p.status === "conflict").length} تعارض يحتاج مراجعة` : ""}
            </span>
            <div className="flex gap-2">
              {pending.some((p) => p.status === "failed") ? (
                <Button size="sm" variant="secondary" onClick={retryFailed}>
                  إعادة محاولة الفاشلة
                </Button>
              ) : null}
              <Button size="sm" variant="secondary" onClick={submitPending}>
                مزامنة الآن
              </Button>
            </div>
        </div>
      ) : null}

      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {creditWarning ? (
        <Alert tone="warning">
          <span className="inline-flex items-center gap-1">
            <AlertTriangle className="h-4 w-4" /> العميل تجاوز حد الائتمان: مستحق{" "}
            {formatMoney(customerDue)} والحد {formatMoney(creditLimit)} ر.ي
          </span>
        </Alert>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <section className="space-y-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-ink-400" />
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const exact = (data?.products ?? []).find(
                      (p) =>
                        p.sku.toLowerCase() === search.trim().toLowerCase() ||
                        (p.barcode ?? "").toLowerCase() === search.trim().toLowerCase(),
                    );
                    if (exact) addProduct(exact);
                  }
                }}
                className="input pr-9"
                placeholder="ابحث بالاسم أو الباركود أو SKU..."
              />
            </div>
            <Button variant="secondary" onClick={() => { unlockBarcodeAudio(); setScannerOpen(true); }} aria-label="مسح بالكاميرا">
              <Barcode className="h-4 w-4" />
              <span>مسح بالكاميرا</span>
            </Button>
          </div>
          <div className="flex gap-2">
            <input
              ref={barcodeInputRef}
              className="input flex-1"
              aria-label="قارئ الباركود"
              placeholder="قارئ الباركود — امسح الرمز هنا"
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (barcodeTimerRef.current) clearTimeout(barcodeTimerRef.current);
                if (value.trim().length >= 4) {
                  barcodeTimerRef.current = setTimeout(() => handleKeyboardBarcode(value), 250);
                }
              }}
              onKeyDown={(event) => {
                unlockBarcodeAudio();
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (barcodeTimerRef.current) clearTimeout(barcodeTimerRef.current);
                  handleKeyboardBarcode(event.currentTarget.value);
                }
              }}
            />
          </div>

          <div className="flex gap-1.5 overflow-x-auto pb-1">
            <button
              type="button"
              onClick={() => setCategory("all")}
              className={`shrink-0 rounded-full px-3 py-1 text-xs ${category === "all" ? "bg-brand-600 text-white" : "bg-white text-ink-600 border border-ink-200"}`}
            >
              الكل
            </button>
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={`shrink-0 rounded-full px-3 py-1 text-xs ${category === c ? "bg-brand-600 text-white" : "bg-white text-ink-600 border border-ink-200"}`}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-4">
            {filtered.map((product) => {
              const available = stockByProduct.get(product.id) ?? 0n;
              const inCart = cartBaseByProduct.get(product.id) ?? 0n;
              const stock = productStock(available, inCart);
              const out = available <= 0n;
              const low = isLowStock(available, BigInt(product.minStockMilli || "0"));
              const baseName = baseUnitNameByProduct.get(product.id) ?? "";
              return (
                <button
                  key={product.id}
                  type="button"
                  disabled={out}
                  onClick={() => addProduct(product)}
                  className="rounded-xl border border-ink-200 bg-white p-3 text-right transition hover:border-brand-300 hover:shadow-card disabled:opacity-50"
                >
                  <p className="line-clamp-2 min-h-[2.5rem] text-sm font-medium">{product.name}</p>
                  <p className="mt-1 text-[11px] text-ink-400" dir="ltr">
                    {product.sku}
                  </p>
                  <div className="mt-2 space-y-0.5 text-[11px]">
                    <p className="text-ink-500">
                      المخزون المتوفر:{" "}
                      <span className="tabular-nums" dir="ltr">
                        {stockLabel(available, baseName)}
                      </span>
                    </p>
                    {inCart > 0n ? (
                      <p className="text-ink-500">
                        في السلة:{" "}
                        <span className="tabular-nums" dir="ltr">
                          {stockLabel(inCart, baseName)}
                        </span>
                      </p>
                    ) : null}
                    {out ? (
                      <p className="font-medium text-danger">{POS_STOCK_MESSAGES.outOfStockShort}</p>
                    ) : low ? (
                      <p className="font-medium text-warn">{POS_STOCK_MESSAGES.lowStock}</p>
                    ) : null}
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-brand-700" dir="ltr">
                      {formatMoney(BigInt(product.retailPriceMinor))}
                    </span>
                    <span className={`text-[11px] ${out ? "text-danger" : "text-ink-500"}`}>
                      المتبقي:{" "}
                      <span className="tabular-nums" dir="ltr">
                        {formatQty(stock.remainingBaseMilli)}
                      </span>
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
          {!filtered.length ? (
            <div className="rounded-xl border border-dashed border-ink-300 bg-white py-10 text-center text-sm text-ink-500">
              لا توجد منتجات مطابقة
            </div>
          ) : null}
        </section>

        <section className="space-y-3 xl:sticky xl:top-20 xl:self-start">
          <div className="rounded-2xl border border-ink-200 bg-white shadow-card">
            <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
              <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold">
                <ShoppingCart className="h-4 w-4" /> السلة
                <span className="rounded-full bg-brand-50 px-2 text-[11px] text-brand-700">
                  {cart.length}
                </span>
              </h2>
              {cart.length ? (
                <button
                  type="button"
                  onClick={clearCart}
                  className="text-xs text-danger hover:underline"
                >
                  تفريغ
                </button>
              ) : null}
            </div>

            <div className="max-h-64 space-y-2 overflow-y-auto p-3 xl:max-h-72">
              {cart.map((line) => {
                const available = stockByProduct.get(line.productId) ?? 0n;
                const inCart = cartBaseByProduct.get(line.productId) ?? 0n;
                const stock = productStock(available, inCart);
                const baseName = baseUnitNameByProduct.get(line.productId) ?? "";
                const unitFactor = BigInt(line.factorMilli);
                const maxed = stock.remainingBaseMilli < unitFactor;
                return (
                  <div key={line.key} className="rounded-lg border border-ink-100 bg-ink-50/50 p-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium">{line.productName}</p>
                        <p className="text-[11px] text-ink-500">{line.unitName}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeLine(line.key)}
                        className="text-ink-400 hover:text-danger"
                        aria-label="حذف"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <div className="flex items-center rounded-lg border border-ink-200 bg-white">
                        <button
                          type="button"
                          className="px-2 py-1 text-ink-600"
                          onClick={() => decrementLine(line)}
                          aria-label="تقليل الكمية"
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <input
                          value={line.qty}
                          onChange={(e) => changeQty(line, e.target.value)}
                          className="w-12 border-x border-ink-100 py-1 text-center text-xs outline-none"
                          inputMode="decimal"
                          dir="ltr"
                        />
                        <button
                          type="button"
                          className="px-2 py-1 text-ink-600 disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() => incrementLine(line)}
                          disabled={maxed}
                          aria-label="زيادة الكمية"
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>
                      <select
                        value={line.unitId}
                        onChange={(e) => changeUnit(line, e.target.value)}
                        className="rounded-lg border border-ink-200 bg-white px-1.5 py-1 text-[11px]"
                      >
                        {data?.products
                          .find((p) => p.id === line.productId)
                          ?.units.map((u) => (
                            <option key={u.unitId} value={u.unitId}>
                              {u.unitName}
                            </option>
                          ))}
                      </select>
                      <input
                        value={line.price}
                        disabled={!canCustomPrice}
                        onChange={(e) => {
                          const price = e.target.value;
                          commitCart(
                            cartRef.current.map((l) =>
                              l.key === line.key ? { ...l, price } : l,
                            ),
                          );
                        }}
                        className="w-16 rounded-lg border border-ink-200 bg-white px-1.5 py-1 text-center text-xs disabled:bg-ink-50"
                        inputMode="decimal"
                        dir="ltr"
                      />
                      <span className="mr-auto shrink-0 text-xs font-semibold tabular-nums" dir="ltr">
                        {formatMoney(lineTotal(line))}
                      </span>
                    </div>
                    <div className="mt-1 space-y-0.5 text-[11px] text-ink-500">
                      <p>
                        المخزون المتوفر:{" "}
                        <span className="tabular-nums" dir="ltr">
                          {stockLabel(stock.availableBaseMilli, baseName)}
                        </span>
                      </p>
                      <p>
                        الكمية في السلة:{" "}
                        <span className="tabular-nums" dir="ltr">
                          {stockLabel(stock.inCartBaseMilli, baseName)}
                        </span>
                      </p>
                      <p
                        className={
                          stock.remainingBaseMilli === 0n
                            ? "font-medium text-danger"
                            : "text-ink-600"
                        }
                      >
                        المتبقي:{" "}
                        <span className="tabular-nums" dir="ltr">
                          {stockWithUnitConversion(
                            stock.remainingBaseMilli,
                            unitFactor,
                            line.unitName,
                            baseName,
                          )}
                        </span>
                      </p>
                      {stock.remainingBaseMilli === 0n ? (
                        <p className="font-medium text-danger">{POS_STOCK_MESSAGES.outOfStockShort}</p>
                      ) : maxed ? (
                        <p className="font-medium text-warn">وصلت للحد الأقصى المتاح</p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {!cart.length ? (
                <p className="py-8 text-center text-xs text-ink-500">
                  اختر منتجاً من القائمة أو امسح الباركود
                </p>
              ) : null}
            </div>

            <div className="space-y-2 border-t border-ink-100 p-3">
              <div className="grid grid-cols-2 gap-2">
                <Field label="العميل">
                  <select
                    value={customerId}
                    onChange={(e) => setCustomerId(e.target.value)}
                    className="input py-1.5 text-xs"
                  >
                    <option value="">عميل نقدي</option>
                    {data?.customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="الصندوق">
                  <select
                    value={cashboxId}
                    onChange={(e) => setCashboxId(e.target.value)}
                    className="input py-1.5 text-xs"
                  >
                    {data?.cashboxes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                    {!data?.cashboxes.length ? <option value="">افتراضي</option> : null}
                  </select>
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Field label="طريقة الدفع">
                  <select
                    value={paymentType}
                    onChange={(e) => setPaymentType(e.target.value as "cash" | "credit" | "mixed")}
                    className="input py-1.5 text-xs"
                  >
                    <option value="cash">نقدي</option>
                    <option value="credit">آجل</option>
                    <option value="mixed">مختلط</option>
                  </select>
                </Field>
                {paymentType === "mixed" ? (
                  <Field label="المدفوع">
                    <input
                      value={paid}
                      onChange={(e) => setPaid(e.target.value)}
                      className="input py-1.5 text-xs"
                      inputMode="decimal"
                      dir="ltr"
                    />
                  </Field>
                ) : canDiscount ? (
                  <Field label="خصم (ر.ي)">
                    <input
                      value={discount}
                      onChange={(e) => setDiscount(e.target.value)}
                      className="input py-1.5 text-xs"
                      inputMode="decimal"
                      dir="ltr"
                    />
                  </Field>
                ) : (
                  <div />
                )}
              </div>

              <div className="space-y-1 rounded-lg bg-ink-50 px-3 py-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-ink-500">المجموع</span>
                  <span className="tabular-nums" dir="ltr">
                    {formatMoney(subtotal)}
                  </span>
                </div>
                {discountMinor > 0n ? (
                  <div className="flex justify-between text-danger">
                    <span>الخصم</span>
                    <span className="tabular-nums" dir="ltr">
                      -{formatMoney(discountMinor)}
                    </span>
                  </div>
                ) : null}
                {taxMinor > 0n ? (
                  <div className="flex justify-between">
                    <span className="text-ink-500">
                      الضريبة ({data?.business.taxRateBp ? data.business.taxRateBp / 100 : 0}%)
                    </span>
                    <span className="tabular-nums" dir="ltr">
                      {formatMoney(taxMinor)}
                    </span>
                  </div>
                ) : null}
                <div className="flex justify-between border-t border-ink-200 pt-1 text-sm font-bold">
                  <span>الإجمالي</span>
                  <span className="tabular-nums" dir="ltr">
                    {formatMoney(total)} ر.ي
                  </span>
                </div>
                {dueForThis > 0n ? (
                  <div className="flex justify-between text-warn">
                    <span>المتبقي</span>
                    <span className="tabular-nums" dir="ltr">
                      {formatMoney(dueForThis)}
                    </span>
                  </div>
                ) : null}
              </div>

              <Button
                className="w-full py-3"
                size="lg"
                loading={submitting}
                onClick={submit}
                disabled={!cart.length}
              >
                {offlineData ? "حفظ الفاتورة محلياً" : "إتمام البيع"}
              </Button>
            </div>
          </div>

          {pending.some((p) => p.status === "failed") ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-danger">
              <p className="font-medium">فواتير فشلت مزامنتها:</p>
              <ul className="mt-1 space-y-1">
                {pending
                  .filter((p) => p.status === "failed")
                  .map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-2">
                      <span>{p.error ?? "خطأ"}</span>
                      <button
                        type="button"
                        className="underline"
                        onClick={async () => {
                          await markPendingFailed(p.id, p.error ?? "");
                          await submitPending();
                        }}
                      >
                        إعادة محاولة
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
        </section>
      </div>

      <Modal open={scannerOpen} onClose={() => setScannerOpen(false)} title="مسح باركود">
        {scannerOpen ? (
          <BarcodeScanner onDetected={handleScan} onClose={() => setScannerOpen(false)} />
        ) : null}
      </Modal>

      <Modal
        open={Boolean(lastSale)}
        onClose={() => setLastSale(null)}
        title="تم إتمام البيع"
        footer={
          <>
            <Link href="/invoices" className="rounded-lg border border-ink-200 px-3 py-2 text-sm">
              الفواتير
            </Link>
            <a
              href={lastSale ? `/api/pdf?type=sale&id=${lastSale.id}` : "#"}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg bg-brand-600 px-3 py-2 text-sm text-white"
            >
              طباعة الفاتورة
            </a>
          </>
        }
      >
        {lastSale ? (
          <div className="space-y-2 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-ok" />
            <p className="text-lg font-bold">{lastSale.invoiceNo}</p>
            <p className="text-sm text-ink-500">
              الإجمالي: <span dir="ltr">{formatMoney(BigInt(lastSale.totalMinor))}</span> ر.ي
            </p>
            {BigInt(lastSale.dueMinor) > 0n ? (
              <p className="text-sm text-warn">
                المتبقي: <span dir="ltr">{formatMoney(BigInt(lastSale.dueMinor))}</span> ر.ي
              </p>
            ) : null}
            <Button variant="secondary" className="mt-2 w-full" onClick={() => setLastSale(null)}>
              بيع جديد
            </Button>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
