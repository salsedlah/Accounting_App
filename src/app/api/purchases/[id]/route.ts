import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, route } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { getPurchaseDetail } from "@/server/services/purchases";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.purchasesRead);
    const { id } = await params;
    const purchase = await transaction((tx) =>
      getPurchaseDetail(tx, session.businessId, id),
    );
    return ok({ purchase });
  });
}
