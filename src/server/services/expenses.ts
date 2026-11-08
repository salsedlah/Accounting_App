import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db/client";
import { cashTransactions, expenses } from "@/db/schema";
import { ACCOUNT_CODES, PERMISSIONS, can } from "@/lib/constants";
import { postJournal } from "@/lib/accounting";
import { nextDocumentNo } from "@/lib/invoice-number";
import { parseMoney } from "@/lib/money";
import { AppError } from "@/server/api";
import type { Session } from "@/server/auth";
import { defaultCashbox, memberCan, writeAudit } from "./common";

export const expenseSchema = z.object({
  category: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  amount: z.string().min(1),
  cashboxId: z.string().uuid().nullish(),
  reference: z.string().max(200).optional(),
  paidAt: z.string().datetime().optional(),
  idempotencyKey: z.string().min(8).max(200),
});

export async function createExpense(tx: Tx, session: Session, raw: unknown) {
  const input = expenseSchema.parse(raw);
  if (!(await memberCan(tx, session, PERMISSIONS.expensesCreate))) {
    throw new AppError("لا تملك صلاحية تسجيل المصروفات", 403);
  }
  const [existing] = await tx
    .select()
    .from(expenses)
    .where(
      and(
        eq(expenses.businessId, session.businessId),
        eq(expenses.idempotencyKey, input.idempotencyKey),
      ),
    );
  if (existing) return { expense: existing, duplicate: true };

  const amount = parseMoney(input.amount);
  if (amount <= 0n) throw new AppError("المبلغ يجب أن يكون أكبر من صفر");
  const cashbox = await defaultCashbox(tx, session.businessId, input.cashboxId);
  const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
  const expenseNo = await nextDocumentNo(tx, session.businessId, "expense");
  const id = crypto.randomUUID();

  await tx.insert(expenses).values({
    id,
    businessId: session.businessId,
    expenseNo,
    category: input.category,
    description: input.description,
    amountMinor: amount,
    cashboxId: cashbox.id,
    reference: input.reference ?? null,
    userId: session.userId,
    idempotencyKey: input.idempotencyKey,
    paidAt,
  });

  const entry = await postJournal(tx, {
    businessId: session.businessId,
    memo: `مصروف ${expenseNo} - ${input.description}`,
    sourceType: "expense",
    sourceId: id,
    userId: session.userId,
    entryDate: paidAt,
    lines: [
      { accountCode: ACCOUNT_CODES.operatingExpenses, debit: amount },
      { accountCode: ACCOUNT_CODES.cash, credit: amount },
    ],
  });

  await tx.update(expenses).set({ journalEntryId: entry.id }).where(eq(expenses.id, id));

  await tx.insert(cashTransactions).values({
    businessId: session.businessId,
    cashboxId: cashbox.id,
    direction: "outflow",
    amountMinor: amount,
    sourceType: "expense",
    sourceId: id,
    description: `مصروف ${input.description} - ${expenseNo}`,
    journalEntryId: entry.id,
    userId: session.userId,
    createdAt: paidAt,
  });

  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "expense.create",
    entityType: "expense",
    entityId: id,
    after: { expenseNo, amount: amount.toString(), category: input.category },
  });

  const [expense] = await tx.select().from(expenses).where(eq(expenses.id, id));
  return { expense, duplicate: false };
}

export async function listExpenses(tx: Tx, businessId: string, limit = 100) {
  return tx
    .select()
    .from(expenses)
    .where(eq(expenses.businessId, businessId))
    .orderBy(desc(expenses.paidAt))
    .limit(limit);
}
