import {
  applyCloudChanges,
  enqueueRequest,
  getPullCursor,
  listCachedApiPaths,
  listQueuedRequests,
  markQueuedRequestFailed,
  readCache,
  removeQueuedRequest,
  retryFailedRequests,
  setPullCursor,
  setSyncMeta,
  writeCache,
  type CloudChange,
} from "./local-db";
import {
  getCachedSession,
  getDeviceId,
  getServerUrl,
  getSessionToken,
  type MobileSession,
} from "./secure-storage";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type CachedResult<T> = {
  data: T;
  cached: boolean;
  updatedAt: string | null;
};

const OFFLINE_CREATE_PATHS = new Set([
  "/api/sales",
  "/api/purchases",
  "/api/expenses",
  "/api/payments",
  "/api/customers",
  "/api/suppliers",
  "/api/products",
  "/api/debts",
  "/api/inventory/adjust",
  "/api/stocktaking",
  "/api/cashbox/manual",
]);

const SYNC_OPERATION_BY_PATH: Record<string, string> = {
  "/api/sales": "sale.create",
  "/api/purchases": "purchase.create",
  "/api/expenses": "expense.create",
  "/api/payments": "payment.create",
  "/api/customers": "customer.create",
  "/api/suppliers": "supplier.create",
  "/api/products": "product.create",
  "/api/debts": "debt.create",
  "/api/inventory/adjust": "inventory.adjust",
  "/api/stocktaking": "stocktaking.create",
  "/api/cashbox/manual": "cashbox.manual",
};

