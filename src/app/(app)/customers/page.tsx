import { ensureReady } from "@/db/bootstrap";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { CustomersClient } from "./customers-client";

export const metadata = { title: "العملاء" };
export const dynamic = "force-dynamic";

export default async function CustomersPage() {
  await ensureReady();
  await requirePermission(PERMISSIONS.customersRead);
  return <CustomersClient />;
}
