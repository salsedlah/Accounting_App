import { describe, expect, it } from "vitest";
import {
  formatQty,
  formatQtyBreakdown,
  fromBaseQty,
  lineAmount,
  parseQty,
  qtyToInput,
  toBaseQty,
} from "@/lib/quantity";

const CARTON_FACTOR = 24000n;
const PIECE_FACTOR = 1000n;

describe("parseQty", () => {
  it("parses quantities with three decimals", () => {
    expect(parseQty("1")).toBe(1000n);
    expect(parseQty("1.5")).toBe(1500n);
    expect(parseQty("0.125")).toBe(125n);
    expect(parseQty("١٢")).toBe(12000n);
  });

  it("rejects precision beyond three decimals", () => {
    expect(() => parseQty("1.0005")).toThrow();
    expect(parseQty("1.000")).toBe(1000n);
  });
});

describe("unit conversion", () => {
  it("converts cartons to base pieces", () => {
    expect(toBaseQty(parseQty("100"), CARTON_FACTOR)).toBe(2400000n);
    expect(toBaseQty(parseQty("3"), CARTON_FACTOR)).toBe(72000n);
    expect(fromBaseQty(72000n, CARTON_FACTOR)).toBe(3000n);
  });

  it("matches the acceptance scenario: 100 cartons, sell 3 + 12 pieces", () => {
    const opening = toBaseQty(parseQty("100"), CARTON_FACTOR);
    const sold = toBaseQty(parseQty("3"), CARTON_FACTOR) + toBaseQty(parseQty("12"), PIECE_FACTOR);
    expect(opening - sold).toBe(2316000n);
    expect(formatQty(opening - sold)).toBe("2316");
  });
});

describe("lineAmount", () => {
  it("multiplies unit price by quantity", () => {
    expect(lineAmount(parseMoneyLike("250"), parseQty("4"))).toBe(100000n);
  });

  it("handles fractional quantity", () => {
    expect(lineAmount(parseMoneyLike("10.5"), parseQty("1.5"))).toBe(1575n);
  });
});

function parseMoneyLike(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  const digits = `${whole}${fraction.padEnd(2, "0").slice(0, 2)}`;
  return BigInt(digits);
}

describe("formatQty", () => {
  it("trims trailing zeros", () => {
    expect(formatQty(1000n)).toBe("1");
    expect(formatQty(1500n)).toBe("1.5");
    expect(formatQty(1234n)).toBe("1.234");
  });

  it("creates input-safe strings", () => {
    expect(qtyToInput(1000n)).toBe("1");
    expect(qtyToInput(125n)).toBe("0.125");
  });

  it("breaks quantities into display units", () => {
    const parts = formatQtyBreakdown(
      2316000n,
      [{ name: "كرتون", factorMilli: CARTON_FACTOR }],
      "حبة",
    );
    expect(parts).toBe("96 كرتون + 12 حبة");
  });
});
