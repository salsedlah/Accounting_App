import path from "node:path";
import PDFDocument from "pdfkit";
import bidiFactory from "bidi-js";
import ArabicReshaper from "arabic-reshaper";
import { and, eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { expenses } from "@/db/schema";
import { formatMoney } from "@/lib/money";
import { formatQty } from "@/lib/quantity";
import { AppError } from "@/server/api";
import { getSettings } from "@/server/services/admin";
import { getPaymentDetail } from "@/server/services/payments";
import { getPurchaseDetail } from "@/server/services/purchases";
import { getSaleDetail } from "@/server/services/sales";
import { getCustomerStatement, getSupplierStatement } from "@/server/services/parties";

const bidi = bidiFactory();
const FONT = path.join(process.cwd(), "public", "fonts", "Amiri-Regular.ttf");

export type PdfType =
  | "sale"
  | "purchase"
  | "payment"
  | "expense"
  | "customer_statement"
  | "supplier_statement";

function rtl(text: string): string {
  if (!text) return "";
  return text
    .split("\n")
    .map((line) => {
      const shaped = ArabicReshaper.convertArabic(line);
      const levels = bidi.getEmbeddingLevels(shaped, "rtl");
      return bidi.getReorderedString(shaped, levels);
    })
    .join("\n");
}

function money(minor: bigint): string {
  return formatMoney(minor, 2);
}

function dateTime(value: Date): string {
  return new Intl.DateTimeFormat("ar-YE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function dateOnly(value: Date): string {
  return new Intl.DateTimeFormat("ar-YE", { dateStyle: "medium" }).format(value);
}

type Column = {
  label: string;
  width: number;
  align?: "right" | "left" | "center";
};

type Row = string[];

type TableSpec = {
  columns: Column[];
  rows: Row[];
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;

class Layout {
  doc: PDFKit.PDFDocument;
  y: number;

  constructor() {
    this.doc = new PDFDocument({ size: "A4", margin: MARGIN, bufferPages: true });
    this.doc.registerFont("amiri", FONT);
    this.doc.font("amiri");
    this.y = MARGIN;
  }

  text(
    text: string,
    x: number,
    y: number,
    options: PDFKit.Mixins.TextOptions & { fontSize?: number; fillColor?: string } = {},
  ): void {
    const { fontSize, fillColor, ...rest } = options;
    this.doc.font("amiri");
    this.doc.fontSize(fontSize ?? 10);
    this.doc.fillColor(fillColor ?? "#111111");
    this.doc.text(rtl(text), x, y, rest);
  }

  header(business: {
    name: string;
    legalName: string | null;
    phone: string | null;
    address: string | null;
  }, title: string, meta: Array<[string, string]>): void {
    const doc = this.doc;
    this.text(title, MARGIN, 34, {
      width: PAGE_WIDTH - MARGIN * 2,
      align: "center",
      fontSize: 20,
    });
    doc
      .moveTo(MARGIN, 64)
      .lineTo(PAGE_WIDTH - MARGIN, 64)
      .lineWidth(1)
      .strokeColor("#1f6f54")
      .stroke();

    let y = 76;
    this.text(business.name, PAGE_WIDTH / 2, y, {
      width: PAGE_WIDTH / 2 - MARGIN,
      align: "right",
      fontSize: 14,
    });
    y += 20;
    const lines = [
      business.legalName,
      business.phone ? `هاتف: ${business.phone}` : null,
      business.address,
    ].filter(Boolean) as string[];
    for (const line of lines) {
      this.text(line, PAGE_WIDTH / 2, y, {
        width: PAGE_WIDTH / 2 - MARGIN,
        align: "right",
        fontSize: 9,
      });
      y += 14;
    }

    let ly = 76;
    for (const [label, value] of meta) {
      this.text(`${label}: ${value}`, MARGIN, ly, {
        width: PAGE_WIDTH / 2 - MARGIN,
        align: "left",
        fontSize: 9,
      });
      ly += 14;
    }

    this.y = Math.max(y, ly) + 8;
    doc
      .moveTo(MARGIN, this.y)
      .lineTo(PAGE_WIDTH - MARGIN, this.y)
      .lineWidth(0.5)
      .strokeColor("#cbd5d1")
      .stroke();
    this.y += 10;
  }

  table(spec: TableSpec): void {
    const doc = this.doc;
    const totalWidth = spec.columns.reduce((s, c) => s + c.width, 0);
    const startX = PAGE_WIDTH - MARGIN - totalWidth;
    const drawHead = (y: number) => {
      doc.rect(startX, y, totalWidth, 22).fill("#1f6f54");
      let right = PAGE_WIDTH - MARGIN;
      for (const col of spec.columns) {
        const x = right - col.width;
        this.text(col.label, x + 4, y + 6, {
          width: col.width - 8,
          align: col.align ?? "right",
          fontSize: 8.5,
          fillColor: "#ffffff",
          lineBreak: false,
        });
        right -= col.width;
      }
      doc.fillColor("#111111");
      return y + 22;
    };

    let y = drawHead(this.y);
    let stripe = false;
    for (const row of spec.rows) {
      if (y + 20 > PAGE_HEIGHT - 70) {
        doc.addPage();
        this.y = MARGIN;
        y = drawHead(this.y);
      }
      if (stripe) doc.rect(startX, y, totalWidth, 20).fill("#f2f7f5");
      doc.fillColor("#111111");
      let right = PAGE_WIDTH - MARGIN;
      spec.columns.forEach((col, index) => {
        const x = right - col.width;
        this.text(row[index] ?? "", x + 4, y + 6, {
          width: col.width - 8,
          align: col.align ?? "right",
          fontSize: 8,
          lineBreak: false,
          ellipsis: true,
        });
        right -= col.width;
      });
      doc
        .moveTo(startX, y + 20)
        .lineTo(PAGE_WIDTH - MARGIN, y + 20)
        .lineWidth(0.2)
        .strokeColor("#dbe4e0")
        .stroke();
      y += 20;
      stripe = !stripe;
    }
    this.y = y + 12;
  }

  totals(rows: Array<[string, string]>, emphasisIndex?: number): void {
    const labelWidth = 150;
    const valueWidth = 110;
    const xValue = PAGE_WIDTH - MARGIN - valueWidth;
    const xLabel = xValue - labelWidth;
    let y = this.y;
    rows.forEach(([label, value], index) => {
      const emphasized = emphasisIndex === index;
      if (emphasized) {
        this.doc.rect(xLabel - 8, y - 3, labelWidth + valueWidth + 8, 22).fill("#e8f2ee");
        this.doc.fillColor("#111111");
      }
      this.text(label, xLabel, y, {
        width: labelWidth,
        align: "right",
        fontSize: emphasized ? 11 : 9,
      });
      this.text(value, xValue, y, {
        width: valueWidth,
        align: "left",
        fontSize: emphasized ? 11 : 9,
      });
      y += emphasized ? 24 : 17;
    });
    this.y = y + 8;
  }

  notes(text: string | null): void {
    if (!text) return;
    this.text("ملاحظات:", MARGIN, this.y, {
      width: PAGE_WIDTH - MARGIN * 2,
      align: "right",
      fontSize: 9,
    });
    this.y += 14;
    this.text(text, MARGIN, this.y, {
      width: PAGE_WIDTH - MARGIN * 2,
      align: "right",
      fontSize: 9,
    });
    this.y += 30;
  }

  finish(footer: string): Promise<Buffer> {
    const doc = this.doc;
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      this.text(footer, MARGIN, PAGE_HEIGHT - 38, {
        width: PAGE_WIDTH - MARGIN * 2,
        align: "center",
        fontSize: 7.5,
        fillColor: "#6b7d76",
      });
      this.text(
        `صفحة ${i + 1} من ${range.count}`,
        MARGIN,
        PAGE_HEIGHT - 26,
        {
          width: PAGE_WIDTH - MARGIN * 2,
          align: "center",
          fontSize: 7.5,
          fillColor: "#6b7d76",
        },
      );
    }
    doc.end();
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });
  }
}

