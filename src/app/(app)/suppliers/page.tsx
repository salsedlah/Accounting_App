import { ensureReady } from "@/db/bootstrap";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { SuppliersClient } from "./suppliers-client";

export const metadata = { title: "الموردون" };
export const dynamic = "force-dynamic";

export default async function SuppliersPage() {
  await ensureReady();
  await requirePermission(PERMISSIONS.purchasesRead);
  return <SuppliersClient />;
}
