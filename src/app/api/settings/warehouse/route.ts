import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { createWarehouse } from "@/server/services/products";
import { updateWarehouse } from "@/server/services/admin";

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.settingsManage);
    const body = (await readJson(request)) as { name?: string; isDefault?: boolean };
    if (!body.name) return ok({ error: "اسم المخزن مطلوب" }, 422);
    const warehouse = await transaction((tx) =>
      createWarehouse(tx, session, { name: body.name!, isDefault: body.isDefault }),
    );
    return ok({ warehouse }, 201);
  });
}

export async function PATCH(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.settingsManage);
    const body = (await readJson(request)) as {
      id?: string;
      name?: string;
      isDefault?: boolean;
      isActive?: boolean;
    };
    if (!body.id) return ok({ error: "id مطلوب" }, 422);
    const result = await transaction((tx) =>
      updateWarehouse(tx, session, body.id!, {
        name: body.name,
        isDefault: body.isDefault,
        isActive: body.isActive,
      }),
    );
    return ok(result);
  });
}
