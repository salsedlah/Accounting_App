import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { ok, route } from "@/server/api";
import { requireBusinessFeature, requireSession } from "@/server/auth";
import { getDashboard } from "@/server/services/reports";

export async function GET() {
  return route(async () => {
    await ensureReady();
    const session = await requireSession();
    await requireBusinessFeature(session, "dashboard");
    const data = await transaction((tx) => getDashboard(tx, session.businessId));
    return ok(data);
  });
}
