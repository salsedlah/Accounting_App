import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db/client";
import {
  customerAccounts,
  customers,
  notificationEvents,
  payments,
  sales,
  supplierAccounts,
  suppliers,
} from "@/db/schema";
import { PERMISSIONS, can } from "@/lib/constants";
import { formatMoney } from "@/lib/money";
import { parseMoney } from "@/lib/money";
import { AppError } from "@/server/api";
import type { Session } from "@/server/auth";
import { customerOutstanding, loadBusiness, memberCan, supplierOutstanding, writeAudit } from "./common";

export const partySchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().max(40).optional().nullable(),
  address: z.string().max(300).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
});

export const customerSchema = partySchema.extend({
  creditLimit: z.string().optional(),
});

export async function createCustomerDebt(tx: Tx, session: Session, raw: unknown) {
  const input = z.object({ customerId: z.string().uuid(), amount: z.string().min(1), note: z.string().max(500).optional() }).parse(raw);
  if (!(await memberCan(tx, session, PERMISSIONS.debtsManage))) throw new AppError("لا تملك صلاحية إدارة الديون", 403);
  const amount = parseMoney(input.amount);
  if (amount <= 0n) throw new AppError("المبلغ يجب أن يكون أكبر من صفر");
  const [customer] = await tx.select().from(customers).where(and(eq(customers.id, input.customerId), eq(customers.businessId, session.businessId)));
  if (!customer) throw new AppError("العميل غير موجود", 404);
  const refId = crypto.randomUUID();
  const [account] = await tx
    .insert(customerAccounts)
    .values({ businessId: session.businessId, customerId: customer.id, entryType: "debt", amountMinor: amount, referenceType: "manual_debt", referenceId: refId, note: input.note?.trim() || "دين مضاف يدوياً" })
    .returning({ id: customerAccounts.id });
  await writeAudit(tx, { businessId: session.businessId, userId: session.userId, action: "customer.debt_created", entityType: "customer", entityId: customer.id, after: { amount: amount.toString(), note: input.note } });
  return { ok: true, accountId: account.id };
}

export async function listCustomers(
  tx: Tx,
  businessId: string,
  search?: string,
) {
  const filters = [eq(customers.businessId, businessId)];
  if (search) {
    const q = `%${search}%`;
    filters.push(or(ilike(customers.name, q), ilike(customers.phone, q))!);
  }
  const rows = await tx
    .select({
      id: customers.id,
      name: customers.name,
      phone: customers.phone,
      address: customers.address,
      creditLimitMinor: customers.creditLimitMinor,
      isActive: customers.isActive,
      lastTransactionAt: customers.lastTransactionAt,
    })
    .from(customers)
    .where(and(...filters))
    .orderBy(asc(customers.name));
  const balanceRows = await tx
    .select({
      customerId: customerAccounts.customerId,
      balanceMinor: sql<string>`coalesce(sum(${customerAccounts.amountMinor}), 0)`,
    })
    .from(customerAccounts)
    .where(eq(customerAccounts.businessId, businessId))
    .groupBy(customerAccounts.customerId);
  const balances = new Map(balanceRows.map((r) => [r.customerId, BigInt(r.balanceMinor)]));
  return rows.map((r) => {
    const balance = balances.get(r.id) ?? 0n;
    return {
      ...r,
      balanceMinor: balance,
      overLimit: balance > 0n && r.creditLimitMinor > 0n && balance >= r.creditLimitMinor,
    };
  });
}

export async function createCustomer(tx: Tx, session: Session, raw: unknown) {
  const input = customerSchema.parse(raw);
  if (!(await memberCan(tx, session, PERMISSIONS.customersWrite))) {
    throw new AppError("لا تملك صلاحية إدارة العملاء", 403);
  }
  const [row] = await tx
    .insert(customers)
    .values({
      businessId: session.businessId,
      name: input.name,
      phone: input.phone || null,
      address: input.address || null,
      creditLimitMinor: input.creditLimit ? parseMoney(input.creditLimit) : 0n,
      notes: input.notes || null,
    })
    .returning();
  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "customer.create",
    entityType: "customer",
    entityId: row.id,
    after: { name: row.name, phone: row.phone },
  });
  return row;
}

