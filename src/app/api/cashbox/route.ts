import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, route } from "@/server/api";
import { requirePermission } from "@/server/auth";
import {
  listCashboxes,
  listCashTransactions,
} from "@/server/services/cashbox";

export async function GET() {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.cashboxManage);
    const data = await transaction(async (tx) => ({
      cashboxes: await listCashboxes(tx, session.businessId),
      transactions: await listCashTransactions(tx, session.businessId, 200),
    }));
    return ok(data);
  });
}
