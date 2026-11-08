import { ensureReady } from "@/db/bootstrap";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { AiClient } from "./ai-client";

export const metadata = { title: "المساعد الذكي" };
export const dynamic = "force-dynamic";

export default async function AiPage() {
  await ensureReady();
  await requirePermission(PERMISSIONS.aiAsk);
  return <AiClient />;
}
