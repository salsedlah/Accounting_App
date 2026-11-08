import { ensureReady } from "@/db/bootstrap";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { SupplierDetailClient } from "./supplier-detail";

export const dynamic = "force-dynamic";

export default async function SupplierPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await ensureReady();
  await requirePermission(PERMISSIONS.purchasesRead);
  const { id } = await params;
  return <SupplierDetailClient id={id} />;
}
