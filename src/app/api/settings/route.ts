import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route } from "@/server/api";
import { requirePermission, requireSession } from "@/server/auth";
import { getSettings, updateSettings } from "@/server/services/admin";

export async function GET() {
  return route(async () => {
    await ensureReady();
    const session = await requireSession();
    const data = await transaction((tx) => getSettings(tx, session.businessId));
    return ok(data);
  });
}

export async function PATCH(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.settingsManage);
    const body = await readJson(request);
    const business = await transaction((tx) => updateSettings(tx, session, body));
    return ok({ business });
  });
}
