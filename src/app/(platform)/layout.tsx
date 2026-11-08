import Link from "next/link";
import { redirect } from "next/navigation";
import { BarChart3, Building2, CreditCard, LayoutDashboard, Layers3 } from "lucide-react";
import { ensureReady } from "@/db/bootstrap";
import { requirePlatformAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";
const links = [
  ["/platform", "إدارة المنصة", LayoutDashboard],
  ["/platform/businesses", "إدارة المؤسسات", Building2],
  ["/platform/plans", "الباقات والميزات", Layers3],
  ["/platform/billing", "الاشتراكات والفوترة", CreditCard],
] as const;

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  await ensureReady();
  const admin = await requirePlatformAdmin().catch(() => null);
  if (!admin) redirect("/login?next=%2Fplatform");
  return <div dir="rtl" className="min-h-screen bg-[#f5f7fb] text-slate-900 lg:flex">
    <aside className="flex w-full shrink-0 flex-col bg-[#111b32] text-white lg:fixed lg:inset-y-0 lg:right-0 lg:w-64">
      <div className="flex items-center gap-3 border-b border-white/10 px-6 py-6"><div className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-500 font-bold">ح</div><div><p className="font-bold">حساب</p><p className="text-xs text-slate-400">إدارة المنصة</p></div></div>
      <nav className="flex gap-1 overflow-x-auto p-3 lg:flex-col">{links.map(([href, label, Icon]) => <Link key={href} href={href} className="flex shrink-0 items-center gap-3 rounded-xl px-4 py-3 text-sm text-slate-300 transition hover:bg-white/10 hover:text-white"><Icon size={18}/>{label}</Link>)}</nav>
      <div className="mt-auto hidden border-t border-white/10 px-6 py-5 text-xs text-slate-400 lg:block">منطقة آمنة لمالك المنصة</div>
    </aside>
    <main className="min-w-0 flex-1 p-4 sm:p-7 lg:mr-64 lg:p-9">{children}</main>
  </div>;
}
