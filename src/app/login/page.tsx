import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/server/auth";
import { LoginBadges, LoginForm } from "./login-form";

export const metadata = { title: "تسجيل الدخول" };
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession().catch(() => null);
  if (session) redirect(session.role === "super_admin" ? "/platform" : "/");
  const { next } = await searchParams;

  return (
    <main className="grid min-h-screen bg-ink-50 lg:grid-cols-2">
      <section className="relative hidden overflow-hidden bg-brand-700 p-10 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-brand-500/40 blur-3xl" />
        <div className="absolute -bottom-32 -right-16 h-80 w-80 rounded-full bg-brand-400/30 blur-3xl" />
        <div className="relative">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
            نظام حساب الذكي
          </div>
          <h1 className="max-w-md text-4xl font-bold leading-tight">
            محاسبة ومخزون ونقاط بيع، بالعربية وبكل بساطة.
          </h1>
          <p className="mt-4 max-w-md text-sm leading-7 text-brand-100">
            فواتير، ديون، جرد، تقارير، ومساعد ذكي يجيبك من بياناتك. يعمل على الهاتف
            ويلتقط المبيعات حتى عند انقطاع الإنترنت.
          </p>
        </div>
        <ul className="relative space-y-3 text-sm text-brand-50">
          {[
            "قيود محاسبية مزدوجة وتقارير مالية دقيقة",
            "وحدات متعددة وباركود وجرد سريع",
            "عمل دون اتصال ورفع تلقائي عند العودة",
            "صلاحيات دقيقة لكل دور في الفريق",
          ].map((item) => (
            <li key={item} className="flex items-center gap-2">
              <span className="grid h-5 w-5 place-items-center rounded-full bg-white/15 text-[10px]">
                ✓
              </span>
              {item}
            </li>
          ))}
        </ul>
        <p className="relative text-xs text-brand-200">
          صُنع ليتناسب مع السوق اليمني — العملة: ريال يمني
        </p>
      </section>

      <section className="flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center">
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-brand-600 text-xl font-bold text-white shadow-card">
              ح
            </div>
            <h2 className="text-xl font-bold">مرحباً بعودتك</h2>
            <p className="mt-1 text-sm text-ink-500">سجّل الدخول للمتابعة إلى حسابك</p>
          </div>
          <Suspense fallback={null}>
            <LoginForm next={next} />
          </Suspense>
          <LoginBadges />
        </div>
      </section>
    </main>
  );
}
