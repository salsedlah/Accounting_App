import { redirect } from "next/navigation";
import { ensureReady } from "@/db/bootstrap";
import { getSession } from "@/server/auth";
import { AppShell } from "@/components/app-shell";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await ensureReady();
  const session = await getSession().catch(() => null);
  if (!session) redirect("/login");
  if (session.role === "super_admin") redirect("/platform");
  return <AppShell session={session}>{children}</AppShell>;
}
