import { z } from "zod";
import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { ok, readJson, route } from "@/server/api";
import {
  acknowledgeCursor,
  getSyncStatus,
  pullChanges,
  requireCloudSession,
} from "@/server/services/cloud-sync";
import { runAutoBackupIfDue } from "@/server/services/cloud-maintenance";

const schema = z.object({
  deviceId: z.string().max(120).optional(),
  since: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  ack: z
    .object({
      deviceId: z.string().min(1).max(120),
      lastChangeId: z.number().int().min(0),
    })
    .optional(),
  createBackup: z.boolean().optional(),
});

/**
 * One round-trip used by mobile clients on start/login/reconnect:
 * optional cursor acknowledgement, pull a page of cloud changes, return
 * status, and create an automatic backup when one is due.
 */
export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requireCloudSession();
    const input = schema.parse(await readJson(request).catch(() => ({})));

    const payload = await transaction(async (tx) => {
      if (input.ack) await acknowledgeCursor(tx, session, input.ack);
      const status = await getSyncStatus(tx, session, input.deviceId ?? input.ack?.deviceId ?? null);
      const pull = await pullChanges(tx, session, {
        since: input.since ?? 0,
        limit: input.limit ?? 200,
      });
      return { status, ...pull };
    });

    const autoBackup = await runAutoBackupIfDue(session, { force: input.createBackup === true });
    return ok({ ...payload, autoBackup });
  });
}
