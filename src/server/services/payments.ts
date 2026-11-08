import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db/client";
import {
  cashTransactions,
  customerAccounts,
  customers,
  payments,
  supplierAccounts,
  suppliers,
} from "@/db/schema";
import { ACCOUNT_CODES, PERMISSIONS, can } from "@/lib/constants";
import { postJournal } from "@/lib/accounting";
import { nextDocumentNo } from "@/lib/invoice-number";
import { parseMoney } from "@/lib/money";
import { AppError } from "@/server/api";
import type { Session } from "@/server/auth";
import {
  customerOutstanding,
  defaultCashbox,
  loadCustomer,
  memberCan,
  supplierOutstanding,
  touchCustomer,
  writeAudit,
} from "./common";

export const paymentSchema = z.object({
  direction: z.enum(["customer_receipt", "supplier_payment"]),
  customerId: z.string().uuid().nullish(),
  supplierId: z.string().uuid().nullish(),
  amount: z.string().min(1),
  method: z.enum(["cash", "bank_transfer", "card", "wallet"]).default("cash"),
  cashboxId: z.string().uuid().nullish(),
  reference: z.string().max(200).optional(),
  notes: z.string().max(500).optional(),
  occurredAt: z.string().datetime().optional(),
  idempotencyKey: z.string().min(8).max(200),
});

