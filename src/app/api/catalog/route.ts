import { z } from "zod";
import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { createCategory, createUnit, listCategories, listUnits } from "@/server/services/products";

export async function GET() {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.productsRead);
    const data = await transaction(async (tx) => ({
      categories: await listCategories(tx, session.businessId),
      units: await listUnits(tx, session.businessId),
    }));
    return ok(data);
  });
}

const bodySchema = z.union([
  z.object({ type: z.literal("category"), name: z.string().min(1) }),
  z.object({
    type: z.literal("unit"),
    name: z.string().min(1),
    symbol: z.string().min(1),
    kind: z.string().optional(),
  }),
]);

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.settingsManage);
    const input = bodySchema.parse(await readJson(request));
    const result = await transaction((tx) =>
      input.type === "category"
        ? createCategory(tx, session, input.name)
        : createUnit(tx, session, { name: input.name, symbol: input.symbol, kind: input.kind }),
    );
    return ok(result, 201);
  });
}
