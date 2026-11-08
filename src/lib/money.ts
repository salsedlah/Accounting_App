/**
 * Exact money arithmetic. All amounts are integer minor units (bigint).
 * JavaScript floating point is never used for financial values.
 */

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

export function normalizeDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const a = ARABIC_DIGITS.indexOf(ch);
    if (a >= 0) {
      out += String(a);
      continue;
    }
    const p = PERSIAN_DIGITS.indexOf(ch);
    out += p >= 0 ? String(p) : ch;
  }
  return out;
}

function pow10(scale: number): bigint {
  return 10n ** BigInt(scale);
}

/** Parse user input into integer minor units. Throws on invalid precision. */
export function parseMoney(value: string | number | bigint, scale = 2): bigint {
  if (typeof value === "bigint") return value;
  let s = normalizeDigits(String(value ?? "").trim());
  if (!s) throw new MoneyError("المبلغ مطلوب");
  s = s.replace(/[\s,٬]/g, "").replace("٫", ".");
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new MoneyError(`مبلغ غير صالح: ${value}`);
  const negative = s.startsWith("-");
  if (negative) s = s.slice(1);
  const [whole, fraction = ""] = s.split(".");
  if (fraction.length > scale) {
    if (/[1-9]/.test(fraction.slice(scale))) {
      throw new MoneyError(`عدد المنازل العشرية أكبر من المسموح (${scale})`);
    }
  }
  const frac = fraction.slice(0, scale).padEnd(scale, "0");
  const result = BigInt(whole) * pow10(scale) + BigInt(frac || "0");
  return negative ? -result : result;
}

export function formatMoney(
  minor: bigint,
  scale = 2,
  options: { trim?: boolean; grouping?: boolean } = {},
): string {
  const { trim = true, grouping = true } = options;
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const base = pow10(scale);
  const whole = abs / base;
  let fraction = (abs % base).toString().padStart(scale, "0");
  if (trim && /^0+$/.test(fraction)) fraction = "";
  else if (trim) fraction = fraction.replace(/0+$/, "");
  let wholeText = whole.toString();
  if (grouping) wholeText = wholeText.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${wholeText}${fraction ? "." + fraction : ""}`;
}

export function formatMoneyWithCurrency(minor: bigint, scale = 2): string {
  return `${formatMoney(minor, scale)} ر.ي`;
}

/** Plain input string (no grouping, no currency). */
export function moneyToInput(minor: bigint, scale = 2): string {
  return formatMoney(minor, scale, { trim: true, grouping: false });
}

/**
 * Exact (a * b) / d with deterministic rounding. d must be non-zero.
 * Default rounding is half away from zero.
 */
export function mulDiv(
  a: bigint,
  b: bigint,
  d: bigint,
  mode: "half-up" | "floor" | "ceil" | "trunc" = "half-up",
): bigint {
  if (d === 0n) throw new MoneyError("القسمة على صفر");
  const product = a * b;
  const negative = product < 0n !== d < 0n;
  const absP = product < 0n ? -product : product;
  const absD = d < 0n ? -d : d;
  let q = absP / absD;
  const r = absP % absD;
  if (mode === "half-up") {
    if (r * 2n >= absD) q += 1n;
  } else if (mode === "ceil" && r > 0n) {
    q += 1n;
  } else if (mode === "floor" && negative && r > 0n) {
    q += 1n;
  }
  return negative ? -q : q;
}

export function addMoney(...values: bigint[]): bigint {
  return values.reduce((sum, v) => sum + v, 0n);
}

export function sumMoney(values: ReadonlyArray<bigint>): bigint {
  return values.reduce((sum, v) => sum + v, 0n);
}

export function percentBp(amount: bigint, basisPoints: number): bigint {
  return mulDiv(amount, BigInt(Math.trunc(basisPoints)), 10000n);
}

export function clampNonNegative(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

export function absMoney(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** Allocate `total` across integer weights using the largest-remainder method. */
export function allocateProportionally(total: bigint, weights: ReadonlyArray<bigint>): bigint[] {
  if (total === 0n || weights.length === 0) return weights.map(() => 0n);
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n) {
    const base = total / BigInt(weights.length);
    const result = weights.map(() => base);
    let rest = total - base * BigInt(weights.length);
    for (let i = 0; rest > 0n; i = (i + 1) % result.length) {
      result[i] += 1n;
      rest -= 1n;
    }
    return result;
  }
  const floors = weights.map((w) => (total * w) / sum);
  const remainder = total - floors.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((w, i) => ({ i, rem: (total * w) % sum }))
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (let k = 0; k < Number(remainder); k++) {
    floors[order[k % order.length].i] += 1n;
  }
  return floors;
}
