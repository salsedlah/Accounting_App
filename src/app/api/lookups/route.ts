import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS, ROLE_PERMISSIONS } from "@/lib/constants";
import { ok, route } from "@/server/api";
import { requireSession } from "@/server/auth";
import { listCategories, listUnits, listWarehouses } from "@/server/services/products";
import { listSuppliers } from "@/server/services/parties";
import { listCashboxes } from "@/server/services/cashbox";
import { loadBusiness } from "@/server/services/common";

export async function GET() {
  return route(async () => {
    await ensureReady();
    const session = await requireSession();
    const data = await transaction(async (tx) => {
      const [categories, units, warehouses, suppliers, cashboxes, business] = await Promise.all([
        listCategories(tx, session.businessId),
        listUnits(tx, session.businessId),
        listWarehouses(tx, session.businessId),
        listSuppliers(tx, session.businessId),
        listCashboxes(tx, session.businessId),
        loadBusiness(tx, session.businessId),
      ]);
      return {
        categories,
        units,
        warehouses,
        suppliers,
        cashboxes,
        business,
        permissions: ROLE_PERMISSIONS[session.role] ?? [],
      };
    });
    void PERMISSIONS;
    return ok(data);
  });
}
