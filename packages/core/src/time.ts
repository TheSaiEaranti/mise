/**
 * The only place time arithmetic happens. (I3)
 *
 * Storage format (see types.ts): wall-time strings in the semester timezone.
 *   timestamp  `YYYY-MM-DDTHH:mm`
 *   date       `YYYY-MM-DD`
 *   time       `HH:mm`
 *
 * Wall times are "floating": arithmetic is done on the components via
 * date-fns, deliberately ignoring DST (a 14:00 class is 14:00 on both sides
 * of a DST change). Anything that needs the *actual current moment* in the
 * semester zone goes through nowInTz/todayInTz, which use a real IANA zone.
 */
import { addDays, addMinutes, differenceInMinutes, format, parse, parseISO, startOfWeek } from 'date-fns';
import { TZDate } from '@date-fns/tz';

export const DEFAULT_TZ = 'America/Chicago';

const TS_FMT = "yyyy-MM-dd'T'HH:mm";
const DATE_FMT = 'yyyy-MM-dd';
const TIME_FMT = 'HH:mm';

export const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseTs(ts: string): Date {
  if (!TS_RE.test(ts)) throw new Error(`bad timestamp: ${ts}`);
  return parseISO(ts);
}

/** Current wall-clock timestamp in the given zone, as YYYY-MM-DDTHH:mm. */
export function nowInTz(tz: string = DEFAULT_TZ): string {
  return format(new TZDate(Date.now(), tz), TS_FMT);
}

/** Today's date in the given zone. */
export function todayInTz(tz: string = DEFAULT_TZ): string {
  return format(new TZDate(Date.now(), tz), DATE_FMT);
}

/** Shift a wall-time timestamp by whole minutes (± allowed). */
export function addMinutesWall(ts: string, delta: number): string {
  return format(addMinutes(parseTs(ts), delta), TS_FMT);
}

/** Shift a date by whole days. */
export function addDaysWall(date: string, delta: number): string {
  if (!DATE_RE.test(date)) throw new Error(`bad date: ${date}`);
  return format(addDays(parseISO(date), delta), DATE_FMT);
}

/** b - a in minutes (positive when b is later). */
export function diffMinutes(a: string, b: string): number {
  return differenceInMinutes(parseTs(b), parseTs(a));
}

/** `YYYY-MM-DD` part of a timestamp. */
export function dateOf(ts: string): string {
  return ts.slice(0, 10);
}

/** `HH:mm` part of a timestamp. */
export function timeOf(ts: string): string {
  return ts.slice(11, 16);
}

/** Compose date + HH:mm into a timestamp. */
export function composeTs(date: string, time: string): string {
  if (!DATE_RE.test(date)) throw new Error(`bad date: ${date}`);
  if (!TIME_RE.test(time)) throw new Error(`bad time: ${time}`);
  return `${date}T${time}`;
}

/** Minutes past midnight for an HH:mm string. */
export function minutesOfDay(time: string): number {
  if (!TIME_RE.test(time)) throw new Error(`bad time: ${time}`);
  const h = Number(time.slice(0, 2));
  const m = Number(time.slice(3, 5));
  return h * 60 + m;
}

/** Overlap in whole minutes between [aS,aE) and [bS,bE); 0 when disjoint. */
export function overlapMinutes(aS: string, aE: string, bS: string, bE: string): number {
  const s = aS > bS ? aS : bS;
  const e = aE < bE ? aE : bE;
  return s < e ? diffMinutes(s, e) : 0;
}

/** Monday of the week containing `date`. Weeks start Monday (SPEC §3). */
export function weekMonday(date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`bad date: ${date}`);
  return format(startOfWeek(parseISO(date), { weekStartsOn: 1 }), DATE_FMT);
}

/** RFC5545 weekday code (MO..SU) for a date. */
export function weekdayCode(date: string): 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU' {
  const codes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
  return codes[parseISO(date).getDay()]!;
}

