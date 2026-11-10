import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { AppError, ok, route, searchParams } from "@/server/api";
import { assertPermission } from "@/server/auth";
import { createBusinessBackup, listBusinessBackups } from "@/server/services/cloud-backup";
import { requireCloudSession } from "@/server/services/cloud-sync";

export async function GET(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requireCloudSession();
    const limit = Number(searchParams(request).get("limit") ?? "100");
    const backups = await transaction((tx) =>
      listBusinessBackups(tx, session.businessId, Number.isFinite(limit) ? limit : 100),
    );
    return ok({ backups });
  });
}

export async function POST() {
  return route(async () => {
    await ensureReady();
    const session = await requireCloudSession();
    await assertPermission(session, PERMISSIONS.settingsManage);
    if (session.role !== "owner") {
      throw new AppError("إنشاء النسخ السحابية متاح لمالك النشاط فقط", 403);
    }
    const result = await transaction((tx) => createBusinessBackup(tx, session, "manual"));
    return ok(result, result.duplicate ? 200 : 201);
  });
}
