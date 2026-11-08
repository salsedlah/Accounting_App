import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route } from "@/server/api";
import { getAvailablePermissions, getEffectivePermissions, requireCapacity, requirePermission } from "@/server/auth";
import {
  createMember,
  listAuditLogs,
  listMembers,
  permissionMatrix,
} from "@/server/services/admin";

export async function GET() {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.usersManage);
    const [members, audit, availablePermissions] = await Promise.all([
      transaction((tx) => listMembers(tx, session.businessId)),
      transaction((tx) => listAuditLogs(tx, session.businessId, 50)),
      getAvailablePermissions(session),
    ]);
    const membersWithPermissions = await Promise.all(members.map(async (member) => ({
      ...member,
      permissions: await getEffectivePermissions({ ...session, userId: member.id, name: member.name, email: member.email, role: member.role }),
    })));
    return ok({ members: membersWithPermissions, matrix: permissionMatrix(), audit, availablePermissions });
  });
}

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.usersManage);
    await requireCapacity(session, "users");
    const body = await readJson(request);
    const result = await transaction((tx) => createMember(tx, session, body));
    return ok(result, 201);
  });
}
