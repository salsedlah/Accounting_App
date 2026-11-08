import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { route } from "@/server/api";
import { requireBusinessFeature, requireSession } from "@/server/auth";
import { buildDocumentPdf, type PdfType } from "@/server/pdf";

const TYPES: PdfType[] = [
  "sale",
  "purchase",
  "payment",
  "expense",
  "customer_statement",
  "supplier_statement",
];

export async function GET(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requireSession();
    const url = new URL(request.url);
    const type = url.searchParams.get("type") as PdfType | null;
    const id = url.searchParams.get("id");
    if (!type || !TYPES.includes(type) || !id) {
      return new Response(JSON.stringify({ error: "نوع المستند أو المعرّف غير صالح" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });
    }
    const feature = type === "purchase" || type === "supplier_statement" ? "purchases" : type === "expense" ? "expenses" : type === "payment" || type === "customer_statement" ? "customer_debts" : "pos";
    await requireBusinessFeature(session, feature);
    const { buffer, filename } = await transaction((tx) =>
      buildDocumentPdf(tx, session.businessId, type, id),
    );
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "cache-control": "no-store",
      },
    });
  });
}
