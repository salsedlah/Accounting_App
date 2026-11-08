"use client";

import Dexie, { type EntityTable } from "dexie";
import { postJson } from "@/lib/client/api";
import { retryAt } from "@/lib/offline/retry";
import { parseQty, toBaseQty } from "@/lib/quantity";

export type CachedUnit = {
  unitId: string;
  unitName: string;
  factorMilli: string;
  isBase: boolean;
  retailPriceMinor: string | null;
  wholesalePriceMinor: string | null;
  allowFraction: boolean;
  sortOrder: number;
};

export type CachedProduct = {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  retailPriceMinor: string;
  wholesalePriceMinor: string;
  minStockMilli: string;
  qtyMilli: string;
  baseUnitName?: string | null;
  units: CachedUnit[];
};

export type CachedCustomer = {
  id: string;
  name: string;
  phone: string | null;
  balanceMinor: string;
  creditLimitMinor: string;
};

export type OfflineOperationType =
  | "sale.create"
  | "purchase.create"
  | "expense.create"
  | "payment.create"
  | "customer.create"
  | "supplier.create"
  | "product.create"
  | "debt.create"
  | "inventory.adjust"
  | "cashbox.manual"
  | "stocktaking.create";

export type PendingSale = {
  id: string;
  scope?: string;
  businessId?: string;
  userId?: string;
  deviceId?: string;
  operationType?: OfflineOperationType;
  entityId?: string;
  idempotencyKey?: string;
  payload: Record<string, unknown>;
  totalMinor: string;
  createdAt: string;
  status: "pending" | "syncing" | "failed" | "conflict";
  retryCount: number;
  nextRetryAt: number;
  stockDeltas?: Array<{ productId: string; qtyBaseMilli: string }>;
  lastAttemptAt?: string;
  error?: string;
};

type Meta = { key: string; value: string };
type CachedPosSettings = {
  warehouse: { id: string; name: string } | null;
  cashboxes: Array<{ id: string; name: string; expectedBalanceMinor: string; isDefault: boolean }>;
  business: {
    currency: string;
    taxEnabled: boolean;
    taxRateBp: number;
    offlineSellLimitMilli: string;
  };
};
type CachedApiResponse = {
  key: string;
  scope: string;
  url: string;
  data: unknown;
  savedAt: string;
  size: number;
};

let activeOfflineScope: string | null = null;

class OfflineDb extends Dexie {
  products!: EntityTable<CachedProduct, "id">;
  customers!: EntityTable<CachedCustomer, "id">;
  pendingSales!: EntityTable<PendingSale, "id">;
  meta!: EntityTable<Meta, "key">;
  apiCache!: EntityTable<CachedApiResponse, "key">;

  constructor() {
    super("hisab-offline");
    this.version(1).stores({
      products: "id, sku, barcode, name",
      customers: "id, name, phone",
      pendingSales: "id, status, createdAt",
      meta: "key",
    });
    this.version(2).stores({
      products: "id, sku, barcode, name",
      customers: "id, name, phone",
      pendingSales: "id, status, createdAt, nextRetryAt",
      meta: "key",
    }).upgrade(async (transaction) => {
      await transaction.table("pendingSales").toCollection().modify((sale: PendingSale) => {
        sale.status = sale.status === "failed" ? "failed" : "pending";
        sale.retryCount = sale.retryCount ?? 0;
        sale.nextRetryAt = sale.nextRetryAt ?? 0;
      });
    });
    this.version(3).stores({
      products: "id, sku, barcode, name",
      customers: "id, name, phone",
      pendingSales: "id, status, createdAt, nextRetryAt",
      meta: "key",
      apiCache: "key, scope, url, savedAt",
    });
    this.version(4).stores({
      products: "id, sku, barcode, name",
      customers: "id, name, phone",
      pendingSales: "id, scope, status, createdAt, nextRetryAt, [scope+status]",
      meta: "key",
      apiCache: "key, scope, url, savedAt",
    }).upgrade(async (transaction) => {
      const savedScope = await transaction.table("meta").get("offlineScope") as Meta | undefined;
      await transaction.table("pendingSales").toCollection().modify((sale: PendingSale) => {
        sale.scope = sale.scope ?? savedScope?.value ?? "__unassigned__";
        sale.businessId = sale.businessId ?? sale.scope.split(":")[0];
        sale.userId = sale.userId ?? sale.scope.split(":")[1];
        sale.operationType = "sale.create";
        sale.entityId = sale.entityId ?? sale.id;
        sale.idempotencyKey = sale.idempotencyKey ?? sale.id;
      });
    });
  }
}

