import { ensureReady } from "@/db/bootstrap";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { DebtsClient } from "../debts/debts-client";

export const metadata = { title: "ديون الموردين" };
export const dynamic = "force-dynamic";

export default async function SupplierDebtsPage() {
  await ensureReady();
  await requirePermission(PERMISSIONS.purchasesRead);
  return <DebtsClient mode="suppliers" />;
}
