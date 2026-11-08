import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route, searchParams } from "@/server/api";
import { requireCapacity, requirePermission } from "@/server/auth";
import { createProduct, listProducts } from "@/server/services/products";

export async function GET(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.productsRead);
    const params = searchParams(request);
    const result = await transaction((tx) =>
      listProducts(tx, session.businessId, {
        warehouseId: params.get("warehouseId") ?? undefined,
        search: params.get("search") ?? undefined,
        includeInactive: params.get("all") === "1",
      }),
    );
    return ok(result);
  });
}

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.productsWrite);
    await requireCapacity(session, "products");
    const body = await readJson(request);
    const product = await transaction((tx) => createProduct(tx, session, body));
    return ok({ product }, 201);
  });
}
