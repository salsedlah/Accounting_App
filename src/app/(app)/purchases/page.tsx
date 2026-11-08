import { ensureReady } from "@/db/bootstrap";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { PurchasesClient } from "./purchases-client";

export const metadata = { title: "المشتريات" };
export const dynamic = "force-dynamic";

export default async function PurchasesPage() {
  await ensureReady();
  await requirePermission(PERMISSIONS.purchasesRead);
  return <PurchasesClient />;
}
