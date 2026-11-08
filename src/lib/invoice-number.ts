import { and, eq, sql } from "drizzle-orm";
import { invoiceSequences } from "@/db/schema";
import { DOC_PREFIX } from "@/lib/constants";
import type { Tx } from "@/db/client";

/**
 * Generates the next sequential document number per business and document type.
 * The UPDATE acquires a row lock, so concurrent transactions cannot reuse a number.
 */
export async function nextDocumentNo(
  tx: Tx,
  businessId: string,
  docType: string,
  prefix = DOC_PREFIX[docType] ?? "",
  width = 6,
): Promise<string> {
  await tx
    .insert(invoiceSequences)
    .values({ businessId, docType, prefix, nextNumber: 1 })
    .onConflictDoNothing();

  const [row] = await tx
    .update(invoiceSequences)
    .set({ nextNumber: sql`${invoiceSequences.nextNumber} + 1` })
    .where(and(eq(invoiceSequences.businessId, businessId), eq(invoiceSequences.docType, docType)))
    .returning();

  const number = row.nextNumber - 1;
  return `${row.prefix}${String(number).padStart(width, "0")}`;
}
