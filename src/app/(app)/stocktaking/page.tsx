import { ensureReady } from "@/db/bootstrap";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { StocktakingClient } from "./stocktaking-client";

export const metadata = { title: "الجرد" };
export const dynamic = "force-dynamic";

export default async function StocktakingPage() {
  await ensureReady();
  await requirePermission(PERMISSIONS.stocktakingManage);
  return <StocktakingClient />;
}
