"use client";

import { useState } from "react";
import { errorMessage, idempotencyKey, postJson } from "@/lib/client/api";
import { Alert, Button, Field, Modal } from "@/components/ui";

export function PaymentDialog({
  open,
  onClose,
  direction,
  partyId,
  partyName,
  cashboxes,
  defaultAmount,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  direction: "customer_receipt" | "supplier_payment";
  partyId: string;
  partyName: string;
  cashboxes: Array<{ id: string; name: string }>;
  defaultAmount?: string;
  onSaved?: () => void;
}) {
  const [amount, setAmount] = useState(defaultAmount ?? "");
  const [method, setMethod] = useState("cash");
  const [cashboxId, setCashboxId] = useState(cashboxes[0]?.id ?? "");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await postJson("/api/payments", {
        direction,
        customerId: direction === "customer_receipt" ? partyId : null,
        supplierId: direction === "supplier_payment" ? partyId : null,
        amount,
        method,
        cashboxId: cashboxId || null,
        reference: reference || undefined,
        notes: notes || undefined,
        occurredAt: new Date().toISOString(),
        idempotencyKey: idempotencyKey(direction === "customer_receipt" ? "rcpt" : "spay"),
      });
      setAmount("");
      setReference("");
      setNotes("");
      onSaved?.();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={direction === "customer_receipt" ? "سند قبض من عميل" : "سند صرف لمورد"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button form="payment-form" type="submit" loading={saving}>
            حفظ السند
          </Button>
        </>
      }
    >
      <form id="payment-form" onSubmit={submit} className="space-y-3">
        <p className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
          {direction === "customer_receipt" ? "العميل" : "المورد"}:{" "}
          <span className="font-medium text-ink-900">{partyName}</span>
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="المبلغ (ر.ي)">
            <input
              className="input"
              dir="ltr"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </Field>
          <Field label="طريقة الدفع">
            <select
              className="input"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              <option value="cash">نقداً</option>
              <option value="bank_transfer">حوالة بنكية</option>
              <option value="card">بطاقة</option>
              <option value="wallet">محفظة إلكترونية</option>
            </select>
          </Field>
          <Field label="الصندوق">
            <select
              className="input"
              value={cashboxId}
              onChange={(e) => setCashboxId(e.target.value)}
            >
              {cashboxes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="المرجع">
            <input
              className="input"
              dir="ltr"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
        </div>
        <Field label="ملاحظات">
          <input
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </form>
    </Modal>
  );
}
