import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, route } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { listProducts } from "@/server/services/products";
import { listCustomers } from "@/server/services/parties";
import { listCashboxes } from "@/server/services/cashbox";
import { loadBusiness } from "@/server/services/common";

export async function GET() {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.salesCreate);
    const data = await transaction(async (tx) => {
      const [catalog, customers, cashboxes, business] = await Promise.all([
        listProducts(tx, session.businessId),
        listCustomers(tx, session.businessId),
        listCashboxes(tx, session.businessId),
        loadBusiness(tx, session.businessId),
      ]);
      return {
        products: catalog.products,
        warehouse: catalog.warehouse,
        customers,
        cashboxes,
        business: {
          currency: business.currency,
          taxEnabled: business.taxEnabled,
          taxRateBp: business.taxRateBp,
          offlineSellLimitMilli: business.offlineSellLimitMilli,
        },
      };
    });
    return ok(data);
  });
}