export async function createPayment(tx: Tx, session: Session, raw: unknown) {
  const input = paymentSchema.parse(raw);
  if (!(await memberCan(tx, session, PERMISSIONS.paymentsCreate))) {
    throw new AppError("لا تملك صلاحية تسجيل الدفعات", 403);
  }

  const [existing] = await tx
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.businessId, session.businessId),
        eq(payments.idempotencyKey, input.idempotencyKey),
      ),
    );
  if (existing) return { payment: await getPaymentDetail(tx, session.businessId, existing.id), duplicate: true };

  const amount = parseMoney(input.amount);
  if (amount <= 0n) throw new AppError("المبلغ يجب أن يكون أكبر من صفر");

  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  const cashbox = await defaultCashbox(tx, session.businessId, input.cashboxId);
  const paymentId = crypto.randomUUID();

  if (input.direction === "customer_receipt") {
    if (!input.customerId) throw new AppError("اختر العميل");
    const customer = await loadCustomer(tx, session.businessId, input.customerId);
    const outstanding = await customerOutstanding(tx, session.businessId, customer.id);
    if (amount > outstanding) {
      throw new AppError(`المبلغ أكبر من رصيد الدين المستحق (${outstanding} هللة)`);
    }
    const paymentNo = await nextDocumentNo(tx, session.businessId, "receipt");
    await tx.insert(payments).values({
      id: paymentId,
      businessId: session.businessId,
      paymentNo,
      direction: input.direction,
      customerId: customer.id,
      amountMinor: amount,
      method: input.method,
      cashboxId: cashbox.id,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      userId: session.userId,
      idempotencyKey: input.idempotencyKey,
      occurredAt,
    });

    const entry = await postJournal(tx, {
      businessId: session.businessId,
      memo: `سند قبض ${paymentNo} - ${customer.name}`,
      sourceType: "payment",
      sourceId: paymentId,
      userId: session.userId,
      entryDate: occurredAt,
      lines: [
        { accountCode: ACCOUNT_CODES.cash, debit: amount },
        { accountCode: ACCOUNT_CODES.receivable, credit: amount },
      ],
    });

    await tx
      .update(payments)
      .set({ journalEntryId: entry.id })
      .where(eq(payments.id, paymentId));

    await tx.insert(customerAccounts).values({
      businessId: session.businessId,
      customerId: customer.id,
      entryType: "payment",
      amountMinor: -amount,
      referenceType: "payment",
      referenceId: paymentId,
      journalEntryId: entry.id,
      note: paymentNo,
      createdAt: occurredAt,
    });

    await tx.insert(cashTransactions).values({
      businessId: session.businessId,
      cashboxId: cashbox.id,
      direction: "inflow",
      amountMinor: amount,
      sourceType: "payment",
      sourceId: paymentId,
      description: `تحصيل من العميل ${customer.name} - ${paymentNo}`,
      journalEntryId: entry.id,
      userId: session.userId,
      createdAt: occurredAt,
    });

    await touchCustomer(tx, customer.id, occurredAt);
    await writeAudit(tx, {
      businessId: session.businessId,
      userId: session.userId,
      action: "payment.customer_receipt",
      entityType: "payment",
      entityId: paymentId,
      after: { paymentNo, amount: amount.toString(), customerId: customer.id },
    });
  } else {
    if (!input.supplierId) throw new AppError("اختر المورد");
    const [supplier] = await tx
      .select()
      .from(suppliers)
      .where(
        and(eq(suppliers.id, input.supplierId), eq(suppliers.businessId, session.businessId)),
      );
    if (!supplier) throw new AppError("المورد غير موجود", 404);
    const outstanding = await supplierOutstanding(tx, session.businessId, supplier.id);
    if (amount > outstanding) {
      throw new AppError(`المبلغ أكبر من رصيد المستحق للمورد (${outstanding} هللة)`);
    }
    const paymentNo = await nextDocumentNo(tx, session.businessId, "supplier_payment");
    await tx.insert(payments).values({
      id: paymentId,
      businessId: session.businessId,
      paymentNo,
      direction: input.direction,
      supplierId: supplier.id,
      amountMinor: amount,
      method: input.method,
      cashboxId: cashbox.id,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      userId: session.userId,
      idempotencyKey: input.idempotencyKey,
      occurredAt,
    });

    const entry = await postJournal(tx, {
      businessId: session.businessId,
      memo: `سند صرف ${paymentNo} - ${supplier.name}`,
      sourceType: "payment",
      sourceId: paymentId,
      userId: session.userId,
      entryDate: occurredAt,
      lines: [
        { accountCode: ACCOUNT_CODES.payable, debit: amount },
        { accountCode: ACCOUNT_CODES.cash, credit: amount },
      ],
    });

    await tx
      .update(payments)
      .set({ journalEntryId: entry.id })
      .where(eq(payments.id, paymentId));

    await tx.insert(supplierAccounts).values({
      businessId: session.businessId,
      supplierId: supplier.id,
      entryType: "payment",
      amountMinor: -amount,
      referenceType: "payment",
      referenceId: paymentId,
      journalEntryId: entry.id,
      note: paymentNo,
      createdAt: occurredAt,
    });

    await tx.insert(cashTransactions).values({
      businessId: session.businessId,
      cashboxId: cashbox.id,
      direction: "outflow",
      amountMinor: amount,
      sourceType: "payment",
      sourceId: paymentId,
      description: `دفعة للمورد ${supplier.name} - ${paymentNo}`,
      journalEntryId: entry.id,
      userId: session.userId,
      createdAt: occurredAt,
    });

    await writeAudit(tx, {
      businessId: session.businessId,
      userId: session.userId,
      action: "payment.supplier_payment",
      entityType: "payment",
      entityId: paymentId,
      after: { paymentNo, amount: amount.toString(), supplierId: supplier.id },
    });
  }

  return { payment: await getPaymentDetail(tx, session.businessId, paymentId), duplicate: false };
}

export async function getPaymentDetail(tx: Tx, businessId: string, paymentId: string) {
  const [payment] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.businessId, businessId), eq(payments.id, paymentId)));
  if (!payment) throw new AppError("السند غير موجود", 404);
  const [customer] = payment.customerId
    ? await tx.select().from(customers).where(eq(customers.id, payment.customerId))
    : [];
  const [supplier] = payment.supplierId
    ? await tx.select().from(suppliers).where(eq(suppliers.id, payment.supplierId))
    : [];
  return { ...payment, customer: customer ?? null, supplier: supplier ?? null };
}

export async function listPayments(tx: Tx, businessId: string, limit = 100) {
  return tx
    .select({
      id: payments.id,
      paymentNo: payments.paymentNo,
      direction: payments.direction,
      amountMinor: payments.amountMinor,
      method: payments.method,
      reference: payments.reference,
      createdAt: payments.createdAt,
      customerName: customers.name,
      supplierName: suppliers.name,
    })
    .from(payments)
    .leftJoin(customers, eq(customers.id, payments.customerId))
    .leftJoin(suppliers, eq(suppliers.id, payments.supplierId))
    .where(eq(payments.businessId, businessId))
    .orderBy(desc(payments.createdAt))
    .limit(limit);
}
