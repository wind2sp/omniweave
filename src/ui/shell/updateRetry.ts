// When a silent update check (startup or 6-hourly) fails, it is tried again soon instead of waiting the whole
// 6-hour period; after these retries the period takes over again. Used by UpdateBanner.tsx.

export const RETRY_MS = [30_000, 10 * 60_000];

/** delay before the next silent check after `failures` failed ones in a row (null: wait for the 6-hour period) */
export function retryDelay(failures: number): number | null {
  return failures >= 1 && failures <= RETRY_MS.length ? RETRY_MS[failures - 1] : null;
}
