import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { ok, route, searchParams } from "@/server/api";
import { pullChanges, requireCloudSession } from "@/server/services/cloud-sync";

export async function GET(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requireCloudSession();
    const params = searchParams(request);
    const since = Number(params.get("since") ?? "0");
    const limit = Number(params.get("limit") ?? "200");
    const result = await transaction((tx) =>
      pullChanges(tx, session, {
        since: Number.isFinite(since) ? since : 0,
        limit: Number.isFinite(limit) ? limit : 200,
      }),
    );
    return ok(result);
  });
}
