import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route } from "@/server/api";
import { requirePermission } from "@/server/auth";
import {
  deactivateProduct,
  getProductDetail,
  updateProduct,
} from "@/server/services/products";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.productsRead);
    const { id } = await params;
    const product = await transaction((tx) => getProductDetail(tx, session.businessId, id));
    return ok({ product });
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.productsWrite);
    const { id } = await params;
    const body = await readJson(request);
    const product = await transaction((tx) => updateProduct(tx, session, id, body));
    return ok({ product });
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.productsWrite);
    const { id } = await params;
    const result = await transaction((tx) => deactivateProduct(tx, session, id));
    return ok(result);
  });
}
