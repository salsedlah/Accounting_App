import { describe, expect, it } from "vitest";
import { EXPIRY_WARNING_DAYS, getExpiryStatus } from "@/lib/expiry";

const today = new Date(2026, 10, 7);

describe("getExpiryStatus", () => {
  it("does not warn when the expiry date is more than 30 days away", () => {
    expect(getExpiryStatus("2026-12-08", today)).toBeNull();
  });

  it("warns for dates within the 30-day window, including today", () => {
    expect(getExpiryStatus("2026-12-07", today)).toEqual({
      daysRemaining: EXPIRY_WARNING_DAYS,
      type: "near",
    });
    expect(getExpiryStatus("2026-11-07", today)).toEqual({
      daysRemaining: 0,
      type: "near",
    });
  });

  it("marks past dates as expired", () => {
    expect(getExpiryStatus("2026-11-06", today)).toEqual({
      daysRemaining: -1,
      type: "expired",
    });
  });

  it("ignores missing and invalid dates", () => {
    expect(getExpiryStatus(null, today)).toBeNull();
    expect(getExpiryStatus("2026-02-30", today)).toBeNull();
  });
});
