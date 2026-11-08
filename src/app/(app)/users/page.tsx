import { ensureReady } from "@/db/bootstrap";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { UsersClient } from "./users-client";

export const metadata = { title: "المستخدمون" };
export const dynamic = "force-dynamic";

export default async function UsersPage() {
  await ensureReady();
  await requirePermission(PERMISSIONS.usersManage);
  return <UsersClient />;
}
