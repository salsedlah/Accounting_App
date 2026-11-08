import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { createManualCash } from "@/server/services/cashbox";

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.cashboxManage);
    const body = await readJson(request);
    const result = await transaction((tx) => createManualCash(tx, session, body));
    return ok(result, 201);
  });
}
