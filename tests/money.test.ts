import { describe, expect, it } from "vitest";
import {
  allocateProportionally,
  formatMoney,
  moneyToInput,
  mulDiv,
  parseMoney,
  percentBp,
} from "@/lib/money";

describe("parseMoney", () => {
  it("parses plain decimal amounts into minor units", () => {
    expect(parseMoney("1234.56")).toBe(123456n);
    expect(parseMoney("0.05")).toBe(5n);
    expect(parseMoney("7")).toBe(700n);
  });

  it("normalizes Arabic-Indic and Persian digits", () => {
    expect(parseMoney("١٢٣٤.٥٦")).toBe(123456n);
    expect(parseMoney("۱۲۳")).toBe(12300n);
  });

  it("supports thousands separators", () => {
    expect(parseMoney("1,234.50")).toBe(123450n);
  });

  it("throws when more precision than the money scale is supplied", () => {
    expect(() => parseMoney("1.005")).toThrow();
    expect(() => parseMoney("1.004")).toThrow();
  });

  it("rejects invalid input", () => {
    expect(() => parseMoney("")).toThrow();
    expect(() => parseMoney("abc")).toThrow();
    expect(() => parseMoney("1,234.50 ر.ي")).toThrow();
  });
});

describe("formatMoney", () => {
  it("formats minor units in Latin digits", () => {
    expect(formatMoney(123456n)).toBe("1,234.56");
    expect(formatMoney(-5n)).toBe("-0.05");
  });

  it("round-trips through the input helper", () => {
    for (const value of ["0", "0.01", "12", "12.50", "-3.25", "1000000.99"]) {
      expect(moneyToInput(parseMoney(value))).toBe(value.replace(/\.50$/, ".5"));
    }
  });
});

describe("mulDiv", () => {
  it("rounds half up", () => {
    expect(mulDiv(1000n, 333n, 1000n)).toBe(333n);
    expect(mulDiv(5n, 1n, 2n)).toBe(3n);
  });

  it("throws on zero divisor", () => {
    expect(() => mulDiv(1n, 1n, 0n)).toThrow();
  });
});

describe("percentBp", () => {
  it("applies basis points", () => {
    expect(percentBp(10000n, 1500)).toBe(1500n);
    expect(percentBp(1000n, 500)).toBe(50n);
  });
});

describe("allocateProportionally", () => {
  it("splits a total without losing minor units", () => {
    const parts = allocateProportionally(100n, [1n, 1n, 1n]);
    expect(parts.reduce((s, v) => s + v, 0n)).toBe(100n);
    expect(parts).toEqual([34n, 33n, 33n]);
  });

  it("falls back to equal split for zero weights", () => {
    const parts = allocateProportionally(10n, [0n, 0n]);
    expect(parts.reduce((s, v) => s + v, 0n)).toBe(10n);
  });
});
