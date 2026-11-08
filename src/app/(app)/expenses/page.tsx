import { ensureReady } from "@/db/bootstrap";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { ExpensesClient } from "./expenses-client";

export const metadata = { title: "المصروفات" };
export const dynamic = "force-dynamic";

export default async function ExpensesPage() {
  await ensureReady();
  await requirePermission(PERMISSIONS.expensesCreate);
  return <ExpensesClient />;
}
