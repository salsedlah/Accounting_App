import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route, searchParams } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { createPurchase, listPurchases } from "@/server/services/purchases";

export async function GET(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.purchasesRead);
    const params = searchParams(request);
    const rows = await transaction((tx) =>
      listPurchases(tx, session.businessId, Number(params.get("limit") ?? 100)),
    );
    return ok({ purchases: rows });
  });
}

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.purchasesCreate);
    const body = await readJson(request);
    const result = await transaction((tx) => createPurchase(tx, session, body));
    return ok(result, result.duplicate ? 200 : 201);
  });
}
