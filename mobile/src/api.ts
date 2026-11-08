import {
  enqueueRequest,
  listQueuedRequests,
  markQueuedRequestFailed,
  readCache,
  removeQueuedRequest,
  retryFailedRequests,
  writeCache,
} from "./local-db";
import { getServerUrl, getSessionToken } from "./secure-storage";

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
]);

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

export async function createRecord<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<{ queued: boolean; data?: T }> {
  if (!OFFLINE_CREATE_PATHS.has(path)) {
    throw new Error("هذه العملية لا تدعم الحفظ دون اتصال بعد.");
  }
  if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 8) {
    throw new Error("مفتاح العملية غير صالح؛ لم يتم حفظ الطلب.");
  }

  try {
    const data = await request<T>(path, { method: "POST", body: JSON.stringify(body) });
    return { queued: false, data };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    await enqueueRequest({
      id: body.idempotencyKey,
      method: "POST",
      path,
      body,
    });
    return { queued: true };
  }
}

export async function syncOutbox(): Promise<{ done: number; failed: number }> {
  await retryFailedRequests();
  const queued = await listQueuedRequests();
  let done = 0;
  let failed = 0;

  for (const item of queued) {
    try {
      await request(item.path, {
        method: item.method,
        body: item.body,
      });
      await removeQueuedRequest(item.id);
      done += 1;
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
