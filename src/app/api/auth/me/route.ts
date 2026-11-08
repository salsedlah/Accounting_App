import { ensureReady } from "@/db/bootstrap";
import { requireSession } from "@/server/auth";
import { getEffectivePermissions } from "@/server/auth";
import { ok, route } from "@/server/api";

export async function GET() {
  return route(async () => {
    await ensureReady();
    const session = await requireSession();
    const permissions = await getEffectivePermissions(session);
    return ok({
      session,
      permissions,
    });
  });
}
