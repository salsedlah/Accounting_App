import { ensureReady } from "@/db/bootstrap";
import { clearSessionCookie } from "@/server/auth";
import { ok, route } from "@/server/api";

export async function POST() {
  return route(async () => {
    await ensureReady();
    await clearSessionCookie();
    return ok({ ok: true });
  });
}
