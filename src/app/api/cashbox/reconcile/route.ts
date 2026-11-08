import { z } from "zod";
import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { parseMoney } from "@/lib/money";
import { ok, readJson, route } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { reconcileCashbox } from "@/server/services/cashbox";

const schema = z.object({
  cashboxId: z.string().uuid(),
  counted: z.string().min(1),
});

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.cashboxManage);
    const input = schema.parse(await readJson(request));
    const result = await transaction((tx) =>
      reconcileCashbox(tx, session.businessId, input.cashboxId, parseMoney(input.counted)),
    );
    return ok(result);
  });
}
