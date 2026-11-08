import { ensureReady } from "@/db/bootstrap";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { InventoryClient } from "./inventory-client";

export const metadata = { title: "المخزون" };
export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  await ensureReady();
  await requirePermission(PERMISSIONS.inventoryRead);
  return <InventoryClient />;
}