function paymentMethodLabel(method: string): string {
  const map: Record<string, string> = {
    cash: "نقداً",
    bank_transfer: "حوالة بنكية",
    card: "بطاقة",
    wallet: "محفظة إلكترونية",
  };
  return map[method] ?? method;
}

function paymentTypeLabel(type: string): string {
  const map: Record<string, string> = {
    cash: "نقدي",
    credit: "آجل",
    mixed: "مختلط",
  };
  return map[type] ?? type;
}

export async function buildDocumentPdf(
  tx: Tx,
  businessId: string,
  type: PdfType,
  id: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const { business } = await getSettings(tx, businessId);

  if (type === "sale") {
    const sale = await getSaleDetail(tx, businessId, id);
    const layout = new Layout();
    layout.header(
      business,
      sale.kind === "return" ? "سند مرتجع مبيعات" : "فاتورة مبيعات",
      [
        ["رقم الفاتورة", sale.invoiceNo],
        ["التاريخ", dateTime(sale.occurredAt)],
        ["العميل", sale.customer?.name ?? "عميل نقدي"],
        ["نوع الدفع", paymentTypeLabel(sale.paymentType)],
      ],
    );
    if (sale.customer?.phone) {
      layout.text(`هاتف: ${sale.customer.phone}`, MARGIN, 76, {
        width: PAGE_WIDTH / 2 - MARGIN,
        align: "left",
        fontSize: 9,
      });
    }
    layout.table({
      columns: [
        { label: "الإجمالي", width: 90 },
        { label: "الخصم", width: 70 },
        { label: "سعر الوحدة", width: 90 },
        { label: "الكمية", width: 70 },
        { label: "الوحدة", width: 60 },
        { label: "المنتج", width: 135 },
      ],
      rows: sale.items.map((item) => [
        money(item.lineTotalMinor),
        money(item.discountMinor),
        money(item.unitPriceMinor),
        formatQty(item.qtyMilli),
        item.unitName,
        item.productName,
      ]),
    });
    layout.totals(
      [
        ["المجموع الفرعي", money(sale.subtotalMinor)],
        ["الخصم", money(sale.discountMinor)],
        ["الضريبة", money(sale.taxMinor)],
        ["الإجمالي", money(sale.totalMinor)],
        ["المدفوع", money(sale.paidMinor)],
        ["المتبقي", money(sale.dueMinor)],
      ],
      3,
    );
    layout.notes(sale.notes);
    const buffer = await layout.finish("هذه الفاتورة صادرة إلكترونياً من نظام حساب");
    return { buffer, filename: `${sale.invoiceNo}.pdf` };
  }

  if (type === "purchase") {
    const purchase = await getPurchaseDetail(tx, businessId, id);
    const layout = new Layout();
    layout.header(
      business,
      purchase.kind === "return" ? "سند مرتجع مشتريات" : "فاتورة مشتريات",
      [
        ["رقم الفاتورة", purchase.invoiceNo],
        ["التاريخ", dateTime(purchase.occurredAt)],
        ["المورد", purchase.supplier?.name ?? ""],
      ],
    );
    layout.table({
      columns: [
        { label: "الإجمالي", width: 90 },
        { label: "الخصم", width: 70 },
        { label: "سعر الوحدة", width: 90 },
        { label: "الكمية", width: 70 },
        { label: "الوحدة", width: 60 },
        { label: "المنتج", width: 135 },
      ],
      rows: purchase.items.map((item) => [
        money(item.lineTotalMinor),
        money(item.discountMinor),
        money(item.unitCostMinor),
        formatQty(item.qtyMilli),
        item.unitName,
        item.productName,
      ]),
    });
    layout.totals(
      [
        ["المجموع الفرعي", money(purchase.subtotalMinor)],
        ["الخصم", money(purchase.discountMinor)],
        ["تكاليف إضافية", money(purchase.extraCostMinor)],
        ["الإجمالي", money(purchase.totalMinor)],
        ["المدفوع", money(purchase.paidMinor)],
        ["المتبقي", money(purchase.dueMinor)],
      ],
      3,
    );
    layout.notes(purchase.notes);
    const buffer = await layout.finish("تم إنشاء هذا المستند إلكترونياً من نظام حساب");
    return { buffer, filename: `${purchase.invoiceNo}.pdf` };
  }

  if (type === "payment") {
    const payment = await getPaymentDetail(tx, businessId, id);
    const isReceipt = payment.direction === "customer_receipt";
    const layout = new Layout();
    layout.header(business, isReceipt ? "سند قبض" : "سند صرف", [
      ["رقم السند", payment.paymentNo],
      ["التاريخ", dateTime(payment.occurredAt)],
      [isReceipt ? "العميل" : "المورد", payment.customer?.name ?? payment.supplier?.name ?? ""],
      ["طريقة الدفع", paymentMethodLabel(payment.method)],
    ]);
    layout.y += 10;
    layout.totals([
      ["المبلغ", `${money(payment.amountMinor)} ريال`],
      ["طريقة الدفع", paymentMethodLabel(payment.method)],
      ["المرجع", payment.reference ?? "-"],
    ], 0);
    layout.notes(payment.notes);
    const buffer = await layout.finish("تم إنشاء هذا السند إلكترونياً من نظام حساب");
    return { buffer, filename: `${payment.paymentNo}.pdf` };
  }

  if (type === "expense") {
    const [expense] = await tx
      .select()
      .from(expenses)
      .where(and(eq(expenses.businessId, businessId), eq(expenses.id, id)));
    if (!expense) throw new AppError("سند المصروف غير موجود", 404);
    const layout = new Layout();
    layout.header(business, "سند مصروف", [
      ["رقم السند", expense.expenseNo],
      ["التاريخ", dateTime(expense.paidAt)],
      ["التصنيف", expense.category],
    ]);
    layout.y += 10;
    layout.totals([
      ["المبلغ", `${money(expense.amountMinor)} ريال`],
      ["الوصف", expense.description],
      ["المرجع", expense.reference ?? "-"],
    ], 0);
    const buffer = await layout.finish("تم إنشاء هذا السند إلكترونياً من نظام حساب");
    return { buffer, filename: `${expense.expenseNo}.pdf` };
  }

  if (type === "customer_statement") {
    const statement = await getCustomerStatement(tx, businessId, id);
    const layout = new Layout();
    layout.header(business, "كشف حساب عميل", [
      ["العميل", statement.customer.name],
      ["الهاتف", statement.customer.phone ?? "-"],
      ["تاريخ الكشف", dateOnly(new Date())],
      ["الرصيد الحالي", `${money(statement.balanceMinor)} ريال`],
    ]);
    layout.table({
      columns: [
        { label: "الرصيد", width: 100 },
        { label: "دائن", width: 85 },
        { label: "مدين", width: 85 },
        { label: "البيان", width: 160 },
        { label: "التاريخ", width: 85 },
      ],
      rows: statement.entries.map((entry) => [
        money(entry.runningBalanceMinor),
        entry.amountMinor < 0n ? money(-entry.amountMinor) : "-",
        entry.amountMinor > 0n ? money(entry.amountMinor) : "-",
        entry.note ?? entry.entryType,
        dateOnly(entry.createdAt),
      ]),
    });
    layout.totals([["إجمالي المستحق", `${money(statement.balanceMinor)} ريال`]], 0);
    const buffer = await layout.finish("كشف حساب صادر إلكترونياً من نظام حساب");
    return { buffer, filename: `statement-${statement.customer.name}.pdf` };
  }

  const statement = await getSupplierStatement(tx, businessId, id);
  const layout = new Layout();
  layout.header(business, "كشف حساب مورد", [
    ["المورد", statement.supplier.name],
    ["الهاتف", statement.supplier.phone ?? "-"],
    ["تاريخ الكشف", dateOnly(new Date())],
    ["الرصيد الحالي", `${money(statement.balanceMinor)} ريال`],
  ]);
  layout.table({
    columns: [
      { label: "الرصيد", width: 100 },
      { label: "دائن", width: 85 },
      { label: "مدين", width: 85 },
      { label: "البيان", width: 160 },
      { label: "التاريخ", width: 85 },
    ],
    rows: statement.entries.map((entry) => [
      money(entry.runningBalanceMinor),
      entry.amountMinor < 0n ? money(-entry.amountMinor) : "-",
      entry.amountMinor > 0n ? money(entry.amountMinor) : "-",
      entry.note ?? entry.entryType,
      dateOnly(entry.createdAt),
    ]),
  });
  layout.totals([["إجمالي المستحق", `${money(statement.balanceMinor)} ريال`]], 0);
  const buffer = await layout.finish("كشف حساب صادر إلكترونياً من نظام حساب");
  return { buffer, filename: `supplier-statement-${statement.supplier.name}.pdf` };
}
