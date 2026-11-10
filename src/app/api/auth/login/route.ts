import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ensureReady } from "@/db/bootstrap";
import { getDb, transaction } from "@/db/client";
import { memberships, platformAdmins, users } from "@/db/schema";
import {
  clearSessionCookie,
  createSessionToken,
  getSession,
  setSessionCookie,
  verifyPassword,
} from "@/server/auth";
import { fail, ok, readJson, route } from "@/server/api";
import {
  isSupabaseAuthConfigured,
  signInWithSupabase,
  SupabaseAuthError,
  SupabaseUnavailableError,
} from "@/server/supabase";
import { linkAuthUser } from "@/server/services/provisioning";

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
    const email = input.email.trim().toLowerCase();
    const mobile = request.headers.get("x-hisab-client") === "react-native";
    let supabaseFailure: "unavailable" | "invalid" | null = null;

    if (isSupabaseAuthConfigured()) {
      try {
        const supabaseSession = await signInWithSupabase(email, input.password);
        const [localUser] = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        if (localUser?.authUserId && localUser.authUserId !== supabaseSession.user.id) {
          return fail(
            "هذا البريد مرتبط مسبقاً بحساب Supabase Auth مختلف. سجّل الدخول بالحساب الأصلي.",
            403,
            "auth_link_conflict",
          );
        }

        // Linking a legacy local account requires proof of the local password.
        // A Supabase account with the same email alone is not enough: otherwise
        // a newly-created Auth account could take over an existing business.
        if (
          localUser &&
          !localUser.authUserId &&
          !(await verifyPassword(input.password, localUser.passwordHash))
        ) {
          return fail(
            "تم التحقق من الحساب السحابي، لكن كلمة المرور لا تطابق الحساب المحلي. استخدم كلمة المرور الأصلية لربط الحساب.",
            409,
            "legacy_link_password_mismatch",
          );
        }

        const provisioned = await transaction((tx) =>
          linkAuthUser(tx, supabaseSession.user),
        );
        attempts.delete(key);
        const token = await createSessionToken(
          provisioned.userId,
          provisioned.businessId,
        );
        await setSessionCookie(token);
        const session = await getSession();
        return ok({
          session,
          authMode: "supabase",
          cloudLinked: true,
          ...(mobile ? { token } : {}),
        });
      } catch (error) {
        if (error instanceof SupabaseUnavailableError) {
          supabaseFailure = "unavailable";
        } else if (error instanceof SupabaseAuthError) {
          supabaseFailure = "invalid";
        } else {
          throw error;
        }
      }
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email));
    if (!user || !user.isActive) {
      recordFailure(key);
      return fail("البريد الإلكتروني أو كلمة المرور غير صحيحة", 401, "invalid_credentials");
    }

    // A Supabase-linked account must never be authenticated by a local
    // password when Supabase rejects or cannot verify the credentials.
    if (user.authUserId && supabaseFailure) {
      recordFailure(key);
      if (supabaseFailure === "unavailable") {
        return fail(
          "تعذر التحقق من الحساب السحابي حالياً. تحقق من الاتصال وحاول مجدداً.",
          503,
          "supabase_unavailable",
        );
      }
      return fail(
        "بيانات الدخول السحابية غير صحيحة. استخدم كلمة مرور حساب Supabase.",
        401,
        "invalid_credentials",
      );
    }

    // Legacy fallback is explicit and never marks the session as cloud-linked.
    if (
      isSupabaseAuthConfigured() &&
      process.env.ALLOW_LEGACY_AUTH === "false"
    ) {
      recordFailure(key);
      return fail(
        "الدخول المحلي غير مفعّل. سجّل الدخول عبر Supabase Auth.",
        403,
        "legacy_auth_disabled",
      );
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) {
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
      authMode: "legacy",
      cloudLinked: Boolean(session?.authUserId),
      message: session?.authUserId
        ? undefined
        : "هذا الحساب غير مرتبط بـ Supabase Auth؛ المزامنة السحابية معطلة حتى يتم الربط.",
      ...(mobile ? { token } : {}),
    });
  });
}

export async function DELETE() {
  return route(async () => {
    await clearSessionCookie();
    return ok({ ok: true });
  });
}
