import { ensureReady } from "../src/db/bootstrap";
import { closeDb, getDb } from "../src/db/client";
import { businesses, products, sales } from "../src/db/schema";

try {
  process.loadEnvFile?.(".env");
} catch {
  /* ignore missing env */
}

async function main() {
  await ensureReady();
  const db = await getDb();
  const [business] = await db.select().from(businesses);
  const productRows = await db.select().from(products);
  const saleRows = await db.select().from(sales);
  console.log("business:", business.name);
  console.log("products:", productRows.length);
  console.log("sales:", saleRows.length, saleRows.map((s) => s.invoiceNo).join(", "));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