function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  options: { mobileLogin?: boolean; authenticated?: boolean } = {},
): Promise<T> {
  const baseUrl = await getServerUrl();
  const token = options.authenticated === false ? null : await getSessionToken();
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (options.mobileLogin) headers.set("x-hisab-client", "react-native");

  const response = await fetch(apiUrl(baseUrl, path), {
    ...init,
    headers,
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? ((await response.json()) as Record<string, unknown>)
    : null;

  if (!response.ok) {
    const message =
      payload && typeof payload.error === "string"
        ? payload.error
        : response.status === 401
          ? "انتهت الجلسة. اتصل بالإنترنت وسجّل الدخول مجدداً."
          : "تعذر تنفيذ الطلب";
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

export function getJson<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function patchJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export async function getCachedJson<T>(path: string): Promise<CachedResult<T>> {
  try {
    const data = await getJson<T>(path);
    const updatedAt = new Date().toISOString();
    await writeCache(path, data);
    return { data, cached: false, updatedAt };
  } catch (error) {
    const canUseCache =
      error instanceof TypeError || (error instanceof ApiError && error.status >= 500);
    if (!canUseCache) throw error;
    const cached = await readCache<T>(path);
    if (!cached) throw error;
    return { data: cached.value, cached: true, updatedAt: cached.updatedAt };
  }
}

export async function loginRequest<T>(email: string, password: string): Promise<T> {
  return request<T>(
    "/api/auth/login",
    {
      method: "POST",
      body: JSON.stringify({ email, password }),
    },
    { mobileLogin: true, authenticated: false },
  );
}

export async function registerRequest<T>(input: {
  email: string;
  password: string;
  name: string;
  businessName?: string;
}): Promise<T> {
  return request<T>(
    "/api/auth/register",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    { mobileLogin: true, authenticated: false },
  );
}

export async function createRecord<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<{ queued: boolean; data?: T }> {
  if (!OFFLINE_CREATE_PATHS.has(path) || !SYNC_OPERATION_BY_PATH[path]) {
    throw new Error("هذه العملية لا تدعم الحفظ دون اتصال بعد.");
  }
  if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 8) {
    throw new Error("مفتاح العملية غير صالح؛ لم يتم حفظ الطلب.");
  }

  const id = body.idempotencyKey;
  await enqueueRequest({ id, method: "POST", path, body });
  try {
    const item = (await listQueuedRequests()).find((entry) => entry.id === id);
    if (!item) return { queued: false };
    const result = await pushQueuedOperation<T>(item);
    if (!result.done) {
      await projectQueuedRecord(path, body);
      return { queued: true };
    }
    return { queued: false, data: result.data };
  } catch (error) {
    // The request remains durable in SQLite. Only a transport failure is
    // reported as queued; authorization/validation errors are surfaced.
    if (error instanceof TypeError || (error instanceof ApiError && error.status >= 500)) {
      await projectQueuedRecord(path, body);
      return { queued: true };
    }
    throw error;
  }
}

type EditableCollection = "customers" | "suppliers" | "products" | "users" | "settings";

const EDITABLE_COLLECTIONS: Record<EditableCollection, { endpoint: string; collectionKey: string }> = {
  customers: { endpoint: "/api/customers", collectionKey: "customers" },
  suppliers: { endpoint: "/api/suppliers", collectionKey: "suppliers" },
  products: { endpoint: "/api/products", collectionKey: "products" },
  users: { endpoint: "/api/users", collectionKey: "members" },
  settings: { endpoint: "/api/settings", collectionKey: "business" },
};

/** Queue a safe profile update locally and replay it idempotently when online. */
export async function updateRecord(
  collection: EditableCollection,
  id: string,
  patch: Record<string, unknown>,
): Promise<{ queued: boolean }> {
  if (collection !== "settings" && !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error("لا يمكن تعديل سجل محلي قبل مزامنته.");
  }
  const path = collection === "settings"
    ? EDITABLE_COLLECTIONS.settings.endpoint
    : `${EDITABLE_COLLECTIONS[collection].endpoint}/${encodeURIComponent(id)}`;
  const operationId = `mobile-edit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await enqueueRequest({ id: operationId, method: "PATCH", path, body: patch });
  await projectQueuedUpdate(collection, id, patch);
  try {
    const queued = (await listQueuedRequests()).find((item) => item.id === operationId);
    if (queued) await pushQueuedOperation(queued);
    return { queued: (await listQueuedRequests()).some((item) => item.id === operationId) };
  } catch (error) {
    if (error instanceof TypeError || (error instanceof ApiError && error.status >= 500)) {
      return { queued: true };
    }
    await removeQueuedRequest(operationId);
    try {
      const endpoint = EDITABLE_COLLECTIONS[collection].endpoint;
      await writeCache(endpoint, await getJson(endpoint));
    } catch {
      // Preserve the last cached snapshot if a rejected online edit cannot be refreshed.
    }
    throw error;
  }
}

export function deactivateRecord(
  collection: "customers" | "suppliers" | "products",
  id: string,
): Promise<{ queued: boolean }> {
  return updateRecord(collection, id, { isActive: false });
}

async function projectQueuedUpdate(
  collection: keyof typeof EDITABLE_COLLECTIONS,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const cacheKey = EDITABLE_COLLECTIONS[collection].endpoint;
  const cached = await readCache<Record<string, unknown> | unknown[]>(cacheKey);
  if (!cached) return;
  const collectionKey = EDITABLE_COLLECTIONS[collection].collectionKey;
  const localPatch = { ...patch };
  const minorUnits = (value: unknown, scale: number): string => {
    const text = String(value ?? "0").trim();
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) return "0";
    const fraction = (match[3] ?? "").padEnd(scale, "0").slice(0, scale);
    const amount = BigInt(match[2]) * BigInt(10 ** scale) + BigInt(fraction || "0");
    return `${match[1] ? "-" : ""}${amount}`;
  };
  if (collection === "customers" && "creditLimit" in localPatch) {
    localPatch.creditLimitMinor = minorUnits(localPatch.creditLimit, 2);
    delete localPatch.creditLimit;
  }
  if (collection === "products") {
    for (const key of ["purchaseCost", "retailPrice", "wholesalePrice"] as const) {
      if (key in localPatch) {
        localPatch[`${key}Minor`] = minorUnits(localPatch[key], 2);
        delete localPatch[key];
      }
    }
    if ("minStock" in localPatch) {
      localPatch.minStockMilli = minorUnits(localPatch.minStock, 3);
      delete localPatch.minStock;
    }
  }
  if (collection === "settings") {
    if (!isRecord(cached.value)) return;
    const business = cached.value.business;
    if (isRecord(business)) {
      await writeCache(cacheKey, { ...cached.value, business: { ...business, ...localPatch }, localPending: true });
    }
    return;
  }
  const apply = (record: unknown) => isRecord(record) && record.id === id
    ? { ...record, ...localPatch, localPending: true }
    : record;
  if (Array.isArray(cached.value)) {
    await writeCache(cacheKey, cached.value.map(apply));
    return;
  }
  if (!isRecord(cached.value)) return;
  const rows = cached.value[collectionKey];
  if (Array.isArray(rows)) {
    await writeCache(cacheKey, { ...cached.value, [collectionKey]: rows.map(apply) });
  }
}

const OFFLINE_PROJECTIONS: Record<string, { cacheKey: string; collection: string }> = {
  "/api/sales": { cacheKey: "/api/sales", collection: "sales" },
  "/api/purchases": { cacheKey: "/api/purchases", collection: "purchases" },
  "/api/expenses": { cacheKey: "/api/expenses", collection: "expenses" },
  "/api/payments": { cacheKey: "/api/payments", collection: "payments" },
  "/api/customers": { cacheKey: "/api/customers", collection: "customers" },
  "/api/suppliers": { cacheKey: "/api/suppliers", collection: "suppliers" },
  "/api/products": { cacheKey: "/api/products", collection: "products" },
  "/api/debts": { cacheKey: "/api/debts", collection: "debts" },
  "/api/stocktaking": { cacheKey: "/api/stocktaking", collection: "sessions" },
  "/api/cashbox/manual": { cacheKey: "/api/cashbox", collection: "transactions" },
};

async function projectQueuedRecord(path: string, body: Record<string, unknown>): Promise<void> {
  const projection = OFFLINE_PROJECTIONS[path];
  if (!projection) return;
  const cached = await readCache<Record<string, unknown> | unknown[]>(projection.cacheKey);
  const localRecord = {
    ...body,
    id: `local-${String(body.idempotencyKey ?? Date.now())}`,
    localPending: true,
    createdAt: new Date().toISOString(),
  };
  if (!cached) {
    await writeCache(projection.cacheKey, { [projection.collection]: [localRecord] });
    return;
  }
  if (Array.isArray(cached.value)) {
    await writeCache(projection.cacheKey, [localRecord, ...cached.value]);
    return;
  }
  const current = cached.value[projection.collection];
  const records = Array.isArray(current) ? current : [];
  if (records.some((record) => isRecord(record) && record.id === localRecord.id)) return;
  await writeCache(projection.cacheKey, { ...cached.value, [projection.collection]: [localRecord, ...records] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pushQueuedOperation<T>(item: Awaited<ReturnType<typeof listQueuedRequests>>[number]): Promise<{
  done: boolean;
  data?: T;
}> {
  if (item.method === "PATCH") {
    const allowed = /^\/api\/(customers|suppliers|products|users)\/[0-9a-f-]{36}$/i.test(item.path) || item.path === "/api/settings";
    if (!allowed) throw new ApiError("مسار تعديل غير مسموح للمزامنة.", 400);
    await request(item.path, { method: "PATCH", body: item.body });
    await removeQueuedRequest(item.id);
    return { done: true };
  }
  const operationType = SYNC_OPERATION_BY_PATH[item.path];
  if (!operationType) throw new ApiError("نوع العملية غير مدعوم للمزامنة.", 400);
  const deviceId = await getDeviceId();
  const response = await request<{
    results: Array<{ operationId: string; status: "done" | "failed" | "conflict"; result?: T; error?: string }>;
  }>("/api/sync", {
    method: "POST",
    body: JSON.stringify({
      deviceId,
      operations: [{ operationId: item.id, type: operationType, payload: JSON.parse(item.body) }],
    }),
  });
  const result = response.results.find((entry) => entry.operationId === item.id);
  if (result?.status === "done") {
    await removeQueuedRequest(item.id);
    return { done: true, data: result.result };
  }
  const message = result?.error ?? "لم يؤكد الخادم حفظ العملية؛ بقيت في قائمة المزامنة.";
  await markQueuedRequestFailed(item.id, message);
  if (result?.status === "conflict") throw new ApiError(message, 409);
  return { done: false };
}

export async function syncOutbox(): Promise<{ done: number; failed: number }> {
  await retryFailedRequests();
  const queued = await listQueuedRequests();
  let done = 0;
  let failed = 0;

  for (const item of queued) {
    try {
      const result = await pushQueuedOperation(item);
      if (result.done) done += 1;
      else failed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "تعذرت مزامنة العملية";
      await markQueuedRequestFailed(item.id, message);
      failed += 1;
      if (error instanceof TypeError || (error instanceof ApiError && error.status >= 500)) {
        break;
      }
    }
  }
  return { done, failed };
}

async function refreshCachedApiPaths(): Promise<void> {
  const paths = (await listCachedApiPaths()).filter((path) =>
    /^\/api\/(?!auth\/|sync(?:\/|\?|$)|cloud\/|ai\/)/.test(path),
  );
  for (const path of paths) {
    try {
      const data = await getJson<unknown>(path);
      await writeCache(path, data);
    } catch {
      // The previous response remains available offline if a module is no
      // longer permitted or a single endpoint fails during refresh.
    }
  }
}

export type SyncStatus = {
  serverTime: string;
  businessId: string;
  userId: string;
  authUserId: string | null;
  deviceId: string | null;
  settings: {
    autoSync: boolean;
    autoBackup: boolean;
    backupIntervalHours: number;
    lastSyncAt: string | null;
    lastBackupAt: string | null;
    lastError: string | null;
    updatedAt: string;
  };
  cursor: {
    deviceId: string;
    lastChangeId: number;
    lastSyncedAt: string | null;
  } | null;
  latestChangeId: number;
  pendingOperations: number;
  latestBackup: {
    id: string;
    kind: string;
    status: string;
    createdAt: string;
    sizeBytes: number | null;
  } | null;
};

export type SyncPullResult = {
  changes: CloudChange[];
  nextCursor: number;
  hasMore: boolean;
  serverTime: string;
};

export type CloudBackupInfo = {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
  sizeBytes: number | null;
};

export async function listCloudBackups(): Promise<CloudBackupInfo[]> {
  const result = await getJson<{ backups: CloudBackupInfo[] }>("/api/cloud/backups");
  return result.backups;
}

export async function createCloudBackup(): Promise<CloudBackupInfo> {
  const result = await postJson<{ backup?: CloudBackupInfo; id?: string; createdAt?: string; sizeBytes?: number | null }>(
    "/api/cloud/backups",
    {},
  );
  return result.backup ?? {
    id: result.id ?? "",
    kind: "manual",
    status: "completed",
    createdAt: result.createdAt ?? new Date().toISOString(),
    sizeBytes: result.sizeBytes ?? null,
  };
}

export function restoreCloudBackup(id: string): Promise<{ message: string }> {
  return postJson<{ message: string }>(`/api/cloud/backups/${encodeURIComponent(id)}/restore`, {
    confirmation: "RESTORE_BACKUP",
  });
}

export async function syncStatus(deviceId?: string): Promise<SyncStatus> {
  const query = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : "";
  return getJson<SyncStatus>(`/api/sync/status${query}`);
}

export async function syncPull(since: number, limit = 200): Promise<SyncPullResult> {
  return getJson<SyncPullResult>(
    `/api/sync/pull?since=${encodeURIComponent(String(Math.max(0, Math.floor(since))))}&limit=${encodeURIComponent(String(limit))}`,
  );
}

export async function syncAck(lastChangeId: number): Promise<{ ok: boolean; lastChangeId: number }> {
  const deviceId = await getDeviceId();
  return postJson<{ ok: boolean; lastChangeId: number }>("/api/sync/ack", {
    deviceId,
    lastChangeId: Math.max(0, Math.floor(lastChangeId)),
  });
}

/**
 * Push the local outbox, then pull every available cloud change page and
 * acknowledge the durable cursor only after the page was applied locally.
 *
 * Pulling is intentionally skipped for accounts without a verified Supabase
 * identity: the server rejects those requests anyway, and skipping avoids
 * pretending that a legacy local account is cloud-linked.
 */
export async function syncAll(session?: MobileSession | null): Promise<{
  pushed: number;
  failed: number;
  pulled: number;
  conflicts: number;
  lastChangeId: number;
  cloudLinked: boolean;
  hasMore: boolean;
}> {
  const current = session ?? (await getCachedSession());
  const pushed = await syncOutbox();

  if (!current?.authUserId) {
    await refreshCachedApiPaths();
    await setSyncMeta("last_sync_at", new Date().toISOString());
    await setSyncMeta("last_sync_skipped", "unlinked");
    return {
      pushed: pushed.done,
      failed: pushed.failed,
      pulled: 0,
      conflicts: 0,
      lastChangeId: 0,
      cloudLinked: false,
      hasMore: false,
    };
  }

  let cursor = await getPullCursor();
  let pulled = 0;
  let conflicts = 0;
  let hasMore = false;

  // Bound the number of pages so a single foreground sync cannot run forever.
  for (let page = 0; page < 25; page += 1) {
    const result = await syncPull(cursor, 200);
    if (result.changes.length > 0) {
      const applied = await applyCloudChanges(result.changes);
      pulled += applied.applied;
      conflicts += applied.conflicts;
    }
    cursor = Math.max(cursor, result.nextCursor);
    await setPullCursor(cursor);
    hasMore = result.hasMore;
    if (!result.hasMore || result.changes.length === 0) break;
  }

  await syncAck(cursor);
  await refreshCachedApiPaths();
  await setSyncMeta("last_sync_at", new Date().toISOString());
  await setSyncMeta("last_sync_skipped", "");
  return {
    pushed: pushed.done,
    failed: pushed.failed,
    pulled,
    conflicts,
    lastChangeId: cursor,
    cloudLinked: true,
    hasMore,
  };
}
