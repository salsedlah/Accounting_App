import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, route, searchParams } from "@/server/api";
import { requireBusinessFeature, requirePermission } from "@/server/auth";
import { listDocuments } from "@/server/services/reports";

export async function GET(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.reportsRead);
    await requireBusinessFeature(session, "invoices");
    const documents = await transaction((tx) =>
      listDocuments(tx, session.businessId, Number(searchParams(request).get("limit") ?? 100)),
    );
    return ok({ documents });
  });
}
