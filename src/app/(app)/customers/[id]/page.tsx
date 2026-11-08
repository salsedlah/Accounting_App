import { ensureReady } from "@/db/bootstrap";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { CustomerDetailClient } from "./customer-detail";

export const dynamic = "force-dynamic";

export default async function CustomerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await ensureReady();
  await requirePermission(PERMISSIONS.customersRead);
  const { id } = await params;
  return <CustomerDetailClient id={id} />;
}
