"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  Boxes,
  ClipboardList,
  FileText,
  HandCoins,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  Receipt,
  ScanBarcode,
  Settings,
  ShoppingBag,
  Sparkles,
  Truck,
  UserCog,
  Users,
  Wallet,
  Wifi,
  WifiOff,
  Crown,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import { ROLE_LABELS, ROLE_PERMISSIONS, type Permission } from "@/lib/constants";
import {
  pendingSummary,
  retryFailedSales,
  syncPending,
  lastSuccessfulSyncAt,
  setOfflineScope,
  localStorageUsage,
} from "@/lib/offline/db";
import type { Session } from "@/server/auth";

type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  permissions?: Permission[];
  feature?: string;
};

const NAV: NavItem[] = [
  { href: "/", label: "لوحة التحكم", icon: LayoutDashboard },
  { href: "/pos", label: "نقطة البيع", icon: ScanBarcode, permissions: ["sales.create"], feature: "pos" },
  { href: "/products", label: "المنتجات", icon: Package, permissions: ["products.read"], feature: "products" },
  { href: "/inventory", label: "المخزون", icon: Boxes, permissions: ["inventory.read"], feature: "inventory" },
  { href: "/purchases", label: "المشتريات", icon: ShoppingBag, permissions: ["purchases.read"], feature: "purchases" },
  { href: "/customers", label: "العملاء", icon: Users, permissions: ["customers.read"], feature: "customers" },
  { href: "/debts", label: "ديون العملاء", icon: HandCoins, permissions: ["debts.manage"], feature: "customer_debts" },
  { href: "/suppliers", label: "الموردون", icon: Truck, permissions: ["purchases.read"], feature: "suppliers" },
  { href: "/supplier-debts", label: "ديون الموردين", icon: HandCoins, permissions: ["purchases.read"], feature: "supplier_debts" },
  { href: "/expenses", label: "المصروفات", icon: Receipt, permissions: ["expenses.create"], feature: "expenses" },
  { href: "/cashbox", label: "الصندوق", icon: Wallet, permissions: ["cashbox.manage"], feature: "cashbox" },
  { href: "/invoices", label: "الفواتير", icon: FileText, permissions: ["sales.read", "purchases.read"], feature: "invoices" },
  { href: "/stocktaking", label: "الجرد", icon: ClipboardList, permissions: ["stocktaking.manage"], feature: "stocktaking" },
  { href: "/reports", label: "التقارير", icon: BarChart3, permissions: ["reports.read"], feature: "reports" },
  { href: "/ai", label: "المساعد الذكي", icon: Sparkles, permissions: ["ai.ask"], feature: "ai_assistant" },
  { href: "/users", label: "المستخدمون", icon: UserCog, permissions: ["users.manage"] },
  { href: "/settings", label: "الإعدادات", icon: Settings, permissions: ["settings.manage"] },
  { href: "/subscription", label: "الاشتراك والباقة", icon: Crown },
];

