import { z } from "zod";
import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { AppError, ok, readJson, route } from "@/server/api";
import { assertPermission } from "@/server/auth";
import {
  createBusinessBackup,
  restoreBusinessBackup,
} from "@/server/services/cloud-backup";
import { requireCloudSession } from "@/server/services/cloud-sync";

const schema = z.object({
  confirmation: z.literal("RESTORE_BACKUP"),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return route(async () => {
    await ensureReady();
    const session = await requireCloudSession();
    await assertPermission(session, PERMISSIONS.settingsManage);
    if (session.role !== "owner") {
      throw new AppError("استعادة النسخ السحابية متاحة لمالك النشاط فقط", 403);
    }
    const { id } = await context.params;
    schema.parse(await readJson(request));

    const result = await transaction(async (tx) => {
      // Always snapshot the current state first. If the restore fails, the
      // transaction rolls back and the safety backup row is not committed.
      const safety = await createBusinessBackup(tx, session, "safety");
      const restored = await restoreBusinessBackup(tx, session, id, {
        safetyBackupId: safety.backup.id,
      });
      return { ...restored, safetyBackupId: safety.backup.id };
    });

    return ok({
      ...result,
      message: "تمت استعادة النسخة السحابية بعد إنشاء نسخة أمان.",
    });
  });
}
