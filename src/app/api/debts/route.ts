import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { createCustomerDebt, getDebtSummary } from "@/server/services/parties";

export async function GET() {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.debtsManage);
    const data = await transaction((tx) => getDebtSummary(tx, session.businessId));
    return ok(data);
  });
}

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.debtsManage);
    const body = await readJson(request);
    const result = await transaction((tx) => createCustomerDebt(tx, session, body));
    return ok(result, 201);
  });
}