export async function updateCustomer(
  tx: Tx,
  session: Session,
  customerId: string,
  raw: unknown,
) {
  const input = customerSchema.partial().parse(raw);
  if (!(await memberCan(tx, session, PERMISSIONS.customersWrite))) {
    throw new AppError("لا تملك صلاحية إدارة العملاء", 403);
  }
  const [existing] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.businessId, session.businessId)));
  if (!existing) throw new AppError("العميل غير موجود", 404);
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.phone !== undefined) patch.phone = input.phone || null;
  if (input.address !== undefined) patch.address = input.address || null;
  if (input.notes !== undefined) patch.notes = input.notes || null;
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  if (input.creditLimit !== undefined) patch.creditLimitMinor = parseMoney(input.creditLimit);
  if (Object.keys(patch).length) {
    await tx.update(customers).set(patch).where(eq(customers.id, customerId));
  }
  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "customer.update",
    entityType: "customer",
    entityId: customerId,
    before: { name: existing.name, phone: existing.phone },
    after: patch,
  });
  return { ok: true };
}

export async function getCustomerStatement(tx: Tx, businessId: string, customerId: string) {
  const [customer] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.businessId, businessId)));
  if (!customer) throw new AppError("العميل غير موجود", 404);
  const entries = await tx
    .select()
    .from(customerAccounts)
    .where(
      and(eq(customerAccounts.businessId, businessId), eq(customerAccounts.customerId, customerId)),
    )
    .orderBy(asc(customerAccounts.createdAt));
  let running = 0n;
  const statement = entries.map((e) => {
    running += e.amountMinor;
    return { ...e, runningBalanceMinor: running };
  });
  const invoices = await tx
    .select({
      id: sales.id,
      invoiceNo: sales.invoiceNo,
      kind: sales.kind,
      totalMinor: sales.totalMinor,
      paidMinor: sales.paidMinor,
      dueMinor: sales.dueMinor,
      createdAt: sales.createdAt,
    })
    .from(sales)
    .where(and(eq(sales.businessId, businessId), eq(sales.customerId, customerId)))
    .orderBy(desc(sales.createdAt))
    .limit(50);
  const paymentRows = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.businessId, businessId), eq(payments.customerId, customerId)))
    .orderBy(desc(payments.createdAt))
    .limit(50);
  return {
    customer,
    balanceMinor: running,
    entries: statement,
    invoices,
    payments: paymentRows,
  };
}

