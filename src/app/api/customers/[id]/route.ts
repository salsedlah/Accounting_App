import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { getCustomerStatement, updateCustomer } from "@/server/services/parties";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.customersRead);
    const { id } = await params;
    const data = await transaction((tx) => getCustomerStatement(tx, session.businessId, id));
    return ok(data);
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.customersWrite);
    const { id } = await params;
    const body = await readJson(request);
    const result = await transaction((tx) => updateCustomer(tx, session, id, body));
    return ok(result);
  });
}
