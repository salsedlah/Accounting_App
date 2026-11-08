import { describe, expect, it } from "vitest";
import { retryAt, retryDelayMs } from "@/lib/offline/retry";

describe("offline sync retry schedule", () => {
  it("uses exponential backoff and caps the delay at one hour", () => {
    expect(retryDelayMs(1)).toBe(5_000);
    expect(retryDelayMs(2)).toBe(10_000);
    expect(retryDelayMs(3)).toBe(20_000);
    expect(retryDelayMs(20)).toBe(60 * 60 * 1_000);
  });

  it("calculates the next retry timestamp from the supplied time", () => {
    expect(retryAt(2, 1_000)).toBe(11_000);
  });
});
