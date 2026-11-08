const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;

export function retryDelayMs(retryCount: number): number {
  const exponent = Math.max(0, Math.min(Math.floor(retryCount) - 1, 20));
  return Math.min(INITIAL_RETRY_DELAY_MS * 2 ** exponent, MAX_RETRY_DELAY_MS);
}

export function retryAt(retryCount: number, now = Date.now()): number {
  return now + retryDelayMs(retryCount);
}
