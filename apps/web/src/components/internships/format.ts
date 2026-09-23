/**
 * Date formatting for the internships board. Internship timestamps are full
 * ISO 8601 UTC strings (unlike the calendar's wall-time convention), so plain
 * Date math is correct here — no timezone gymnastics required.
 */

/** "just now" · "5m ago" · "3h ago" · "12d ago" — the feed's whole clock. */
export function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** Posted within the last 72 hours → the NEW badge. */
export function isNew(datePosted: string): boolean {
  const ms = Date.now() - Date.parse(datePosted);
  return Number.isFinite(ms) && ms <= 72 * 3_600_000;
}

/** "Jun 12" this year, "Jun 12, 2025" otherwise. */
export function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}
