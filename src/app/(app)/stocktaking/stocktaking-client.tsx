"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardList, Plus } from "lucide-react";
import { api, errorMessage, postJson } from "@/lib/client/api";
import { formatMoney } from "@/lib/money";
import { parseQty, qtyToInput } from "@/lib/quantity";
import { Alert, Badge, Button, Field, Modal } from "@/components/ui";

type StocktakeSession = {
  id: string;
  title: string;
  status: string;
  scope: string;
  startedAt: string;
  completedAt: string | null;
  itemCount: string;
  varianceCount: string;
};

type StocktakeItem = {
  id: string;
  productId: string;
  productName: string;
  sku: string | null;
  unitName: string;
  expectedQtyMilli: string;
  countedQtyMilli: string | null;
  varianceQtyMilli: string | null;
  unitCostMinor: string;
  varianceValueMinor: string;
};

type StocktakeDetail = StocktakeSession & { items: StocktakeItem[] };

const STATUS_LABEL: Record<string, string> = {
  draft: "مسودة",
  counting: "جاري العد",
  pending_approval: "بانتظار الاعتماد",
  approved: "معتمد",
  posted: "مُرحّل",
  cancelled: "ملغي",
};

const STATUS_TONE: Record<string, "neutral" | "brand" | "warning" | "success" | "danger"> = {
  draft: "neutral",
  counting: "warning",
  pending_approval: "brand",
  approved: "brand",
  posted: "success",
  cancelled: "danger",
};

