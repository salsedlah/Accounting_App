import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, route } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { getSaleDetail } from "@/server/services/sales";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.salesRead);
    const { id } = await params;
    const sale = await transaction((tx) => getSaleDetail(tx, session.businessId, id));
    return ok({ sale });
  });
}
