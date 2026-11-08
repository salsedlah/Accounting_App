import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { sales } from "@/db/schema";

export async function countOpenSales(db: DB, businessId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(sales)
    .where(and(eq(sales.businessId, businessId), eq(sales.kind, "sale")));
  return Number(row.count);
}
