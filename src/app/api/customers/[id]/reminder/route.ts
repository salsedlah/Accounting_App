import { z } from "zod";
import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { markReminderSent, prepareCustomerReminder } from "@/server/services/parties";

type Params = { params: Promise<{ id: string }> };

const schema = z.object({
  action: z.enum(["prepare", "sent"]),
  eventId: z.string().uuid().optional(),
  channel: z.enum(["whatsapp", "in_app"]).default("whatsapp"),
});

export async function POST(request: Request, { params }: Params) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.debtsManage);
    const { id } = await params;
    const input = schema.parse(await readJson(request));
    if (input.action === "sent") {
      if (!input.eventId) return ok({ error: "eventId مطلوب" }, 422);
      const result = await transaction((tx) => markReminderSent(tx, session, input.eventId!));
      return ok(result);
    }
    const result = await transaction((tx) =>
      prepareCustomerReminder(tx, session, id, input.channel),
    );
    return ok(result);
  });
}
