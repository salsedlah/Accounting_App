import type { Tx } from "@/db/client";
import type { Session } from "@/server/auth";
import { formatMoney } from "@/lib/money";
import { formatQty } from "@/lib/quantity";
import {
  inventoryValuation,
  lowStock,
  pnl,
  productPerformance,
  salesByDay,
  salesTotals,
  totalCash,
  type Period,
} from "./services/reports";
import { getDebtSummary } from "./services/parties";

export type AiAnswer = {
  answer: string;
  intent: string;
  grounded: true;
  period: { from: string; to: string; label: string } | null;
  data: unknown;
  suggestions: string[];
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[؟?,.،!:؛;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export function resolvePeriod(text: string, now = new Date()): { period: Period; label: string } {
  const t = normalize(text);
  if (t.includes("امس") || t.includes("yesterday")) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return { period: { from: startOfDay(d), to: endOfDay(d) }, label: "أمس" };
  }
  if (t.includes("اليوم") || t.includes("today") || t.includes("الان")) {
    return {
      period: { from: startOfDay(now), to: endOfDay(now) },
      label: "اليوم",
    };
  }
  if (t.includes("الشهر الماضي") || t.includes("last month")) {
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const to = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { period: { from, to }, label: "الشهر الماضي" };
  }
  if (t.includes("العام") || t.includes("السنه") || t.includes("سنه") || t.includes("year")) {
    return {
      period: {
        from: new Date(now.getFullYear(), 0, 1),
        to: endOfDay(now),
      },
      label: "هذا العام",
    };
  }
  if (t.includes("الاسبوع") || t.includes("week")) {
    const from = new Date(now);
    from.setDate(from.getDate() - 6);
    return { period: { from: startOfDay(from), to: endOfDay(now) }, label: "آخر 7 أيام" };
  }
  return {
    period: { from: new Date(now.getFullYear(), now.getMonth(), 1), to: endOfDay(now) },
    label: "هذا الشهر",
  };
}

function money(minor: bigint): string {
  return `${formatMoney(minor, 2)} ريال`;
}

const SUGGESTIONS = [
  "كم مبيعات اليوم؟",
  "ما صافي ربح هذا الشهر؟",
  "ما هي المنتجات الناقصة؟",
  "من أكثر عميل مديونية؟",
  "كم قيمة المخزون الحالي؟",
  "كم النقد في الصندوق؟",
];

function simple(
  answer: string,
  intent: string,
  data: unknown,
  period: AiAnswer["period"] = null,
): AiAnswer {
  return {
    answer,
    intent,
    grounded: true,
    period,
    data,
    suggestions: SUGGESTIONS.slice(0, 3),
  };
}

export async function answerQuestion(
  tx: Tx,
  _session: Session,
  text: string,
  businessId: string,
): Promise<AiAnswer> {
  const q = normalize(text);

  if (!q || q.length < 2) {
    return simple(
      "اسألني عن المبيعات أو الأرباح أو المخزون أو الديون أو الصندوق، وسأجيب من بياناتك فقط.",
      "help",
      null,
    );
  }

  if (/(ناقص|نواقص|قارب|مخزون منخفض|اعاده الطلب|اطلب|نفد|انتهى)/.test(q)) {
    const items = await lowStock(tx, businessId);
    if (!items.length) {
      return simple("لا توجد منتجات تحت حد المخزون الأدنى حالياً.", "low_stock", items);
    }
    const lines = items
      .slice(0, 8)
      .map(
        (i) =>
          `• ${i.name} (${i.sku}): المتوفر ${formatQty(i.qtyMilli)} والحد الأدنى ${formatQty(i.minStockMilli)}`,
      );
    return simple(
      `المنتجات التي تحتاج إعادة طلب (${items.length}):\n${lines.join("\n")}`,
      "low_stock",
      items.map((i) => ({
        name: i.name,
        sku: i.sku,
        qtyMilli: i.qtyMilli.toString(),
        minStockMilli: i.minStockMilli.toString(),
      })),
    );
  }

  if (/(ربح|صافي|خساره|هامش|profit)/.test(q)) {
    const { period, label } = resolvePeriod(text);
    const result = await pnl(tx, businessId, period);
    const margin =
      result.totalRevenueMinor > 0n
        ? Number((result.netProfitMinor * 10000n) / result.totalRevenueMinor) / 100
        : 0;
    return simple(
      `صافي الربح لـ${label}: ${money(result.netProfitMinor)}.\nالإيرادات ${money(result.totalRevenueMinor)} والمصروفات ${money(result.totalExpenseMinor)} (هامش صافي ${margin}%).`,
      "profit",
      result,
      { from: period.from.toISOString(), to: period.to.toISOString(), label },
    );
  }

  if (/(مبيعات|بعت|بعنا|ايراد|sales|كم باع)/.test(q)) {
    const { period, label } = resolvePeriod(text);
    const totals = await salesTotals(tx, businessId, period);
    const byDay = await salesByDay(tx, businessId, period);
    const best = [...byDay].sort((a, b) => Number(b.salesMinor - a.salesMinor))[0];
    const bestLine = best
      ? `\nأفضل يوم: ${best.day} بمبيعات ${money(best.salesMinor)}.`
      : "";
    return simple(
      `مبيعات ${label}: ${money(totals.netSalesMinor)} صافي بعد المرتجعات (${totals.invoiceCount} فاتورة).\nالمرتجعات ${money(totals.returnsMinor)}، تكلفة البضاعة ${money(totals.cogsMinor)}، والربح الإجمالي ${money(totals.grossProfitMinor)}.${bestLine}`,
      "sales",
      { totals, byDay },
      { from: period.from.toISOString(), to: period.to.toISOString(), label },
    );
  }

  if (/(دين|ديون|مديون|مستحق|ذمم|مطلوب|debt|receivable|payable)/.test(q)) {
    const summary = await getDebtSummary(tx, businessId);
    const topCustomer = [...summary.customers].sort((a, b) =>
      a.balanceMinor > b.balanceMinor ? -1 : 1,
    )[0];
    const topSupplier = [...summary.suppliers].sort((a, b) =>
      a.balanceMinor > b.balanceMinor ? -1 : 1,
    )[0];
    const lines: string[] = [
      `إجمالي المستحق على العملاء: ${money(summary.totalReceivableMinor)} (${summary.customers.length} عميل).`,
      `إجمالي المستحق للموردين: ${money(summary.totalPayableMinor)} (${summary.suppliers.length} مورد).`,
    ];
    if (topCustomer) {
      lines.push(`أعلى مديونية: ${topCustomer.name} بمبلغ ${money(topCustomer.balanceMinor)}.`);
    }
    if (topSupplier) {
      lines.push(
        `أعلى مستحق لمورد: ${topSupplier.name} بمبلغ ${money(topSupplier.balanceMinor)}.`,
      );
    }
    return simple(
      lines.join("\n"),
      "debts",
      {
        totalReceivableMinor: summary.totalReceivableMinor.toString(),
        totalPayableMinor: summary.totalPayableMinor.toString(),
        customers: summary.customers.slice(0, 10).map((c) => ({
          name: c.name,
          balanceMinor: c.balanceMinor.toString(),
        })),
        suppliers: summary.suppliers.slice(0, 10).map((s) => ({
          name: s.name,
          balanceMinor: s.balanceMinor.toString(),
        })),
      },
    );
  }

  if (/(صندوق|نقد|كاش|cash|سيوله)/.test(q)) {
    const total = await totalCash(tx, businessId);
    return simple(
      `النقد المتوقع في الصناديق: ${money(total)}.`,
      "cash",
      { totalMinor: total.toString() },
    );
  }

  if (/(قيمه المخزون|قيمة المخزون|مخزون|inventory|بضاعه)/.test(q)) {
    const valuation = await inventoryValuation(tx, businessId);
    const top = valuation.items
      .filter((i) => i.valueMinor > 0n)
      .slice(0, 5)
      .map((i) => `• ${i.name}: ${money(i.valueMinor)}`);
    return simple(
      `قيمة المخزون الحالية: ${money(valuation.totalValueMinor)} موزعة على ${valuation.items.length} منتج.\n${top.join("\n")}`,
      "inventory_value",
      {
        totalValueMinor: valuation.totalValueMinor.toString(),
        totalQtyMilli: valuation.totalQtyMilli.toString(),
        items: valuation.items.slice(0, 10).map((i) => ({
          name: i.name,
          qtyMilli: i.qtyMilli.toString(),
          valueMinor: i.valueMinor.toString(),
        })),
      },
    );
  }

  if (/(افضل|اكثر مبيع|اعلى مبيع|best|top)/.test(q)) {
    const { period, label } = resolvePeriod(text);
    const rows = await productPerformance(tx, businessId, period);
    const top = [...rows]
      .sort((a, b) => Number(b.revenueMinor - a.revenueMinor))
      .slice(0, 5);
    const lines = top.map(
      (r, idx) =>
        `${idx + 1}. ${r.name}: ${money(r.revenueMinor)} إيراد، ${formatQty(r.qtyBaseMilli)} كمية`,
    );
    return simple(
      top.length ? `أفضل المنتجات مبيعاً لـ${label}:\n${lines.join("\n")}` : `لا توجد مبيعات لـ${label}.`,
      "top_products",
      top.map((r) => ({
        name: r.name,
        revenueMinor: r.revenueMinor.toString(),
        qtyMilli: r.qtyBaseMilli.toString(),
        profitMinor: r.profitMinor.toString(),
      })),
      { from: period.from.toISOString(), to: period.to.toISOString(), label },
    );
  }

  return simple(
    "لم أفهم السؤال. أستطيع الإجابة عن المبيعات، الأرباح، المخزون والنواقص، ديون العملاء والموردين، وحركة الصندوق. جميع الإجابات من بيانات نظامك فقط.",
    "unknown",
    null,
  );
}

