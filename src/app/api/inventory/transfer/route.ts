import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { transferInventory } from "@/server/services/inventory-ops";

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.inventoryAdjust);
    const body = await readJson(request);
    const result = await transaction((tx) => transferInventory(tx, session, body));
    return ok(result, 201);
  });
}
