import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, route } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { getCustomerStatement } from "@/server/services/parties";

type Params = { params: Promise<{ customerId: string }> };

export async function GET(_request: Request, { params }: Params) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.debtsManage);
    const { customerId } = await params;
    const statement = await transaction((tx) =>
      getCustomerStatement(tx, session.businessId, customerId),
    );
    return ok(statement);
  });
}
