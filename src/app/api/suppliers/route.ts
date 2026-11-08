import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route, searchParams } from "@/server/api";
import { requirePermission } from "@/server/auth";
import {
  createSupplier,
  listSuppliers,
} from "@/server/services/parties";

export async function GET(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.purchasesRead);
    const search = searchParams(request).get("search") ?? undefined;
    const suppliers = await transaction((tx) =>
      listSuppliers(tx, session.businessId, search),
    );
    return ok({ suppliers });
  });
}

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.purchasesCreate);
    const body = await readJson(request);
    const supplier = await transaction((tx) => createSupplier(tx, session, body));
    return ok({ supplier }, 201);
  });
}
