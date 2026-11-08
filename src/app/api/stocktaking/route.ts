import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route } from "@/server/api";
import { requirePermission } from "@/server/auth";
import {
  createStocktake,
  getStocktakeDetail,
  listStocktakes,
} from "@/server/services/stocktaking";

export async function GET() {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.stocktakingManage);
    const sessions = await transaction((tx) =>
      listStocktakes(tx, session.businessId, 100),
    );
    return ok({ sessions });
  });
}

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.stocktakingManage);
    const body = await readJson(request);
    const result = await transaction((tx) => createStocktake(tx, session, body));
    return ok(result, 201);
  });
}

export async function PUT(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.stocktakingManage);
    const body = (await readJson(request)) as { id?: string };
    if (!body?.id) return ok({ error: "id مطلوب" }, 422);
    const data = await transaction((tx) =>
      getStocktakeDetail(tx, session.businessId, body.id!),
    );
    return ok(data);
  });
}