let instance: OfflineDb | null = null;

export function offlineDb(): OfflineDb {
  if (!instance) instance = new OfflineDb();
  return instance;
}

export async function setOfflineScope(scope: string): Promise<void> {
  if (!scope) throw new Error("تعذر تحديد مساحة بيانات الجهاز");
  activeOfflineScope = scope;
  const db = offlineDb();
  const previous = await db.meta.get("offlineScope");
  if (previous?.value && previous.value !== scope) {
    await db.transaction("rw", db.products, db.customers, db.apiCache, db.meta, async () => {
      await Promise.all([
        db.products.clear(),
        db.customers.clear(),
        db.apiCache.clear(),
        db.meta.delete("cachedAt"),
        db.meta.delete("cachedPosSettings"),
      ]);
    });
  }
  await db.meta.put({ key: "offlineScope", value: scope });
}

async function getOfflineScope(): Promise<string | null> {
  if (activeOfflineScope) return activeOfflineScope;
  activeOfflineScope = (await offlineDb().meta.get("offlineScope"))?.value ?? null;
  return activeOfflineScope;
}

export async function cacheApiResponse(url: string, data: unknown): Promise<void> {
  const scope = await getOfflineScope();
  if (!scope) return;
  const serialized = JSON.stringify(data);
  const size = new Blob([serialized]).size;
  if (size > 2_000_000) return;
  const key = `${scope}:${url}`;
  await offlineDb().apiCache.put({
    key,
    scope,
    url,
    data,
    savedAt: new Date().toISOString(),
    size,
  });
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await offlineDb().apiCache.where("savedAt").below(cutoff).delete();
  const count = await offlineDb().apiCache.count();
  if (count > 1_000) {
    const oldest = await offlineDb().apiCache.orderBy("savedAt").limit(count - 1_000).primaryKeys();
    await offlineDb().apiCache.bulkDelete(oldest);
  }
}

export async function readCachedApiResponse<T>(url: string): Promise<T | null> {
  const scope = await getOfflineScope();
  if (!scope) return null;
  const entry = await offlineDb().apiCache.get(`${scope}:${url}`);
  return entry ? (entry.data as T) : null;
}

export async function cachePosData(data: {
  products: CachedProduct[];
  customers: CachedCustomer[];
  settings?: CachedPosSettings;
}) {
  const db = offlineDb();
  const scope = await getOfflineScope();
  if (!scope) throw new Error("تعذر تحديد النشاط لحفظ بيانات نقطة البيع على الجهاز");
  await db.transaction("rw", db.products, db.customers, db.pendingSales, db.meta, async () => {
    const products = new Map(data.products.map((product) => [product.id, { ...product }]));
    const pending = await db.pendingSales.where("scope").equals(scope).toArray();
    const reserved = new Map<string, bigint>();
    for (const sale of pending) {
      const deltas = sale.stockDeltas?.length ? sale.stockDeltas : saleStockDeltas(sale, products);
      for (const delta of deltas) {
        reserved.set(
          delta.productId,
          (reserved.get(delta.productId) ?? 0n) + BigInt(delta.qtyBaseMilli),
        );
      }
    }
    for (const [productId, quantity] of reserved) {
      const product = products.get(productId);
      if (product) product.qtyMilli = (BigInt(product.qtyMilli) - quantity).toString();
    }
    await db.products.clear();
    await db.customers.clear();
    await db.products.bulkPut([...products.values()]);
    await db.customers.bulkPut(data.customers);
    await db.meta.put({ key: "cachedAt", value: new Date().toISOString() });
    if (data.settings) {
      await db.meta.put({ key: "cachedPosSettings", value: JSON.stringify(data.settings) });
    }
  });
}