/** Every date from start to end inclusive. */
export function rangeDates(start: string, end: string): string[] {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) throw new Error(`bad range: ${start}..${end}`);
  const out: string[] = [];
  for (let d = start; d <= end; d = addDaysWall(d, 1)) out.push(d);
  return out;
}

/** Duration in minutes between two timestamps on the same or adjacent days. */
export function durationMinutes(startsAt: string, endsAt: string): number {
  return diffMinutes(startsAt, endsAt);
}

/** Parse 'HH:mm-HH:mm' window strings used in config/constraints.ts. */
export function parseWindow(win: string): { start: string; end: string } {
  const [start, end] = win.split('-');
  if (!start || !end || !TIME_RE.test(start) || !TIME_RE.test(end)) {
    throw new Error(`bad window: ${win}`);
  }
  return { start, end };
}

/** Human formatting helpers for UI/chat (kept here so formats stay uniform). */
export function fmtTimeShort(ts: string): string {
  return timeOf(ts);
}

/**
 * 12-hour clock for DISPLAY ONLY. Storage, tool args, and the model's context
 * all stay 24-hour `HH:mm` — one unambiguous format everywhere the machine
 * reads, one human format everywhere Sai reads.
 *
 * `17:00` → `5 PM`, `18:45` → `6:45 PM`, `00:30` → `12:30 AM`.
 * :00 drops the minutes; the AM/PM is a hair-space away so a column of times
 * still stacks cleanly in tabular figures.
 */
export function fmt12(time: string): string {
  const t = time.length > 5 ? timeOf(time) : time;
  if (!TIME_RE.test(t)) return time;
  const h24 = Number(t.slice(0, 2));
  const m = t.slice(3, 5);
  const mer = h24 < 12 ? 'AM' : 'PM';
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === '00' ? `${h} ${mer}` : `${h}:${m} ${mer}`;
}

/**
 * Rewrite any 24-hour clock time in a sentence into 12-hour.
 *
 * The system prompt tells the model to speak in 12-hour, and it mostly does —
 * then slips out a "(16:00–17:30)". Asking an 8B model nicely is not a guarantee,
 * so this makes it one: whatever it says, Sai reads a clock he uses.
 *
 * Only touches bare HH:mm. A full timestamp (2026-07-14T17:00) is left alone —
 * those appear in machine text, not in prose.
 */
export function humanizeTimes(text: string): string {
  return text.replace(
    /(^|[^\dT:-])(\d{1,2}):([0-5]\d)(?![\d:])(\s*(?:am|pm|a\.m\.|p\.m\.))?/gi,
    (whole: string, pre: string, h: string, m: string, mer: string | undefined) => {
      // Already carries an AM/PM — the model wrote 12-hour. Leave it exactly.
      if (mer !== undefined) return whole;

      const hour = Number(h);
      const padded = h.length === 2;

      // Only rewrite what is UNAMBIGUOUSLY a 24-hour clock:
      //   13:00–23:59  · can't be 12-hour
      //   00:xx        · can't be 12-hour
      //   09:05        · zero-padded single digit is machine formatting
      // A bare "5:45" or "12:30" is how a person writes 12-hour time; rewriting
      // it produced "5:45 AM–6:45 AMpm" — a mangling worse than the leak.
      const is24h = hour >= 13 || hour === 0 || (padded && hour < 10);
      if (!is24h) return whole;

      return `${pre}${fmt12(`${h.padStart(2, '0')}:${m}`)}`;
    },
  );
}

/** A time RANGE for display: `5 – 6:30 PM`, dropping the repeated meridiem. */
export function fmtRange12(startTs: string, endTs: string): string {
  const a = fmt12(startTs);
  const b = fmt12(endTs);
  const merA = a.slice(-2);
  const merB = b.slice(-2);
  // Same half of the day → say AM/PM once, at the end.
  return merA === merB ? `${a.slice(0, -3)} – ${b}` : `${a} – ${b}`;
}

export function fmtDateLong(date: string, fmt = 'EEEE MMM d'): string {
  return format(parseISO(date), fmt);
}
