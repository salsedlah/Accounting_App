import { z } from "zod";
import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route, searchParams } from "@/server/api";
import { assertPermission } from "@/server/auth";
import {
  ensureCloudSettings,
  getSyncStatus,
  requireCloudSession,
  updateCloudSettings,
} from "@/server/services/cloud-sync";

export async function GET(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requireCloudSession();
    const deviceId = searchParams(request).get("deviceId")?.trim() || null;
    const result = await transaction(async (tx) => {
      const settings = await ensureCloudSettings(tx, session);
      const status = await getSyncStatus(tx, session, deviceId);
      return { settings, status };
    });
    return ok(result);
  });
}

const patchSchema = z.object({
  autoSync: z.boolean().optional(),
  autoBackup: z.boolean().optional(),
  backupIntervalHours: z.number().int().min(1).max(24 * 30).optional(),
});

export async function PATCH(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requireCloudSession();
    await assertPermission(session, PERMISSIONS.settingsManage);
    const input = patchSchema.parse(await readJson(request));
    const settings = await transaction((tx) => updateCloudSettings(tx, session, input));
    return ok({ settings });
  });
}
