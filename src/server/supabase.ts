import { jwtVerify } from "jose";

/**
 * Minimal Supabase Auth / Storage REST client.
 *
 * The application can run in two modes:
 *  - Legacy/local mode: no Supabase Auth keys are configured. Passwords are
 *    checked against the local bcrypt hash in `users.password_hash`.
 *  - Supabase Auth mode: `SUPABASE_URL` + an anon key are configured. Passwords
 *    are verified by Supabase and the local user row is linked through
 *    `users.auth_user_id`.
 *
 * Nothing here is mocked: when the keys are present every call goes to the
 * real Supabase project.
 */

const AUTH_TIMEOUT_MS = 15_000;

export class SupabaseUnavailableError extends Error {
  constructor(message = "تعذر الوصول إلى خدمة المصادقة السحابية") {
    super(message);
    this.name = "SupabaseUnavailableError";
  }
}

export class SupabaseAuthError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = "SupabaseAuthError";
    this.status = status;
    this.code = code;
  }
}

export type SupabaseAuthUser = {
  id: string;
  email: string | null;
  user_metadata?: Record<string, unknown> | null;
};

export type SupabaseSession = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  user: SupabaseAuthUser;
};

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Derives https://<ref>.supabase.co from DATABASE_URL when not configured. */
export function supabaseProjectUrl(): string | undefined {
  const configured = env("SUPABASE_URL") ?? env("NEXT_PUBLIC_SUPABASE_URL");
  if (configured) return configured.replace(/\/+$/, "");
  const databaseUrl = env("DATABASE_URL");
  if (!databaseUrl) return undefined;
  try {
    const parsed = new URL(databaseUrl);
    const match = /^postgres\.([a-z0-9]+)$/i.exec(parsed.username);
    if (match) return `https://${match[1]}.supabase.co`;
  } catch {
    // Ignore malformed DATABASE_URL; the DB layer reports it separately.
  }
  return undefined;
}

export function supabaseAnonKey(): string | undefined {
  return env("SUPABASE_ANON_KEY") ?? env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

export function supabaseServiceRoleKey(): string | undefined {
  return env("SUPABASE_SERVICE_ROLE_KEY");
}

export function supabaseJwtSecret(): string | undefined {
  return env("SUPABASE_JWT_SECRET");
}

export function isSupabaseAuthConfigured(): boolean {
  return Boolean(supabaseProjectUrl() && supabaseAnonKey());
}

export function supabaseConfigSummary() {
  const url = supabaseProjectUrl();
  return {
    configured: Boolean(url && supabaseAnonKey()),
    url: url ?? null,
    hasAnonKey: Boolean(supabaseAnonKey()),
    hasServiceRoleKey: Boolean(supabaseServiceRoleKey()),
    hasJwtSecret: Boolean(supabaseJwtSecret()),
    autoProvision: env("SUPABASE_AUTO_PROVISION") !== "false",
    storageBucket: env("SUPABASE_BACKUP_BUCKET") ?? "hisab-backups",
  };
}

function requireUrlAndKey(): { url: string; key: string } {
  const url = supabaseProjectUrl();
  const key = supabaseAnonKey();
  if (!url || !key) {
    throw new SupabaseUnavailableError("لم يتم إعداد مفاتيح Supabase Auth على الخادم.");
  }
  return { url, key };
}

async function authFetch(
  path: string,
  init: { method?: string; body?: unknown; token?: string; apikey?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; payload: unknown }> {
  const { url, key } = requireUrlAndKey();
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method: init.method ?? "GET",
      headers: {
        apikey: init.apikey ?? key,
        authorization: `Bearer ${init.token ?? init.apikey ?? key}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SupabaseUnavailableError(
      error instanceof Error && error.name === "TimeoutError"
        ? "انتهت مهلة الاتصال بخدمة المصادقة السحابية."
        : "تعذر الوصول إلى خدمة المصادقة السحابية. تحقق من الاتصال.",
    );
  }
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }
  return { status: response.status, payload };
}

function authErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const message =
      (typeof record.msg === "string" && record.msg) ||
      (typeof record.message === "string" && record.message) ||
      (typeof record.error_description === "string" && record.error_description) ||
      (typeof record.error === "string" && record.error);
    if (message) return message;
  }
  return fallback;
}

function parseSession(payload: unknown): SupabaseSession | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const user = record.user;
  if (!user || typeof user !== "object") return null;
  const userRecord = user as Record<string, unknown>;
  const id = typeof userRecord.id === "string" ? userRecord.id : null;
  if (!id) return null;
  const accessToken = typeof record.access_token === "string" ? record.access_token : null;
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: typeof record.refresh_token === "string" ? record.refresh_token : null,
    expiresIn: typeof record.expires_in === "number" ? record.expires_in : null,
    user: {
      id,
      email: typeof userRecord.email === "string" ? userRecord.email : null,
      user_metadata:
        userRecord.user_metadata && typeof userRecord.user_metadata === "object"
          ? (userRecord.user_metadata as Record<string, unknown>)
          : null,
    },
  };
}

export async function signInWithSupabase(email: string, password: string): Promise<SupabaseSession> {
  const { status, payload } = await authFetch("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email, password },
  });
  if (status < 200 || status >= 300) {
    throw new SupabaseAuthError(
      authErrorMessage(payload, "البريد الإلكتروني أو كلمة المرور غير صحيحة"),
      status,
      status === 400 || status === 401 ? "invalid_credentials" : "supabase_auth_error",
    );
  }
  const session = parseSession(payload);
  if (!session) throw new SupabaseAuthError("استجابة المصادقة السحابية غير صالحة", 502);
  return session;
}

export async function signUpWithSupabase(input: {
  email: string;
  password: string;
  name?: string;
  businessName?: string;
}): Promise<{ session: SupabaseSession | null; user: SupabaseAuthUser | null; needsConfirmation: boolean }> {
  const { status, payload } = await authFetch("/auth/v1/signup", {
    method: "POST",
    body: {
      email: input.email,
      password: input.password,
      data: {
        name: input.name ?? null,
        business_name: input.businessName ?? null,
      },
    },
  });
  if (status < 200 || status >= 300) {
    throw new SupabaseAuthError(
      authErrorMessage(payload, "تعذر إنشاء الحساب السحابي"),
      status,
      "supabase_signup_error",
    );
  }
  const session = parseSession(payload);
  if (session) return { session, user: session.user, needsConfirmation: false };
  const record = payload as Record<string, unknown> | null;
  const user = record?.user && typeof record.user === "object"
    ? (record.user as Record<string, unknown>)
    : record?.id
      ? record
      : null;
  const id = user && typeof user.id === "string" ? user.id : null;
  return {
    session: null,
    user: id
      ? {
          id,
          email: typeof user?.email === "string" ? user.email : input.email,
          user_metadata: null,
        }
      : null,
    needsConfirmation: true,
  };
}

/**
 * Creates a confirmed Supabase Auth user through the admin API. Used to migrate
 * an existing local account transparently on its first online login. Falls
 * back to the public sign-up endpoint when no service-role key is configured.
 */
export async function createSupabaseUser(input: {
  email: string;
  password: string;
  name?: string;
  businessName?: string;
}): Promise<{ user: SupabaseAuthUser | null; session: SupabaseSession | null; needsConfirmation: boolean }> {
  const serviceKey = supabaseServiceRoleKey();
  if (!serviceKey) {
    const signup = await signUpWithSupabase(input);
    return { user: signup.user, session: signup.session, needsConfirmation: signup.needsConfirmation };
  }
  const { url } = requireUrlAndKey();
  let response: Response;
  try {
    response = await fetch(`${url}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        email_confirm: true,
        user_metadata: {
          name: input.name ?? null,
          business_name: input.businessName ?? null,
        },
      }),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch {
    throw new SupabaseUnavailableError("تعذر الوصول إلى خدمة إدارة المستخدمين السحابية.");
  }
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }
  if (response.status < 200 || response.status >= 300) {
    // The user may already exist in Supabase (for example after a retry).
    const message = authErrorMessage(payload, "تعذر إنشاء المستخدم السحابي");
    if (response.status === 422 || /already/i.test(message)) {
      return { user: null, session: null, needsConfirmation: false };
    }
    throw new SupabaseAuthError(message, response.status, "supabase_admin_error");
  }
  const record = payload as Record<string, unknown> | null;
  const id = record && typeof record.id === "string" ? record.id : null;
  if (!id) return { user: null, session: null, needsConfirmation: false };
  return {
    user: {
      id,
      email: typeof record?.email === "string" ? record.email : input.email,
      user_metadata: null,
    },
    session: null,
    needsConfirmation: false,
  };
}