export function AppShell({
  session,
  children,
}: {
  session: Session;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState({ pending: 0, syncing: 0, failed: 0, conflicts: 0, total: 0 });
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [offlineNotice, setOfflineNotice] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [storageUsage, setStorageUsage] = useState<number | null>(null);
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean> | null>(null);
  const [effectivePermissions, setEffectivePermissions] = useState<Permission[] | null>(null);

  useEffect(() => {
    fetch("/api/subscription").then((response) => response.ok ? response.json() : null)
      .then((data) => { if (data?.features) setFeatureFlags(data.features); }).catch(() => undefined);
    fetch("/api/auth/me").then((response) => response.ok ? response.json() : null)
      .then((data) => { if (Array.isArray(data?.permissions)) setEffectivePermissions(data.permissions); }).catch(() => undefined);
  }, []);

  useEffect(() => {
    void localStorageUsage().then(setStorageUsage).catch((error: unknown) => {
      setSyncError(error instanceof Error ? error.message : "تعذر قراءة مساحة التخزين المحلية");
    });
  }, []);

  const allowed = useMemo(() => {
    const perms = effectivePermissions ?? ROLE_PERMISSIONS[session.role] ?? [];
    return NAV.filter((item) => (!item.permissions || item.permissions.some((p) => perms.includes(p))) && (!item.feature || featureFlags === null || featureFlags[item.feature] !== false));
  }, [session.role, featureFlags, effectivePermissions]);

  const routeFeature: Record<string, string> = { "/": "dashboard", "/pos": "pos", "/products": "products", "/inventory": "inventory", "/purchases": "purchases", "/customers": "customers", "/debts": "customer_debts", "/suppliers": "suppliers", "/supplier-debts": "supplier_debts", "/expenses": "expenses", "/cashbox": "cashbox", "/invoices": "invoices", "/stocktaking": "stocktaking", "/reports": "reports", "/ai": "ai_assistant" };
  const gatedFeature = Object.entries(routeFeature).find(([path]) => path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(`${path}/`))?.[1];
  const featureDenied = Boolean(gatedFeature && featureFlags && featureFlags[gatedFeature] === false);

  async function refreshPending() {
    try {
      const [summary, lastSuccessfulAt] = await Promise.all([
        pendingSummary(),
        lastSuccessfulSyncAt(),
      ]);
      setPending(summary);
      setLastSync(lastSuccessfulAt);
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "تعذر قراءة حالة المزامنة");
    }
  }

  async function doSync() {
    if (!navigator.onLine) return;
    setSyncing(true);
    setSyncError(null);
    try {
      const result = await syncPending();
      await refreshPending();
      if (result.done > 0) router.refresh();
      const issues = [
        result.failed ? `فشلت مزامنة ${result.failed} عملية؛ ستتم إعادة المحاولة تلقائياً` : "",
        result.conflicts ? `توجد ${result.conflicts} عملية متعارضة تحتاج إلى مراجعة` : "",
      ].filter(Boolean);
      if (issues.length) setSyncError(issues.join("، "));
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "تعذر الاتصال بخادم المزامنة");
      await refreshPending();
    } finally {
      setSyncing(false);
    }
  }

  async function retryFailed() {
    try {
      await retryFailedSales();
      await doSync();
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "تعذرت إعادة محاولة العمليات الفاشلة");
    }
  }

  useLayoutEffect(() => {
    void setOfflineScope(`${session.businessId}:${session.userId}`).catch((error: unknown) => {
      setSyncError(error instanceof Error ? error.message : "تعذر تهيئة قاعدة البيانات المحلية");
    });
  }, [session.businessId, session.userId]);

  useEffect(() => {
    setOnline(navigator.onLine);
    refreshPending();
    if (navigator.onLine) void doSync();
    const onOnline = () => {
      setOnline(true);
      void doSync();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    const interval = window.setInterval(() => {
      void refreshPending();
      if (navigator.onLine) void doSync();
    }, 15_000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    const queued = () => {
      setOfflineNotice("حُفظت العملية على هذا الجهاز، وستُزامن تلقائيًا عند عودة الاتصال");
      window.setTimeout(() => setOfflineNotice(null), 7000);
    };
    window.addEventListener("offline-operation-queued", queued);
    return () => window.removeEventListener("offline-operation-queued", queued);
  }, []);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-brand-600/30 px-4 py-4">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-white/15 text-lg font-bold">
          ح
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">حساب</p>
          <p className="truncate text-[11px] text-brand-200">{session.businessName}</p>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
        {allowed.map((item) => {
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition",
                active
                  ? "bg-white text-brand-800 font-semibold shadow-sm"
                  : "text-brand-100 hover:bg-white/10",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-brand-600/30 p-3">
        <div className="mb-2 flex items-center justify-between text-[11px] text-brand-200">
          <span>{ROLE_LABELS[session.role] ?? session.role}</span>
          <span className="inline-flex items-center gap-1">
            {online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
            {syncing ? "جارٍ المزامنة" : online ? "متصل بالإنترنت" : "يعمل دون إنترنت"}
          </span>
        </div>
        {lastSync ? (
          <p className="mb-2 text-[10px] text-brand-200">
            آخر مزامنة ناجحة: {new Intl.DateTimeFormat("ar-YE", {
              dateStyle: "short",
              timeStyle: "short",
            }).format(new Date(lastSync))}
          </p>
        ) : null}
        {storageUsage !== null ? (
          <p className="mb-2 text-[10px] text-brand-200">
            بيانات هذا الجهاز · {(storageUsage / (1024 * 1024)).toFixed(1)} م.ب تقريبًا
          </p>
        ) : null}
        {pending.total > 0 ? (
          <div className="mb-2 space-y-1">
            <button
              type="button"
              onClick={doSync}
              disabled={syncing || !online}
              className="w-full rounded-lg bg-amber-400/90 px-2 py-1.5 text-[11px] font-medium text-amber-950 disabled:opacity-60"
            >
              {syncing ? "جارٍ المزامنة..." : `${pending.pending + pending.syncing} عملية بانتظار المزامنة`}
              {pending.failed ? ` · ${pending.failed} فاشلة` : ""}
              {pending.conflicts ? ` · ${pending.conflicts} تعارض` : ""}
            </button>
            {pending.failed > 0 ? (
              <button
                type="button"
                disabled={!online || syncing}
                onClick={retryFailed}
                className="w-full rounded-lg px-2 py-1 text-[10px] text-brand-100 hover:bg-white/10 disabled:opacity-60"
              >
                إعادة محاولة العمليات الفاشلة
              </button>
            ) : null}
          </div>
        ) : null}
        {syncError ? <p className="mb-2 text-[10px] leading-4 text-red-200">{syncError}</p> : null}
        <button
          type="button"
          onClick={logout}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-brand-100 hover:bg-white/10"
        >
          <LogOut className="h-4 w-4" /> تسجيل الخروج
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-ink-50">
      <aside className="fixed inset-y-0 right-0 z-40 hidden w-60 bg-brand-700 lg:block no-print">
        {sidebar}
      </aside>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-ink-900/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 right-0 w-64 bg-brand-700">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="absolute left-2 top-3 rounded-lg p-1.5 text-brand-100 hover:bg-white/10"
              aria-label="إغلاق القائمة"
            >
              <X className="h-4 w-4" />
            </button>
            {sidebar}
          </aside>
        </div>
      ) : null}

      <div className="lg:mr-60">
        <header className="sticky top-0 z-30 border-b border-ink-200 bg-white/90 backdrop-blur no-print">
          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="rounded-lg p-2 text-ink-600 hover:bg-ink-100 lg:hidden"
                aria-label="فتح القائمة"
              >
                <Menu className="h-5 w-5" />
              </button>
              <div>
                <p className="text-xs text-ink-500">{session.businessName}</p>
                <p className="text-sm font-semibold">{session.name}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={clsx(
                  "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px]",
                  online ? "bg-green-50 text-ok" : "bg-amber-50 text-warn",
                )}
              >
                {online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                {online ? "متصل" : "دون اتصال"}
              </span>
              <Link
                href="/pos"
                className="hidden rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 sm:block"
              >
                بيع سريع
              </Link>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl p-4 sm:p-6">{offlineNotice ? <div role="status" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{offlineNotice}</div> : null}{featureDenied ? <div dir="rtl" className="mx-auto mt-10 max-w-lg rounded-2xl border border-amber-200 bg-white p-7 text-center shadow-sm"><div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-amber-50 text-amber-600"><Sparkles size={22}/></div><h1 className="mt-4 text-lg font-bold">الميزة غير متوفرة في باقتك</h1><p className="mt-2 text-sm leading-6 text-ink-500">هذه الميزة متوفرة في باقة Plus أو Premium. قم بترقية اشتراكك للاستفادة منها.</p><Link href="/subscription" className="mt-5 inline-flex rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white">عرض الاشتراك والباقة</Link></div> : children}</main>
      </div>
    </div>
  );
}