function saleStockDeltas(
  sale: PendingSale,
  products: Map<string, CachedProduct>,
): Array<{ productId: string; qtyBaseMilli: string }> {
  const lines = sale.payload.items;
  if (!Array.isArray(lines)) return [];
  const totals = new Map<string, bigint>();
  for (const value of lines) {
    if (!value || typeof value !== "object") continue;
    const line = value as { productId?: unknown; unitId?: unknown; qty?: unknown };
    if (typeof line.productId !== "string" || typeof line.unitId !== "string" || typeof line.qty !== "string") {
      continue;
    }
    const product = products.get(line.productId);
    const unit = product?.units.find((candidate) => candidate.unitId === line.unitId);
    if (!unit) continue;
    const quantity = toBaseQty(parseQty(line.qty), BigInt(unit.factorMilli));
    totals.set(line.productId, (totals.get(line.productId) ?? 0n) + quantity);
  }
  return [...totals].map(([productId, qty]) => ({
    productId,
    qtyBaseMilli: qty.toString(),
  }));
}

export async function readCachedPosData(): Promise<{
  products: CachedProduct[];
  customers: CachedCustomer[];
  cachedAt: string | null;
  settings: CachedPosSettings | null;
}> {
  const db = offlineDb();
  const [products, customers, cachedAt, settings] = await Promise.all([
    db.products.toArray(),
    db.customers.toArray(),
    db.meta.get("cachedAt"),
    db.meta.get("cachedPosSettings"),
  ]);
  return {
    products,
    customers,
    cachedAt: cachedAt?.value ?? null,
    settings: settings ? JSON.parse(settings.value) as CachedPosSettings : null,
  };
}

export async function decrementCachedStock(lines: Array<{ productId: string; qtyBaseMilli: string }>) {
  const db = offlineDb();
  await db.transaction("rw", db.products, async () => {
    for (const line of lines) {
      const product = await db.products.get(line.productId);
      if (!product) continue;
      const next = BigInt(product.qtyMilli) - BigInt(line.qtyBaseMilli);
      await db.products.put({ ...product, qtyMilli: next.toString() });
    }
  });
}

export async function queueSale(
  payload: Record<string, unknown>,
  stockDeltas: Array<{ productId: string; qtyBaseMilli: string }> = [],
): Promise<PendingSale> {
  const db = offlineDb();
  const scope = await getOfflineScope();
  if (!scope || scope === "__unassigned__") throw new Error("اتصل بالإنترنت مرة واحدة لتجهيز قاعدة بيانات هذا النشاط على الجهاز");
  const [businessId, userId] = scope.split(":");
  const id = String(payload.idempotencyKey);
  if (!id || id === "undefined") throw new Error("تعذر حفظ الفاتورة دون معرّف فريد");
  const item: PendingSale = {
    id,
    scope,
    businessId,
    userId,
    deviceId: await deviceId(),
    operationType: "sale.create",
    entityId: id,
    idempotencyKey: id,
    payload,
    totalMinor:
      typeof payload.__totalMinor === "string" ? payload.__totalMinor : "0",
    createdAt: new Date().toISOString(),
    status: "pending",
    retryCount: 0,
    nextRetryAt: 0,
    stockDeltas: [],
  };
  const clean = { ...payload };
  delete clean.__totalMinor;
  item.payload = clean;
  return db.transaction("rw", db.pendingSales, db.products, async () => {
    const existing = await db.pendingSales.get(id);
    if (existing) {
      if (existing.scope !== scope) throw new Error("معرّف الفاتورة مستخدم في حساب آخر");
      return existing;
    }
    const quantities = new Map<string, bigint>();
    for (const delta of stockDeltas) {
      quantities.set(
        delta.productId,
        (quantities.get(delta.productId) ?? 0n) + BigInt(delta.qtyBaseMilli),
      );
    }
    item.stockDeltas = [...quantities].map(([productId, qty]) => ({
      productId,
      qtyBaseMilli: qty.toString(),
    }));
    const products = new Map<string, CachedProduct>();
    for (const [productId, quantity] of quantities) {
      const product = await db.products.get(productId);
      if (!product) throw new Error("الصنف غير موجود في البيانات المخزنة على الجهاز");
      const available = BigInt(product.qtyMilli);
      if (quantity <= 0n || quantity > available) {
        throw new Error(`الكمية المتاحة غير كافية للصنف ${product.name}`);
      }
      products.set(productId, product);
    }
    for (const [productId, quantity] of quantities) {
      const product = products.get(productId);
      if (!product) throw new Error("الصنف غير موجود في البيانات المخزنة على الجهاز");
      const next = BigInt(product.qtyMilli) - quantity;
      await db.products.put({ ...product, qtyMilli: next.toString() });
    }
    await db.pendingSales.add(item);
    return item;
  });
}

