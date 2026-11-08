import { formatQty, fromBaseQty, parseQty, toBaseQty } from "./quantity";

/**
 * POS stock helpers. Quantities are always handled in base-unit thousandths so
 * products with different unit conversion factors can never share a limit.
 */

export type CartStockLine = {
  productId: string;
  qtyBaseMilli: bigint;
};

export type ProductStock = {
  availableBaseMilli: bigint;
  inCartBaseMilli: bigint;
  remainingBaseMilli: bigint;
};

export const POS_STOCK_MESSAGES = {
  outOfStock: "نفدت الكمية — هذا المنتج غير متوفر حالياً.",
  outOfStockShort: "نفدت الكمية",
  lowStock: "اقترب المخزون من النفاد",
  invalidQty: "كمية غير صالحة",
  fractionNotAllowed: "هذه الوحدة لا تسمح بكمية كسرية",
  stockChanged: "تغير المخزون. راجع الكميات قبل إتمام البيع.",
} as const;

export function parseQtySafe(value: string | null | undefined): bigint | null {
  try {
    const qty = parseQty(value || "0");
    return qty < 0n ? null : qty;
  } catch {
    return null;
  }
}

export function toBaseQtySafe(qtyMilli: bigint, factorMilli: bigint): bigint | null {
  try {
    return toBaseQty(qtyMilli, factorMilli);
  } catch {
    return null;
  }
}

export function sumBaseQtyByProduct(
  lines: ReadonlyArray<CartStockLine>,
): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const line of lines) {
    totals.set(line.productId, (totals.get(line.productId) ?? 0n) + line.qtyBaseMilli);
  }
  return totals;
}

export function baseQtyInCart(
  lines: ReadonlyArray<CartStockLine>,
  productId: string,
): bigint {
  let total = 0n;
  for (const line of lines) {
    if (line.productId === productId) total += line.qtyBaseMilli;
  }
  return total;
}

export function productStock(availableBaseMilli: bigint, inCartBaseMilli: bigint): ProductStock {
  const remaining = availableBaseMilli - inCartBaseMilli;
  return {
    availableBaseMilli,
    inCartBaseMilli,
    remainingBaseMilli: remaining > 0n ? remaining : 0n,
  };
}

/** One whole unit expressed in base-unit thousandths (carton factor = 24000). */
export function unitBaseQty(factorMilli: bigint): bigint {
  return factorMilli;
}

export function remainingMessage(remainingBaseMilli: bigint): string {
  const remaining = remainingBaseMilli > 0n ? remainingBaseMilli : 0n;
  return `الكمية المطلوبة أكبر من المخزون المتوفر. الكمية المتبقية: ${formatQty(remaining)}.`;
}

export function stockLabel(baseQtyMilli: bigint, baseUnitName: string): string {
  return `${formatQty(baseQtyMilli)}${baseUnitName ? ` ${baseUnitName}` : ""}`;
}

export function stockWithUnitConversion(
  baseQtyMilli: bigint,
  factorMilli: bigint,
  unitName: string,
  baseUnitName: string,
): string {
  const base = stockLabel(baseQtyMilli, baseUnitName);
  if (factorMilli > 1000n && baseQtyMilli > 0n) {
    const converted = fromBaseQty(baseQtyMilli, factorMilli);
    return `${base} (${formatQty(converted)} ${unitName})`;
  }
  return base;
}

export function isLowStock(availableBaseMilli: bigint, minStockMilli: bigint): boolean {
  return availableBaseMilli > 0n && minStockMilli > 0n && availableBaseMilli <= minStockMilli;
}
