import { MoneyError, mulDiv, normalizeDigits } from "./money";

/**
 * Quantities are stored as integer thousandths of the base unit ("milli").
 * A quantity of 1 piece = 1000; 0.5 carton of 24 = 12000 milli base units.
 * Unit conversion factors are also thousandths: carton factor = 24000.
 */

export const QTY_SCALE = 3;
const QTY_BASE = 1000n;

export class QuantityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuantityError";
  }
}

export function parseQty(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  let s = normalizeDigits(String(value ?? "").trim());
  if (!s) throw new QuantityError("الكمية مطلوبة");
  s = s.replace(/[\s,٬]/g, "").replace("٫", ".");
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new QuantityError(`كمية غير صالحة: ${value}`);
  const negative = s.startsWith("-");
  if (negative) s = s.slice(1);
  const [whole, fraction = ""] = s.split(".");
  if (fraction.length > QTY_SCALE) {
    if (/[1-9]/.test(fraction.slice(QTY_SCALE))) {
      throw new QuantityError("الكمية تدعم 3 منازل عشرية كحد أقصى");
    }
  }
  const frac = fraction.slice(0, QTY_SCALE).padEnd(QTY_SCALE, "0");
  const result = BigInt(whole) * QTY_BASE + BigInt(frac || "0");
  return negative ? -result : result;
}

export function formatQty(qtyMilli: bigint, trim = true): string {
  const negative = qtyMilli < 0n;
  const abs = negative ? -qtyMilli : qtyMilli;
  const whole = abs / QTY_BASE;
  let fraction = (abs % QTY_BASE).toString().padStart(3, "0");
  if (trim) fraction = fraction.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? "." + fraction : ""}`;
}

export function qtyToInput(qtyMilli: bigint): string {
  return formatQty(qtyMilli, true);
}

/**
 * Convert a quantity expressed in thousandths of some unit into base-unit
 * thousandths. Rejects conversions that would lose precision.
 */
export function toBaseQty(qtyMilli: bigint, factorMilli: bigint): bigint {
  if (factorMilli <= 0n) throw new QuantityError("معامل التحويل يجب أن يكون أكبر من صفر");
  const numerator = qtyMilli * factorMilli;
  if (numerator % QTY_BASE !== 0n) {
    throw new QuantityError(
      "الكمية المطلوبة لا يمكن تحويلها بدقة إلى الوحدة الأساسية. استخدم كمية أقل دقة.",
    );
  }
  return numerator / QTY_BASE;
}

/** Convert base-unit thousandths into thousandths of another unit (rounded). */
export function fromBaseQty(baseQtyMilli: bigint, factorMilli: bigint): bigint {
  if (factorMilli <= 0n) throw new QuantityError("معامل التحويل غير صالح");
  return mulDiv(baseQtyMilli, QTY_BASE, factorMilli);
}

/** Line value = quantity (thousandths of unit) × unit price (minor) / 1000. */
export function lineAmount(unitPriceMinor: bigint, qtyMilli: bigint): bigint {
  return mulDiv(unitPriceMinor, qtyMilli, QTY_BASE);
}

/**
 * Cost of goods = balance value × quantity issued / quantity on hand, with the
 * final unit taking any rounding residual (caller caps at remaining value).
 */
export function proRataValue(totalValueMinor: bigint, qtyPart: bigint, qtyTotal: bigint): bigint {
  if (qtyTotal === 0n) return 0n;
  return mulDiv(totalValueMinor, qtyPart, qtyTotal);
}

export type DisplayUnit = {
  name: string;
  factorMilli: bigint;
  allowFraction?: boolean;
};

/**
 * Human friendly quantity breakdown, e.g. 2316 pieces -> "96 كرتون + 12 قطعة".
 * Only whole-unit conversions are used for the breakdown; the remainder is
 * shown in the base unit without losing precision.
 */
export function formatQtyBreakdown(
  baseQtyMilli: bigint,
  units: ReadonlyArray<DisplayUnit>,
  baseUnitName: string,
): string {
  if (baseQtyMilli === 0n) return `0 ${baseUnitName}`;
  const sign = baseQtyMilli < 0n ? "-" : "";
  let remaining = baseQtyMilli < 0n ? -baseQtyMilli : baseQtyMilli;
  const candidates = units
    .filter((u) => u.factorMilli > QTY_BASE && u.factorMilli % QTY_BASE === 0n)
    .slice()
    .sort((a, b) => (a.factorMilli === b.factorMilli ? 0 : a.factorMilli > b.factorMilli ? -1 : 1));
  const parts: string[] = [];
  for (const unit of candidates) {
    const whole = remaining / unit.factorMilli;
    if (whole > 0n) {
      parts.push(`${whole} ${unit.name}`);
      remaining -= whole * unit.factorMilli;
    }
  }
  if (remaining > 0n) parts.push(`${formatQty(remaining)} ${baseUnitName}`);
  return sign + (parts.length ? parts.join(" + ") : `0 ${baseUnitName}`);
}

export function assertPositiveQty(qtyMilli: bigint, label = "الكمية"): void {
  if (qtyMilli <= 0n) throw new QuantityError(`${label} يجب أن تكون أكبر من صفر`);
}

export function assertNonNegativeMoney(value: bigint, label = "المبلغ"): void {
  if (value < 0n) throw new MoneyError(`${label} لا يمكن أن يكون سالباً`);
}
