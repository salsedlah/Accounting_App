import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route, searchParams } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { createPayment, listPayments } from "@/server/services/payments";

export async function GET(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.debtsManage);
    const params = searchParams(request);
    const rows = await transaction((tx) =>
      listPayments(tx, session.businessId, Number(params.get("limit") ?? 100)),
    );
    return ok({ payments: rows });
  });
}

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.paymentsCreate);
    const body = await readJson(request);
    const result = await transaction((tx) => createPayment(tx, session, body));
    return ok(result, result.duplicate ? 200 : 201);
  });
}
