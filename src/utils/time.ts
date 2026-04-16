/**
 * Time utility helpers for tour window comparisons and scheduling.
 */

/**
 * Returns true if two time windows overlap.
 * All values are ISO 8601 date strings.
 */
export function windowsOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string
): boolean {
  const a1 = new Date(aStart).getTime();
  const a2 = new Date(aEnd).getTime();
  const b1 = new Date(bStart).getTime();
  const b2 = new Date(bEnd).getTime();
  // Overlap if a starts before b ends AND a ends after b starts
  return a1 < b2 && a2 > b1;
}

/**
 * Returns true if a given ISO date string falls within the current calendar month.
 */
export function isInCurrentMonth(dateStr: string): boolean {
  const date = new Date(dateStr);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth()
  );
}

/**
 * Returns a Date object offset by a given number of milliseconds from now.
 */
export function fromNowMs(ms: number): Date {
  return new Date(Date.now() + ms);
}

/**
 * 1 hour in milliseconds — used as the default offer timeout.
 */
export const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Formats a Date to a human-readable string for Slack messages.
 */
export function formatForSlack(date: Date): string {
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}