export async function queueOfflineOperation(
  operationType: Exclude<OfflineOperationType, "sale.create">,
  payload: Record<string, unknown>,
  totalMinor = "0",
): Promise<PendingSale> {
  const scope = await getOfflineScope();
  if (!scope || scope === "__unassigned__") {
    throw new Error("اتصل بالإنترنت مرة واحدة لتجهيز قاعدة بيانات هذا النشاط على الجهاز");
  }
  const [businessId, userId] = scope.split(":");
  const id = typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : "";
  if (id.length < 8 || id.length > 200) throw new Error("تعذر حفظ العملية دون معرّف فريد صالح");

  const item: PendingSale = {
    id,
    scope,
    businessId,
    userId,
    deviceId: await deviceId(),
    operationType,
    entityId: id,
    idempotencyKey: id,
    payload,
    totalMinor,
    createdAt: new Date().toISOString(),
    status: "pending",
    retryCount: 0,
    nextRetryAt: 0,
  };
  const db = offlineDb();
  return db.transaction("rw", db.pendingSales, async () => {
    const existing = await db.pendingSales.get(id);
    if (existing) {
      if (existing.scope !== scope || existing.operationType !== operationType) {
        throw new Error("معرّف العملية مستخدم في عملية أخرى");
      }
      return existing;
    }
    await db.pendingSales.add(item);
    return item;
  });
}

export async function pendingOperations(
  operationType: OfflineOperationType,
): Promise<PendingSale[]> {
  const scope = await getOfflineScope();
  if (!scope) return [];
  return (await offlineDb().pendingSales.where("scope").equals(scope).sortBy("createdAt"))
    .filter((item) => item.operationType === operationType);
}

export async function pendingSales(): Promise<PendingSale[]> {
  const scope = await getOfflineScope();
  if (!scope) return [];
  return offlineDb().pendingSales.where("scope").equals(scope).sortBy("createdAt");
}

export async function pendingCount(): Promise<number> {
  const scope = await getOfflineScope();
  if (!scope) return 0;
  return offlineDb().pendingSales.where("[scope+status]").anyOf(
    [scope, "pending"], [scope, "syncing"], [scope, "failed"], [scope, "conflict"],
  ).count();
}

export async function pendingSummary(): Promise<{
  pending: number;
  syncing: number;
  failed: number;
  conflicts: number;
  total: number;
}> {
  const scope = await getOfflineScope();
  if (!scope) return { pending: 0, syncing: 0, failed: 0, conflicts: 0, total: 0 };
  const table = offlineDb().pendingSales;
  const [pending, syncing, failed, conflicts] = await Promise.all([
    table.where("[scope+status]").equals([scope, "pending"]).count(),
    table.where("[scope+status]").equals([scope, "syncing"]).count(),
    table.where("[scope+status]").equals([scope, "failed"]).count(),
    table.where("[scope+status]").equals([scope, "conflict"]).count(),
  ]);
  return { pending, syncing, failed, conflicts, total: pending + syncing + failed + conflicts };
}

export async function lastSuccessfulSyncAt(): Promise<string | null> {
  return (await offlineDb().meta.get("lastSuccessfulSyncAt"))?.value ?? null;
}

export async function localStorageUsage(): Promise<number | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  const estimate = await navigator.storage.estimate();
  return estimate.usage ?? null;
}

export async function removePending(id: string) {
  const scope = await getOfflineScope();
  if (!scope) return;
  const db = offlineDb();
  const item = await db.pendingSales.get(id);
  if (item?.scope === scope) await db.pendingSales.delete(id);
}