function normalizePhone(phone: string | null): string | null {
  if (!phone) return null;
  let digits = phone.replace(/[^\d]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `967${digits.slice(1)}`;
  else if (digits.length === 9 && !digits.startsWith("967")) digits = `967${digits}`;
  return digits || null;
}

export async function prepareCustomerReminder(
  tx: Tx,
  session: Session,
  customerId: string,
  channel: "whatsapp" | "in_app" = "whatsapp",
) {
  if (!(await memberCan(tx, session, PERMISSIONS.debtsManage))) {
    throw new AppError("لا تملك صلاحية إدارة الديون", 403);
  }
  const [customer] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.businessId, session.businessId)));
  if (!customer) throw new AppError("العميل غير موجود", 404);
  const balance = await customerOutstanding(tx, session.businessId, customer.id);
  const business = await loadBusiness(tx, session.businessId);
  const message =
    `مرحباً ${customer.name}،\n` +
    `نود تذكيركم بأن رصيدكم المستحق لدى ${business.name} هو ${formatMoney(balance)} ر.ي.\n` +
    (customer.creditLimitMinor > 0n
      ? `حد الائتمان المتفق عليه: ${formatMoney(customer.creditLimitMinor)} ر.ي.\n`
      : "") +
    `نشكر تعاملكم معنا.`;
  const phone = normalizePhone(customer.phone);
  const link = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}` : null;

  const [event] = await tx
    .insert(notificationEvents)
    .values({
      businessId: session.businessId,
      type: "credit_limit_reminder",
      severity: "info",
      channel,
      entityType: "customer",
      entityId: customer.id,
      titleAr: `تذكير بدين ${customer.name}`,
      bodyAr: message,
      payload: { phone, balance: balance.toString(), link },
      status: "prepared",
    })
    .returning();
  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "customer.reminder_prepared",
    entityType: "customer",
    entityId: customer.id,
    after: { balance: balance.toString(), channel },
  });
  return { message, link, phone, eventId: event.id, balanceMinor: balance };
}

export async function markReminderSent(tx: Tx, session: Session, eventId: string) {
  if (!(await memberCan(tx, session, PERMISSIONS.debtsManage))) {
    throw new AppError("لا تملك صلاحية إدارة الديون", 403);
  }
  const [event] = await tx
    .select()
    .from(notificationEvents)
    .where(
      and(
        eq(notificationEvents.id, eventId),
        eq(notificationEvents.businessId, session.businessId),
      ),
    );
  if (!event) throw new AppError("التذكير غير موجود", 404);
  await tx
    .update(notificationEvents)
    .set({ status: "sent", sentAt: new Date() })
    .where(eq(notificationEvents.id, eventId));
  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "customer.reminder_sent",
    entityType: "customer",
    entityId: event.entityId ?? undefined,
  });
  return { ok: true };
}

export async function listReminders(tx: Tx, businessId: string, limit = 50) {
  return tx
    .select()
    .from(notificationEvents)
    .where(
      and(
        eq(notificationEvents.businessId, businessId),
        eq(notificationEvents.type, "credit_limit_reminder"),
      ),
    )
    .orderBy(desc(notificationEvents.createdAt))
    .limit(limit);
}

/* --------------------------------------------------------------- suppliers */

export async function listSuppliers(tx: Tx, businessId: string, search?: string) {
  const filters = [eq(suppliers.businessId, businessId)];
  if (search) {
    const q = `%${search}%`;
    filters.push(or(ilike(suppliers.name, q), ilike(suppliers.phone, q))!);
  }
  const rows = await tx
    .select({
      id: suppliers.id,
      name: suppliers.name,
      phone: suppliers.phone,
      address: suppliers.address,
      notes: suppliers.notes,
      isActive: suppliers.isActive,
    })
    .from(suppliers)
    .where(and(...filters))
    .orderBy(asc(suppliers.name));
  const balanceRows = await tx
    .select({
      supplierId: supplierAccounts.supplierId,
      balanceMinor: sql<string>`coalesce(sum(${supplierAccounts.amountMinor}), 0)`,
    })
    .from(supplierAccounts)
    .where(eq(supplierAccounts.businessId, businessId))
    .groupBy(supplierAccounts.supplierId);
  const balances = new Map(balanceRows.map((r) => [r.supplierId, BigInt(r.balanceMinor)]));
  return rows.map((r) => ({ ...r, balanceMinor: balances.get(r.id) ?? 0n }));
}

export async function createSupplier(tx: Tx, session: Session, raw: unknown) {
  const input = partySchema.parse(raw);
  if (!(await memberCan(tx, session, PERMISSIONS.purchasesCreate))) {
    throw new AppError("لا تملك صلاحية إدارة الموردين", 403);
  }
  const [row] = await tx
    .insert(suppliers)
    .values({
      businessId: session.businessId,
      name: input.name,
      phone: input.phone || null,
      address: input.address || null,
      notes: input.notes || null,
    })
    .returning();
  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "supplier.create",
    entityType: "supplier",
    entityId: row.id,
    after: { name: row.name },
  });
  return row;
}

export async function updateSupplier(
  tx: Tx,
  session: Session,
  supplierId: string,
  raw: unknown,
) {
  const input = partySchema.partial().parse(raw);
  if (!(await memberCan(tx, session, PERMISSIONS.purchasesCreate))) {
    throw new AppError("لا تملك صلاحية إدارة الموردين", 403);
  }
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.phone !== undefined) patch.phone = input.phone || null;
  if (input.address !== undefined) patch.address = input.address || null;
  if (input.notes !== undefined) patch.notes = input.notes || null;
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  if (Object.keys(patch).length) {
    await tx
      .update(suppliers)
      .set(patch)
      .where(and(eq(suppliers.id, supplierId), eq(suppliers.businessId, session.businessId)));
  }
  await writeAudit(tx, {
    businessId: session.businessId,
    userId: session.userId,
    action: "supplier.update",
    entityType: "supplier",
    entityId: supplierId,
    after: patch,
  });
  return { ok: true };
}

export async function getSupplierStatement(tx: Tx, businessId: string, supplierId: string) {
  const [supplier] = await tx
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.businessId, businessId)));
  if (!supplier) throw new AppError("المورد غير موجود", 404);
  const entries = await tx
    .select()
    .from(supplierAccounts)
    .where(
      and(eq(supplierAccounts.businessId, businessId), eq(supplierAccounts.supplierId, supplierId)),
    )
    .orderBy(asc(supplierAccounts.createdAt));
  let running = 0n;
  const statement = entries.map((e) => {
    running += e.amountMinor;
    return { ...e, runningBalanceMinor: running };
  });
  return { supplier, balanceMinor: running, entries: statement };
}

export async function getDebtSummary(tx: Tx, businessId: string) {
  const customerRows = await listCustomers(tx, businessId);
  const supplierRows = await listSuppliers(tx, businessId);
  return {
    customers: customerRows,
    suppliers: supplierRows.filter((s) => s.balanceMinor > 0n),
    totalReceivableMinor: customerRows.reduce(
      (sum, c) => sum + (c.balanceMinor > 0n ? c.balanceMinor : 0n),
      0n,
    ),
    totalPayableMinor: supplierRows.reduce(
      (sum, s) => sum + (s.balanceMinor > 0n ? s.balanceMinor : 0n),
      0n,
    ),
  };
}
