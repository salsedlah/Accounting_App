import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { accounts, journalEntries, journalLines } from "@/db/schema";
import { ACCOUNT_CODES } from "@/lib/constants";
import { nextDocumentNo } from "@/lib/invoice-number";

export type JournalLineInput = {
  accountCode: string;
  debit?: bigint;
  credit?: bigint;
  description?: string;
};

export type PostJournalInput = {
  businessId: string;
  memo: string;
  sourceType: string;
  sourceId?: string | null;
  userId?: string | null;
  entryDate?: Date;
  lines: JournalLineInput[];
};

export class AccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountingError";
  }
}

/**
 * Posts an immutable double-entry journal entry. Debits must equal credits and
 * every line must reference a known account belonging to the business.
 */
export async function postJournal(tx: Tx, input: PostJournalInput) {
  const lines = input.lines
    .map((l) => ({
      accountCode: l.accountCode,
      debit: l.debit ?? 0n,
      credit: l.credit ?? 0n,
      description: l.description,
    }))
    .filter((l) => l.debit !== 0n || l.credit !== 0n);

  if (lines.length === 0) throw new AccountingError("لا يمكن ترحيل قيد فارغ");

  let debit = 0n;
  let credit = 0n;
  for (const line of lines) {
    if (line.debit < 0n || line.credit < 0n) {
      throw new AccountingError("لا يمكن أن تكون قيم المدين أو الدائن سالبة");
    }
    if (line.debit > 0n && line.credit > 0n) {
      throw new AccountingError("لا يمكن أن يحتوي السطر على مدين ودائن معاً");
    }
    debit += line.debit;
    credit += line.credit;
  }
  if (debit !== credit) {
    throw new AccountingError(`القيد غير متوازن: مدين ${debit} / دائن ${credit}`);
  }
  if (debit === 0n) throw new AccountingError("قيمة القيد صفر");

  const codes = [...new Set(lines.map((l) => l.accountCode))];
  const accountRows = await tx
    .select({ id: accounts.id, code: accounts.code })
    .from(accounts)
    .where(and(eq(accounts.businessId, input.businessId), inArray(accounts.code, codes)));
  const byCode = new Map(accountRows.map((a) => [a.code, a.id]));
  for (const code of codes) {
    if (!byCode.has(code)) throw new AccountingError(`الحساب ${code} غير موجود`);
  }

  const entryNo = await nextDocumentNo(tx, input.businessId, "journal");
  const entryDate = input.entryDate ?? new Date();

  const [entry] = await tx
    .insert(journalEntries)
    .values({
      businessId: input.businessId,
      entryNo,
      entryDate,
      memo: input.memo,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      createdBy: input.userId ?? null,
    })
    .returning();

  await tx.insert(journalLines).values(
    lines.map((l) => ({
      entryId: entry.id,
      accountId: byCode.get(l.accountCode)!,
      debitMinor: l.debit,
      creditMinor: l.credit,
      description: l.description ?? null,
    })),
  );

  return entry;
}

/**
 * Creates a documented reversal entry for a posted entry. The original entry is
 * never modified or deleted.
 */
export async function reverseJournal(
  tx: Tx,
  businessId: string,
  entryId: string,
  userId: string | null,
  memo?: string,
) {
  const [entry] = await tx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.id, entryId), eq(journalEntries.businessId, businessId)));
  if (!entry) throw new AccountingError("القيد غير موجود");
  if (entry.isReversal) throw new AccountingError("لا يمكن عكس قيد عكسي");

  const existing = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(eq(journalEntries.businessId, businessId), eq(journalEntries.reversalOfId, entryId)));
  if (existing.length) throw new AccountingError("تم عكس هذا القيد مسبقاً");

  const lines = await tx.select().from(journalLines).where(eq(journalLines.entryId, entryId));
  const accountsById = await tx
    .select({ id: accounts.id, code: accounts.code })
    .from(accounts)
    .where(eq(accounts.businessId, businessId));
  const codeById = new Map(accountsById.map((a) => [a.id, a.code]));

  return postJournal(tx, {
    businessId,
    memo: memo ?? `عكس القيد ${entry.entryNo}`,
    sourceType: "reversal",
    sourceId: entry.id,
    userId,
    lines: lines.map((l) => ({
      accountCode: codeById.get(l.accountId)!,
      debit: l.creditMinor,
      credit: l.debitMinor,
      description: l.description ?? undefined,
    })),
  });
}

export async function postSimpleEntry(
  tx: Tx,
  businessId: string,
  debitCode: string,
  creditCode: string,
  amount: bigint,
  memo: string,
  sourceType: string,
  sourceId: string | null,
  userId: string | null,
  entryDate?: Date,
) {
  return postJournal(tx, {
    businessId,
    memo,
    sourceType,
    sourceId,
    userId,
    entryDate,
    lines: [
      { accountCode: debitCode, debit: amount },
      { accountCode: creditCode, credit: amount },
    ],
  });
}

export { ACCOUNT_CODES };
