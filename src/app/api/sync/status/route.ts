import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { ok, route, searchParams } from "@/server/api";
import { getSyncStatus, requireCloudSession } from "@/server/services/cloud-sync";

export async function GET(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requireCloudSession();
    const params = searchParams(request);
    const deviceId = params.get("deviceId")?.trim() || null;
    const status = await transaction((tx) => getSyncStatus(tx, session, deviceId));
    return ok(status);
  });
}
