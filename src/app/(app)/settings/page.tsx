import { ensureReady } from "@/db/bootstrap";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { SettingsClient } from "./settings-client";

export const metadata = { title: "الإعدادات" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await ensureReady();
  await requirePermission(PERMISSIONS.settingsManage);
  return <SettingsClient />;
}
