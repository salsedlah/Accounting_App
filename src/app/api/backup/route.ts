import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route, AppError } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { createDatabaseBackup, restoreDatabaseBackup } from "@/server/services/backup";

export async function GET() {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.settingsManage);
    if (session.role !== "owner") throw new AppError("النسخ الاحتياطي الكامل متاح لمالك النشاط فقط", 403);
    const backup = await transaction((tx) => createDatabaseBackup(tx));
    return ok(backup);
  });
}

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.settingsManage);
    if (session.role !== "owner") throw new AppError("استعادة قاعدة البيانات متاحة لمالك النشاط فقط", 403);
    const input = await readJson<{ confirmation?: string; backup?: unknown }>(request);
    if (input.confirmation !== "RESTORE_DATABASE") {
      throw new AppError("اكتب RESTORE_DATABASE لتأكيد استبدال قاعدة البيانات كاملة");
    }
    const result = await transaction((tx) => restoreDatabaseBackup(tx, input.backup));
    return ok({ ...result, message: "تمت استعادة قاعدة البيانات كاملة" });
  });
}
