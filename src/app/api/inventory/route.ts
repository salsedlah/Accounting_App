import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, route, searchParams } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { lowStock } from "@/server/services/reports";
import {
  listInventoryMovements,
  listInventoryOverview,
} from "@/server/services/inventory-ops";
import { listWarehouses } from "@/server/services/products";

export async function GET(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.inventoryRead);
    const warehouseId = searchParams(request).get("warehouseId") ?? undefined;
    const data = await transaction(async (tx) => ({
      balances: await listInventoryOverview(tx, session.businessId, warehouseId),
      movements: await listInventoryMovements(tx, session.businessId, 200),
      lowStock: await lowStock(tx, session.businessId),
      warehouses: await listWarehouses(tx, session.businessId),
    }));
    return ok(data);
  });
}
