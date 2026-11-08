import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route, searchParams } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { createSale, listSales } from "@/server/services/sales";

export async function GET(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.salesRead);
    const params = searchParams(request);
    const kindParam = params.get("kind");
    const kind = kindParam === "return" || kindParam === "sale" ? kindParam : undefined;
    const rows = await transaction((tx) =>
      listSales(tx, session.businessId, Number(params.get("limit") ?? 100), kind),
    );
    return ok({ sales: rows });
  });
}

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.salesCreate);
    const body = await readJson(request);
    const result = await transaction((tx) => createSale(tx, session, body));
    return ok(result, result.duplicate ? 200 : 201);
  });
}
