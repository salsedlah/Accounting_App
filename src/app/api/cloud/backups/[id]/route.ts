import { and, eq } from "drizzle-orm";
import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { cloudBackups } from "@/db/schema";
import { AppError, ok, route, searchParams } from "@/server/api";
import { requireCloudSession } from "@/server/services/cloud-sync";
import { loadBusinessBackup } from "@/server/services/cloud-backup";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return route(async () => {
    await ensureReady();
    const session = await requireCloudSession();
    const { id } = await context.params;
    const includeData = searchParams(request).get("includeData") === "1";
    if (includeData && session.role !== "owner") {
      throw new AppError("تحميل محتوى النسخة متاح لمالك النشاط فقط", 403);
    }

    if (includeData) {
      const { backup, data } = await transaction((tx) =>
        loadBusinessBackup(tx, session.businessId, id),
      );
      return ok({ backup, data });
    }

    const [backup] = await transaction((tx) =>
      tx
        .select({
          id: cloudBackups.id,
          businessId: cloudBackups.businessId,
          userId: cloudBackups.userId,
          createdByUserId: cloudBackups.createdByUserId,
          kind: cloudBackups.kind,
          status: cloudBackups.status,
          formatVersion: cloudBackups.formatVersion,
          sizeBytes: cloudBackups.sizeBytes,
          checksum: cloudBackups.checksum,
          storagePath: cloudBackups.storagePath,
          metadata: cloudBackups.metadata,
          error: cloudBackups.error,
          createdAt: cloudBackups.createdAt,
          restoredAt: cloudBackups.restoredAt,
        })
        .from(cloudBackups)
        .where(and(eq(cloudBackups.id, id), eq(cloudBackups.businessId, session.businessId)))
        .limit(1),
    );
    if (!backup) throw new AppError("النسخة الاحتياطية غير موجودة", 404);
    return ok({ backup });
  });
}
