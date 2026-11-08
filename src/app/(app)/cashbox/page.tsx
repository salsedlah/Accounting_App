import { ensureReady } from "@/db/bootstrap";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { CashboxClient } from "./cashbox-client";

export const metadata = { title: "الصندوق" };
export const dynamic = "force-dynamic";

export default async function CashboxPage() {
  await ensureReady();
  await requirePermission(PERMISSIONS.cashboxManage);
  return <CashboxClient />;
}