/** Verifies a Supabase access token and returns its subject. */
export async function verifySupabaseAccessToken(token: string): Promise<SupabaseAuthUser | null> {
  const secret = supabaseJwtSecret();
  if (secret) {
    try {
      const verified = await jwtVerify(token, new TextEncoder().encode(secret), {
        algorithms: ["HS256"],
      });
      const id = typeof verified.payload.sub === "string" ? verified.payload.sub : null;
      if (!id) return null;
      return {
        id,
        email: typeof verified.payload.email === "string" ? verified.payload.email : null,
        user_metadata: null,
      };
    } catch {
      return null;
    }
  }
  if (!isSupabaseAuthConfigured()) return null;
  try {
    const { status, payload } = await authFetch("/auth/v1/user", { token });
    if (status < 200 || status >= 300) return null;
    const record = payload as Record<string, unknown> | null;
    const id = record && typeof record.id === "string" ? record.id : null;
    if (!id) return null;
    return {
      id,
      email: typeof record?.email === "string" ? record.email : null,
      user_metadata: null,
    };
  } catch {
    return null;
  }
}

/**
 * Uploads a backup JSON object to Supabase Storage. Returns null when Storage
 * is not configured so callers can keep the backup in Postgres instead.
 */
export async function uploadBackupObject(
  path: string,
  body: string,
): Promise<{ storagePath: string } | null> {
  const url = supabaseProjectUrl();
  const serviceKey = supabaseServiceRoleKey();
  const bucket = env("SUPABASE_BACKUP_BUCKET") ?? "hisab-backups";
  if (!url || !serviceKey) return null;
  try {
    const response = await fetch(`${url}/storage/v1/object/${bucket}/${path}`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
        "x-upsert": "true",
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    return { storagePath: `${bucket}/${path}` };
  } catch {
    return null;
  }
}

export async function downloadBackupObject(storagePath: string): Promise<string | null> {
  const url = supabaseProjectUrl();
  const serviceKey = supabaseServiceRoleKey();
  if (!url || !serviceKey) return null;
  const [bucket, ...rest] = storagePath.split("/");
  if (!bucket || rest.length === 0) return null;
  try {
    const response = await fetch(
      `${url}/storage/v1/object/${bucket}/${rest.join("/")}`,
      {
        headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}
