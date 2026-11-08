import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route } from "@/server/api";
import { requirePermission } from "@/server/auth";
import {
  approveStocktake,
  getStocktakeDetail,
  postStocktake,
  saveStocktakeCounts,
  submitStocktake,
} from "@/server/services/stocktaking";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.stocktakingManage);
    const { id } = await params;
    const data = await transaction((tx) =>
      getStocktakeDetail(tx, session.businessId, id),
    );
    return ok(data);
  });
}

export async function POST(request: Request, { params }: Params) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.stocktakingManage);
    const { id } = await params;
    const body = (await readJson(request)) as {
      action?: "counts" | "submit" | "approve" | "post";
      counts?: Array<{ itemId: string; countedQty: string }>;
    };
    const action = body?.action ?? "counts";
    const result = await transaction(async (tx) => {
      if (action === "counts") {
        return saveStocktakeCounts(tx, session, {
          sessionId: id,
          counts: body.counts ?? [],
        });
      }
      if (action === "submit") return submitStocktake(tx, session, id);
      if (action === "approve") return approveStocktake(tx, session, id);
      if (action === "post") return postStocktake(tx, session, id);
      throw new Error("إجراء غير معروف");
    });
    return ok(result);
  });
}
