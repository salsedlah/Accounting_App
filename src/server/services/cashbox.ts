import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db/client";
import { cashTransactions, cashboxes } from "@/db/schema";
import { ACCOUNT_CODES, PERMISSIONS, can } from "@/lib/constants";
import { postJournal } from "@/lib/accounting";
import { parseMoney } from "@/lib/money";
import { AppError } from "@/server/api";
import type { Session } from "@/server/auth";
import { defaultCashbox, memberCan, writeAudit } from "./common";

export const manualCashSchema = z.object({
  cashboxId: z.string().uuid().nullish(),
  direction: z.enum(["inflow", "outflow"]),
  amount: z.string().min(1),
  description: z.string().min(1).max(500),
  occurredAt: z.string().datetime().optional(),
});

export async function listCashboxes(tx: Tx, businessId: string) {
  const rows = await tx
    .select({
      id: cashboxes.id,
      name: cashboxes.name,
      openingBalanceMinor: cashboxes.openingBalanceMinor,
      isDefault: cashboxes.isDefault,
      isActive: cashboxes.isActive,
      inflow: sql<string>`coalesce(sum(case when ${cashTransactions.direction} = 'inflow' then ${cashTransactions.amountMinor} else 0 end), 0)`,
      outflow: sql<string>`coalesce(sum(case when ${cashTransactions.direction} = 'outflow' then ${cashTransactions.amountMinor} else 0 end), 0)`,
    })
    .from(cashboxes)
    .leftJoin(cashTransactions, eq(cashTransactions.cashboxId, cashboxes.id))
    .where(eq(cashboxes.businessId, businessId))
    .groupBy(
      cashboxes.id,
      cashboxes.name,
      cashboxes.openingBalanceMinor,
      cashboxes.isDefault,
      cashboxes.isActive,
    )
    .orderBy(desc(cashboxes.isDefault));

  return rows.map((r) => {
    const inflow = BigInt(r.inflow);
    const outflow = BigInt(r.outflow);
    return { ...r, inflowMinor: inflow, outflowMinor: outflow, expectedBalanceMinor: r.openingBalanceMinor + inflow - outflow };
  });
}

export async function createManualCash(tx: Tx, session: Session, raw: unknown) {
  const input = manualCashSchema.parse(raw);
  if (!(await memberCan(tx, session, PERMISSIONS.cashboxManage))) {
    throw new AppError("لا تملك صلاحية إدارة الصندوق", 403);
  }
  const amount = parseMoney(input.amount);
  if (amount <= 0n) throw new AppError("المبلغ يجب أن يكون أكبر من صفر");
  const cashbox = await defaultCashbox(tx, session.businessId, input.cashboxId);
  const at = input.occurredAt ? new Date(input.occurredAt) : new Date();
  const sourceId = crypto.randomUUID();
  const isDeposit = input.direction === "inflow";

  const entry = await postJournal(tx, {
    businessId: session.businessId,
    memo: `${isDeposit ? "إيداع نقدي" : "سحب نقدي"} - ${input.description}`,
    sourceType: "cash_manual",
    sourceId,
    userId: session.userId,
    entryDate: at,
    lines: isDeposit
      ? [
          { accountCode: ACCOUNT_CODES.cash, debit: amount },
          { accountCode: ACCOUNT_CODES.capital, credit: amount },
        ]
      : [
          { accountCode: ACCOUNT_CODES.drawings, debit: amount },
          { accountCode: ACCOUNT_CODES.cash, credit: amount },
        ],
  });

  await tx.insert(cashTransactions).values({
    businessId: session.businessId,
    cashboxId: cashbox.id,
    direction: input.direction,
    amountMinor: amount,
    sourceType: "cash_manual",
    sourceId,
    description: input.description,
    journalEntryId: entry.id,
    userId: session.userId,
    createdAt: at,
  });

  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: isDeposit ? "cashbox.deposit" : "cashbox.withdrawal",
    entityType: "cashbox",
    entityId: cashbox.id,
    after: { amount: amount.toString(), description: input.description },
  });

  return { ok: true, entryId: entry.id };
}

export async function listCashTransactions(tx: Tx, businessId: string, limit = 100) {
  return tx
    .select({
      id: cashTransactions.id,
      cashboxId: cashTransactions.cashboxId,
      direction: cashTransactions.direction,
      amountMinor: cashTransactions.amountMinor,
      sourceType: cashTransactions.sourceType,
      description: cashTransactions.description,
      createdAt: cashTransactions.createdAt,
      cashboxName: cashboxes.name,
    })
    .from(cashTransactions)
    .innerJoin(cashboxes, eq(cashboxes.id, cashTransactions.cashboxId))
    .where(eq(cashTransactions.businessId, businessId))
    .orderBy(desc(cashTransactions.createdAt))
    .limit(limit);
}

export async function reconcileCashbox(
  tx: Tx,
  businessId: string,
  cashboxId: string,
  counted: bigint,
) {
  const [row] = await tx
    .select()
    .from(cashboxes)
    .where(and(eq(cashboxes.id, cashboxId), eq(cashboxes.businessId, businessId)));
  if (!row) throw new AppError("الصندوق غير موجود", 404);
  const [sums] = await tx
    .select({
      inflow: sql<string>`coalesce(sum(case when ${cashTransactions.direction} = 'inflow' then ${cashTransactions.amountMinor} else 0 end), 0)`,
      outflow: sql<string>`coalesce(sum(case when ${cashTransactions.direction} = 'outflow' then ${cashTransactions.amountMinor} else 0 end), 0)`,
    })
    .from(cashTransactions)
    .where(and(eq(cashTransactions.businessId, businessId), eq(cashTransactions.cashboxId, cashboxId)));
  const expected =
    row.openingBalanceMinor + BigInt(sums.inflow) - BigInt(sums.outflow);
  return { expectedMinor: expected, countedMinor: counted, differenceMinor: counted - expected };
}
