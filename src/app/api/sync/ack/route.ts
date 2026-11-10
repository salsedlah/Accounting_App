import { z } from "zod";
import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { ok, readJson, route } from "@/server/api";
import { acknowledgeCursor, requireCloudSession } from "@/server/services/cloud-sync";

const schema = z.object({
  deviceId: z.string().min(1).max(120),
  lastChangeId: z.number().int().min(0),
});

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requireCloudSession();
    const input = schema.parse(await readJson(request));
    const result = await transaction((tx) => acknowledgeCursor(tx, session, input));
    return ok(result);
  });
}