export async function markPendingFailed(id: string, error: string) {
  const db = offlineDb();
  const scope = await getOfflineScope();
  if (!scope) return;
  const item = await db.pendingSales.get(id);
  if (item?.scope !== scope) return;
  if (item) {
    const retryCount = item.status === "syncing" ? item.retryCount : item.retryCount + 1;
    await db.pendingSales.put({
      ...item,
      retryCount,
      nextRetryAt: retryAt(retryCount),
      status: "failed",
      error,
    });
  }
}

export async function retryFailedSales(): Promise<number> {
  const db = offlineDb();
  const scope = await getOfflineScope();
  if (!scope) return 0;
  return db.transaction("rw", db.pendingSales, async () => {
    const failed = await db.pendingSales.where("[scope+status]").equals([scope, "failed"]).toArray();
    for (const item of failed) {
      await db.pendingSales.put({
        ...item,
        status: "pending",
        nextRetryAt: 0,
        error: undefined,
      });
    }
    return failed.length;
  });
}

async function deviceId(): Promise<string> {
  const db = offlineDb();
  const existing = await db.meta.get("deviceId");
  if (existing) return existing.value;
  const value = crypto.randomUUID();
  await db.meta.put({ key: "deviceId", value });
  return value;
}

let syncInFlight: Promise<{ done: number; failed: number; conflicts: number }> | null = null;

export function syncPending(): Promise<{ done: number; failed: number; conflicts: number }> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = performSync().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

async function performSync(): Promise<{ done: number; failed: number; conflicts: number }> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return { done: 0, failed: 0, conflicts: 0 };
  }
  const db = offlineDb();
  const scope = await getOfflineScope();
  if (!scope) return { done: 0, failed: 0, conflicts: 0 };
  await db.pendingSales.where("[scope+status]").equals([scope, "syncing"]).modify({ status: "pending" });
  const now = Date.now();
  const items = (await db.pendingSales
    .where("[scope+status]")
    .anyOf([scope, "pending"], [scope, "failed"])
    .toArray())
    .filter((item) => item.nextRetryAt <= now);
  if (!items.length) return { done: 0, failed: 0, conflicts: 0 };
  const attemptAt = new Date(now).toISOString();
  await db.transaction("rw", db.pendingSales, async () => {
    for (const item of items) {
      await db.pendingSales.put({
        ...item,
        status: "syncing",
        retryCount: item.retryCount + 1,
        lastAttemptAt: attemptAt,
        error: undefined,
      });
    }
  });

  let results: Array<{ operationId: string; status: string; error?: string }>;
  try {
    const response = await postJson<{
      results: Array<{ operationId: string; status: string; error?: string }>;
    }>("/api/sync", {
      deviceId: await deviceId(),
      operations: items.map((item) => ({
        operationId: item.idempotencyKey ?? item.id,
        type: item.operationType ?? "sale.create",
        payload: item.payload,
      })),
    });
    const expected = new Set(items.map((item) => item.id));
    const returned = response.results.map((result) => result.operationId);
    if (
      returned.length !== expected.size ||
      new Set(returned).size !== returned.length ||
      returned.some((operationId) => !expected.has(operationId))
    ) {
      throw new Error("استجابة المزامنة غير مكتملة؛ ستتم إعادة المحاولة بأمان");
    }
    results = response.results;
  } catch (error) {
    const message = error instanceof Error ? error.message : "تعذر الاتصال بالخادم";
    for (const item of items) await markPendingFailed(item.id, message);
    throw error;
  }

  let done = 0;
  let failed = 0;
  let conflicts = 0;
  for (const result of results) {
    if (result.status === "done") {
      await removePending(result.operationId);
      done += 1;
    } else if (result.status === "conflict") {
      const item = await db.pendingSales.get(result.operationId);
      if (item) {
        await db.pendingSales.put({
          ...item,
          status: "conflict",
          nextRetryAt: Number.MAX_SAFE_INTEGER,
          error: result.error ?? "تعارض يحتاج إلى مراجعة",
        });
      }
      conflicts += 1;
    } else {
      await markPendingFailed(result.operationId, result.error ?? "تعذر المزامنة");
      failed += 1;
    }
  }

  if (done > 0) {
    await db.meta.put({ key: "lastSuccessfulSyncAt", value: new Date().toISOString() });
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("offline-sync-complete"));
    }
  }
  return { done, failed, conflicts };
}
