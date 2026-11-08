import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError } from "@/server/auth";
import { AccountingError } from "@/lib/accounting";
import { InventoryError } from "@/lib/inventory";
import { MoneyError } from "@/lib/money";
import { QuantityError } from "@/lib/quantity";

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(message: string, status = 400, code = "bad_request", details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function serializeBigInts(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializeBigInts);
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeBigInts(v);
    }
    return out;
  }
  return value;
}

export function ok(data: unknown, status = 200): NextResponse {
  return NextResponse.json(serializeBigInts(data), { status });
}

export function fail(message: string, status = 400, code = "error", details?: unknown) {
  return NextResponse.json(
    { error: message, code, details: serializeBigInts(details) },
    { status },
  );
}

export function route(handler: () => Promise<Response>): Promise<Response> {
  return handler().catch((error: unknown) => {
    if (error instanceof AuthError) return fail(error.message, error.status, "unauthorized");
    if (error instanceof AppError) return fail(error.message, error.status, error.code, error.details);
    if (error instanceof ZodError) {
      return fail("بيانات غير صالحة", 422, "validation_error", error.flatten());
    }
    if (error instanceof AccountingError) return fail(error.message, 409, "accounting_error");
    if (error instanceof InventoryError) return fail(error.message, 409, "inventory_error");
    if (error instanceof QuantityError) return fail(error.message, 422, "quantity_error");
    if (error instanceof MoneyError) return fail(error.message, 422, "money_error");
    console.error(error);
    const message = error instanceof Error ? error.message : "خطأ غير متوقع";
    return fail(message, 500, "internal_error");
  });
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new AppError("طلب JSON غير صالح", 400);
  }
}

export function searchParams(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

export function parseDateParam(value: string | null, fallback: Date): Date {
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}
