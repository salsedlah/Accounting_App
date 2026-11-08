import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route, searchParams } from "@/server/api";
import { requirePermission } from "@/server/auth";
import {
  createCustomer,
  listCustomers,
  listReminders,
} from "@/server/services/parties";

export async function GET(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.customersRead);
    const search = searchParams(request).get("search") ?? undefined;
    const data = await transaction(async (tx) => ({
      customers: await listCustomers(tx, session.businessId, search),
      reminders: await listReminders(tx, session.businessId, 20),
    }));
    return ok(data);
  });
}

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.customersWrite);
    const body = await readJson(request);
    const customer = await transaction((tx) => createCustomer(tx, session, body));
    return ok({ customer }, 201);
  });
}
