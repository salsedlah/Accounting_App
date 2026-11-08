import { ensureReady } from "@/db/bootstrap";
import { requirePermission } from "@/server/auth";
import { PERMISSIONS } from "@/lib/constants";
import { ProductsClient } from "./products-client";

export const metadata = { title: "المنتجات" };
export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  await ensureReady();
  await requirePermission(PERMISSIONS.productsRead);
  return <ProductsClient />;
}
