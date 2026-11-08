import { ensureReady } from "@/db/bootstrap";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { DebtsClient } from "./debts-client";

export const metadata = { title: "ديون العملاء" };
export const dynamic = "force-dynamic";

export default async function DebtsPage() {
  await ensureReady();
  await requirePermission(PERMISSIONS.debtsManage);
  return <DebtsClient mode="customers" />;
}
