import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ensureReady } from "@/db/bootstrap";
import { getDb } from "@/db/client";
import { memberships, platformAdmins, users } from "@/db/schema";
import {
  clearSessionCookie,
  createSessionToken,
  getSession,
  setSessionCookie,
  verifyPassword,
} from "@/server/auth";
import { fail, ok, readJson, route } from "@/server/api";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

type Attempt = { count: number; resetAt: number };
const attempts = new Map<string, Attempt>();

function clientKey(email: string, request: Request): string {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "local";
  return `${email.toLowerCase()}|${ip}`;
}

function tooMany(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= 5;
}

function recordFailure(key: string): void {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
  } else {
    entry.count += 1;
  }
}

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const input = schema.parse(await readJson(request));
    const key = clientKey(input.email, request);
    if (tooMany(key)) {
      return fail("محاولات دخول كثيرة. حاول بعد 15 دقيقة.", 429, "rate_limited");
    }

    const db = await getDb();
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, input.email.trim().toLowerCase()));
    if (!user || !user.isActive || !(await verifyPassword(input.password, user.passwordHash))) {
      recordFailure(key);
      return fail("البريد الإلكتروني أو كلمة المرور غير صحيحة", 401, "invalid_credentials");
    }

    const [admin] = await db.select({ userId: platformAdmins.userId })
      .from(platformAdmins).where(eq(platformAdmins.userId, user.id)).limit(1);
    const [membership] = admin ? [] : await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, user.id)))
      .limit(1);
    if (!membership && !admin) {
      recordFailure(key);
      return fail("لا توجد عضوية مرتبطة بهذا المستخدم", 403, "no_membership");
    }

    attempts.delete(key);
    const token = await createSessionToken(user.id, admin ? "platform" : membership!.businessId);
    await setSessionCookie(token);
    const session = await getSession();
    return ok({
      session,
      ...(request.headers.get("x-hisab-client") === "react-native" ? { token } : {}),
    });
  });
}

export async function DELETE() {
  return route(async () => {
    await clearSessionCookie();
    return ok({ ok: true });
  });
}
