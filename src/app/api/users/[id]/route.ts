import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route } from "@/server/api";
import { requirePermission } from "@/server/auth";
import {
  resetMemberPassword,
  updateMemberRole,
} from "@/server/services/admin";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.usersManage);
    const { id } = await params;
    const body = (await readJson(request)) as { role?: string; password?: string };
    const result = await transaction(async (tx) => {
      if (body.password) {
        await resetMemberPassword(tx, session, id, body.password);
      }
      if (body.role) {
        return updateMemberRole(tx, session, id, { role: body.role });
      }
      return { ok: true };
    });
    return ok(result);
  });
}
