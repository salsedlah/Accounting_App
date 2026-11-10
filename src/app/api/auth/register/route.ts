import { z } from "zod";
import { eq } from "drizzle-orm";
import { ensureReady } from "@/db/bootstrap";
import { getDb, transaction } from "@/db/client";
import { users } from "@/db/schema";
import { AppError, fail, ok, readJson, route } from "@/server/api";
import {
  createSessionToken,
  getSession,
  setSessionCookie,
  verifyPassword,
} from "@/server/auth";
import {
  createSupabaseUser,
  isSupabaseAuthConfigured,
  signInWithSupabase,
  signUpWithSupabase,
  SupabaseAuthError,
  SupabaseUnavailableError,
} from "@/server/supabase";
import { linkAuthUser, provisionAccount } from "@/server/services/provisioning";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(120),
  businessName: z.string().trim().max(160).optional(),
});

function isMobile(request: Request): boolean {
  return request.headers.get("x-hisab-client") === "react-native";
}

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const input = schema.parse(await readJson(request));
    const email = input.email.trim().toLowerCase();
    const businessName = input.businessName?.trim() || `${input.name} - نشاطي`;
    const db = await getDb();
    const [localUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (localUser?.authUserId) {
      return fail(
        "هذا البريد مرتبط مسبقاً بحساب سحابي. سجّل الدخول بدلاً من إنشاء حساب جديد.",
        409,
        "auth_already_linked",
      );
    }

    if (isSupabaseAuthConfigured()) {
      // An existing local account may only be linked to Supabase after proving
      // control of its local password. Otherwise anybody who signs up to
      // Supabase with the same email could take over the local business.
      if (
        localUser &&
        !(await verifyPassword(input.password, localUser.passwordHash))
      ) {
        return fail(
          "كلمة المرور لا تطابق الحساب المحلي. استخدم كلمة المرور الأصلية لربط الحساب.",
          409,
          "legacy_link_password_mismatch",
        );
      }

      let supabaseSession;
      try {
        // Existing local accounts are provisioned with the admin API only after
        // the local password was verified above. New accounts use public
        // sign-up so the project's email-confirmation policy still applies.
        const created = localUser
          ? await createSupabaseUser({
              email,
              password: input.password,
              name: input.name,
              businessName,
            })
          : await signUpWithSupabase({
              email,
              password: input.password,
              name: input.name,
              businessName,
            });
        if (created.needsConfirmation) {
          return ok(
            {
              needsConfirmation: true,
              authMode: "supabase",
              message:
                "تم إنشاء الحساب. أكّد بريدك الإلكتروني من رسالة Supabase ثم سجّل الدخول.",
            },
            202,
          );
        }
        supabaseSession =
          created.session ??
          (await signInWithSupabase(email, input.password));
        if (!supabaseSession) {
          throw new AppError("تعذر إنشاء جلسة Supabase بعد التسجيل", 502);
        }
      } catch (error) {
        if (error instanceof SupabaseUnavailableError) {
          return fail(error.message, 503, "supabase_unavailable");
        }
        if (error instanceof SupabaseAuthError) {
          return fail(error.message, error.status || 400, error.code ?? "supabase_signup_error");
        }
        throw error;
      }

      const provisioned = await transaction((tx) =>
        linkAuthUser(tx, supabaseSession.user, {
          name: input.name,
          businessName,
        }),
      );
      const token = await createSessionToken(provisioned.userId, provisioned.businessId);
      await setSessionCookie(token);
      const session = await getSession();
      return ok(
        {
          session,
          authMode: "supabase",
          cloudLinked: true,
          ...(isMobile(request) ? { token } : {}),
        },
        201,
      );
    }

    // Legacy/local registration. This keeps the application usable before
    // Supabase Auth keys are configured, but the account is explicitly not
    // cloud-linked and cannot use cloud sync until it is linked.
    if (localUser) {
      return fail("هذا البريد الإلكتروني مسجل مسبقاً", 409, "email_exists");
    }
    const provisioned = await transaction((tx) =>
      provisionAccount(tx, {
        email,
        name: input.name,
        businessName,
        password: input.password,
      }),
    );
    const token = await createSessionToken(provisioned.userId, provisioned.businessId);
    await setSessionCookie(token);
    const session = await getSession();
    return ok(
      {
        session,
        authMode: "legacy",
        cloudLinked: false,
        message:
          "تم إنشاء الحساب محلياً. لتفعيل المزامنة بين الأجهزة يجب ربط الحساب بـ Supabase Auth.",
        ...(isMobile(request) ? { token } : {}),
      },
      201,
    );
  });
}
