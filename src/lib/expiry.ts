const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

export const EXPIRY_WARNING_DAYS = 30;

export type ExpiryStatus = {
  daysRemaining: number;
  type: "expired" | "near";
};

export function getExpiryStatus(
  expiryDate: string | null | undefined,
  today = new Date(),
): ExpiryStatus | null {
  const match = expiryDate?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const [, year, month, day] = match;
  const expiryTimestamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const parsedDate = new Date(expiryTimestamp);
  if (
    parsedDate.getUTCFullYear() !== Number(year) ||
    parsedDate.getUTCMonth() !== Number(month) - 1 ||
    parsedDate.getUTCDate() !== Number(day)
  ) {
    return null;
  }

  const todayTimestamp = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const daysRemaining = Math.round((expiryTimestamp - todayTimestamp) / DAY_MILLISECONDS);
  if (daysRemaining < 0) return { daysRemaining, type: "expired" };
  if (daysRemaining <= EXPIRY_WARNING_DAYS) return { daysRemaining, type: "near" };
  return null;
}

export function formatExpiryDate(expiryDate: string): string {
  const [year, month, day] = expiryDate.split("-").map(Number);
  return new Intl.DateTimeFormat("ar-YE", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}
