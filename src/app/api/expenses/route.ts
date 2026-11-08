import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route, searchParams } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { createExpense, listExpenses } from "@/server/services/expenses";

export async function GET(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.expensesCreate);
    const params = searchParams(request);
    const rows = await transaction((tx) =>
      listExpenses(tx, session.businessId, Number(params.get("limit") ?? 100)),
    );
    return ok({ expenses: rows });
  });
}

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.expensesCreate);
    const body = await readJson(request);
    const result = await transaction((tx) => createExpense(tx, session, body));
    return ok(result, result.duplicate ? 200 : 201);
  });
}
