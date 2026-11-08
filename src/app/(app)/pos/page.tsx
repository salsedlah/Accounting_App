import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { ensureReady } from "@/db/bootstrap";
import { PosClient } from "./pos-client";

export const metadata = { title: "نقطة البيع" };
export const dynamic = "force-dynamic";

export default async function PosPage() {
  await ensureReady();
  const session = await requirePermission(PERMISSIONS.salesCreate);
  return <PosClient role={session.role} />;
}