export function StocktakingClient() {
  const [sessions, setSessions] = useState<StocktakeSession[]>([]);
  const [warehouses, setWarehouses] = useState<Array<{ id: string; name: string; isDefault: boolean }>>([]);
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([]);
  const [detail, setDetail] = useState<StocktakeDetail | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: "",
    warehouseId: "",
    scope: "full",
    categoryId: "",
  });

  const load = useCallback(async () => {
    try {
      const [list, lookups] = await Promise.all([
        api<{ sessions: StocktakeSession[] }>("/api/stocktaking"),
        api<{
          warehouses: Array<{ id: string; name: string; isDefault: boolean }>;
          categories: Array<{ id: string; name: string }>;
        }>("/api/lookups"),
      ]);
      setSessions(list.sessions);
      setWarehouses(lookups.warehouses);
      setCategories(lookups.categories);
      setForm((prev) => ({
        ...prev,
        warehouseId:
          prev.warehouseId ||
          lookups.warehouses.find((w) => w.isDefault)?.id ||
          lookups.warehouses[0]?.id ||
          "",
      }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = useCallback(async (id: string) => {
    setError(null);
    try {
      const data = await api<StocktakeDetail>(`/api/stocktaking/${id}`);
      setDetail(data);
      const next: Record<string, string> = {};
      for (const item of data.items) {
        next[item.id] = qtyToInput(BigInt(item.countedQtyMilli ?? item.expectedQtyMilli));
      }
      setCounts(next);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const created = await postJson<{ id: string }>("/api/stocktaking", {
        title: form.title,
        warehouseId: form.warehouseId || null,
        scope: form.scope,
        categoryId: form.scope === "category" ? form.categoryId || null : null,
      });
      setOpen(false);
      setForm({ ...form, title: "", scope: "full", categoryId: "" });
      setMessage("تم إنشاء جرد جديد");
      await load();
      await openDetail(created.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function runAction(action: "counts" | "submit" | "approve" | "post") {
    if (!detail) return;
    setSaving(true);
    setError(null);
    try {
      const payload =
        action === "counts"
          ? {
              action,
              counts: detail.items.map((item) => ({
                itemId: item.id,
                countedQty: counts[item.id] || qtyToInput(BigInt(item.expectedQtyMilli)),
              })),
            }
          : { action };
      await postJson(`/api/stocktaking/${detail.id}`, payload);
      setMessage(
        action === "counts"
          ? "تم حفظ الكميات المعدودة"
          : action === "submit"
            ? "تم إرسال الجرد للاعتماد"
            : action === "approve"
              ? "تم اعتماد الجرد"
              : "تم ترحيل الجرد وتسوية المخزون",
      );
      await load();
      await openDetail(detail.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const varianceTotals = useMemo(() => {
    if (!detail) return { gain: 0n, loss: 0n, count: 0 };
    let gain = 0n;
    let loss = 0n;
    let count = 0;
    for (const item of detail.items) {
      const variance = parseQty(counts[item.id] || "0") - BigInt(item.expectedQtyMilli);
      if (variance === 0n) continue;
      count += 1;
      const value = (variance * BigInt(item.unitCostMinor)) / 1000n;
      if (value > 0n) gain += value;
      else loss += -value;
    }
    return { gain, loss, count };
  }, [detail, counts]);

  const readOnly = !detail || ["posted", "cancelled"].includes(detail.status);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">الجرد</h1>
          <p className="text-xs text-ink-500">جلسات جرد المخزون وتسوية الفروقات</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> جرد جديد
        </Button>
      </div>

      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>العنوان</th>
              <th>النطاق</th>
              <th>الحالة</th>
              <th>الأصناف</th>
              <th>الفروقات</th>
              <th>التاريخ</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id}>
                <td className="font-medium">{session.title}</td>
                <td className="text-xs text-ink-500">
                  {session.scope === "full" ? "كامل" : session.scope === "category" ? "تصنيف" : "أصناف"}
                </td>
                <td>
                  <Badge tone={STATUS_TONE[session.status] ?? "neutral"}>
                    {STATUS_LABEL[session.status] ?? session.status}
                  </Badge>
                </td>
                <td className="tabular-nums">{session.itemCount}</td>
                <td className="tabular-nums">{session.varianceCount}</td>
                <td className="text-[11px] text-ink-400">
                  {new Intl.DateTimeFormat("ar-YE", { dateStyle: "short" }).format(
                    new Date(session.startedAt),
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    onClick={() => openDetail(session.id)}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-brand-700 hover:bg-brand-50"
                  >
                    <ClipboardList className="h-3.5 w-3.5" /> فتح
                  </button>
                </td>
              </tr>
            ))}
            {!sessions.length ? (
              <tr>
                <td colSpan={7} className="py-10 text-center text-sm text-ink-500">
                  لا توجد جلسات جرد
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="جرد جديد"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              إلغاء
            </Button>
            <Button form="stocktake-form" type="submit" loading={saving}>
              إنشاء
            </Button>
          </>
        }
      >
        <form id="stocktake-form" onSubmit={create} className="space-y-3">
          <Field label="العنوان">
            <input
              className="input"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="جرد نهاية الشهر"
              required
            />
          </Field>
          <Field label="المخزن">
            <select
              className="input"
              value={form.warehouseId}
              onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}
            >
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="النطاق">
            <select
              className="input"
              value={form.scope}
              onChange={(e) => setForm({ ...form, scope: e.target.value })}
            >
              <option value="full">كامل المخزون</option>
              <option value="category">تصنيف محدد</option>
            </select>
          </Field>
          {form.scope === "category" ? (
            <Field label="التصنيف">
              <select
                className="input"
                value={form.categoryId}
                onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                required
              >
                <option value="">اختر تصنيفاً</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </form>
      </Modal>

      <Modal
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail ? `${detail.title} · ${STATUS_LABEL[detail.status] ?? detail.status}` : ""}
        wide
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-ink-500">
              فارق إيجابي <span dir="ltr" className="text-ok">{formatMoney(varianceTotals.gain)}</span> ·
              سلبي <span dir="ltr" className="text-danger">{formatMoney(varianceTotals.loss)}</span>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setDetail(null)}>
                إغلاق
              </Button>
              {detail && !readOnly ? (
                <Button variant="secondary" loading={saving} onClick={() => runAction("counts")}>
                  حفظ العد
                </Button>
              ) : null}
              {detail && ["draft", "counting"].includes(detail.status) ? (
                <Button loading={saving} onClick={() => runAction("submit")}>
                  إرسال للاعتماد
                </Button>
              ) : null}
              {detail?.status === "pending_approval" ? (
                <Button loading={saving} onClick={() => runAction("approve")}>
                  اعتماد
                </Button>
              ) : null}
              {detail?.status === "approved" ? (
                <Button loading={saving} onClick={() => runAction("post")}>
                  ترحيل وتسوية
                </Button>
              ) : null}
            </div>
          </div>
        }
      >
        {detail ? (
          <div className="max-h-[60vh] overflow-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>الصنف</th>
                  <th>الوحدة</th>
                  <th>المتوقع</th>
                  <th>المعدود</th>
                  <th>الفرق</th>
                  <th>قيمة الفرق</th>
                </tr>
              </thead>
              <tbody>
                {detail.items.map((item) => {
                  const counted = parseQty(counts[item.id] || "0");
                  const variance = counted - BigInt(item.expectedQtyMilli);
                  return (
                    <tr key={item.id}>
                      <td>
                        <p className="text-xs font-medium">{item.productName}</p>
                        <p className="text-[10px] text-ink-400" dir="ltr">{item.sku ?? "-"}</p>
                      </td>
                      <td className="text-xs">{item.unitName}</td>
                      <td dir="ltr" className="tabular-nums text-xs">
                        {qtyToInput(BigInt(item.expectedQtyMilli))}
                      </td>
                      <td>
                        <input
                          className="input h-8 w-24 text-center text-xs"
                          dir="ltr"
                          inputMode="decimal"
                          disabled={readOnly}
                          value={counts[item.id] ?? ""}
                          onChange={(e) =>
                            setCounts((prev) => ({ ...prev, [item.id]: e.target.value }))
                          }
                        />
                      </td>
                      <td
                        dir="ltr"
                        className={`tabular-nums text-xs ${
                          variance > 0n ? "text-ok" : variance < 0n ? "text-danger" : "text-ink-400"
                        }`}
                      >
                        {qtyToInput(variance)}
                      </td>
                      <td dir="ltr" className="tabular-nums text-xs">
                        {formatMoney((variance * BigInt(item.unitCostMinor)) / 1000n)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
