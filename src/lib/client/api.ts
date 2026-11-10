export type ApiError = { error?: string; code?: string; details?: unknown };
export type OfflineQueuedResponse = { offlineQueued: true; operationId: string };

type QueueableOfflineOperation = Exclude<import("@/lib/offline/db").OfflineOperationType, "sale.create">;
const OFFLINE_POSTS: Record<string, QueueableOfflineOperation> = {
  "/api/purchases": "purchase.create",
  "/api/expenses": "expense.create",
  "/api/payments": "payment.create",
  "/api/customers": "customer.create",
  "/api/suppliers": "supplier.create",
  "/api/products": "product.create",
  "/api/debts": "debt.create",
  "/api/inventory/adjust": "inventory.adjust",
  "/api/cashbox/manual": "cashbox.manual",
};

export function wasQueuedOffline(value: unknown): value is OfflineQueuedResponse {
  return Boolean(value && typeof value === "object" && "offlineQueued" in value && value.offlineQueued === true);
}

export class ApiRequestError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isNetworkFailure(error: unknown): boolean {
  return (typeof navigator !== "undefined" && !navigator.onLine) || error instanceof TypeError;
}

function canCacheOfflineGet(url: string): boolean {
  const path = new URL(url, typeof window === "undefined" ? "http://localhost" : window.location.origin).pathname;
  return (
    path.startsWith("/api/") &&
    path !== "/api/pos/data" &&
    !path.startsWith("/api/auth/") &&
    !path.startsWith("/api/users") &&
    !path.startsWith("/api/platform/") &&
    !path.startsWith("/api/backup")
  );
}

export async function api<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const method = init?.method?.toUpperCase() ?? "GET";
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  let response: Response;
  try {
    response = await fetch(input, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
      credentials: "same-origin",
    });
  } catch (error) {
    if (method === "GET" && canCacheOfflineGet(url)) {
      const { readCachedApiResponse } = await import("@/lib/offline/db");
      const cached = await readCachedApiResponse<T>(url);
      if (cached !== null) return cached;
    }
    throw error;
  }

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? ((await response.json().catch(() => null)) as (T & ApiError) | null)
    : null;

  if (!response.ok) {
    const message =
      (payload && "error" in payload && payload.error) ||
      (response.status === 401
        ? "انتهت الجلسة، يرجى تسجيل الدخول"
        : `تعذر إكمال الطلب من الخادم (HTTP ${response.status})`);
    throw new ApiRequestError(
      String(message),
      response.status,
      payload?.code,
      payload?.details,
    );
  }

  const result = (payload ?? ({} as T)) as T;
  if (
    method === "GET" &&
    response.ok &&
    typeof window !== "undefined" &&
    canCacheOfflineGet(url)
  ) {
    const { cacheApiResponse } = await import("@/lib/offline/db");
    try {
      await cacheApiResponse(url, result);
    } catch (error) {
      console.error("Failed to cache offline API response", error);
    }
  }
  return result;
}

export function postJson<T>(url: string, body: unknown): Promise<T> {
  return (async () => {
    const path = new URL(url, typeof window === "undefined" ? "http://localhost" : window.location.origin).pathname;
    const operationType = OFFLINE_POSTS[path];
    const original = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
    try {
      return await api<T>(url, { method: "POST", body: JSON.stringify(body) });
    } catch (error) {
      if (!operationType || !original || !isNetworkFailure(error)) throw error;
      const { queueOfflineOperation } = await import("@/lib/offline/db");
      const queuedPayload = { ...original, idempotencyKey: original.idempotencyKey ?? idempotencyKey("offline") };
      const opId = String(queuedPayload.idempotencyKey);
      await queueOfflineOperation(operationType, queuedPayload);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("offline-operation-queued", { detail: { operationId: opId } }));
      }
      return { offlineQueued: true, operationId: opId } as T;
    }
  })();
}

export function patchJson<T>(url: string, body: unknown): Promise<T> {
  return api<T>(url, { method: "PATCH", body: JSON.stringify(body) });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "حدث خطأ غير متوقع";
}

export function idempotencyKey(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

export function todayInput(): string {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 10);
}

export function monthStartInput(): string {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return `${local.toISOString().slice(0, 7)}-01`;
}
