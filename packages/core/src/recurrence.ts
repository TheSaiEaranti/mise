/**
 * Recurrence expansion. PURE — no DB, no I/O. (SPEC §3)
 *
 * Two shapes exist. WEEKLY with BYDAY is the class schedule ("MWF at 10").
 * DAILY with an INTERVAL is what Sai reaches for when he sets up a habit —
 * "cook lunches every other day" is FREQ=DAILY;INTERVAL=2. Both take optional
 * INTERVAL and UNTIL. Anything else (MONTHLY, YEARLY) is a bug upstream and
 * throws loudly rather than being silently mis-expanded.
 */
import type { EventInstance } from './types';
import {
  addDaysWall,
  addMinutesWall,
  composeTs,
  dateOf,
  durationMinutes,
  timeOf,
  weekMonday,
  weekdayCode,
} from './time';
import type { event, eventException } from './db/schema';

export type EventRow = typeof event.$inferSelect;
export type ExceptionRow = typeof eventException.$inferSelect;

const BYDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type ByDay = (typeof BYDAY_CODES)[number];

export interface ParsedRRule {
  freq: 'WEEKLY' | 'DAILY';
  /** Which weekdays. Required for WEEKLY; for DAILY an optional filter
   *  (empty = every day the interval lands on). */
  byday: ByDay[];
  interval: number;
  /** YYYY-MM-DD, inclusive last date an occurrence may fall on. */
  until?: string;
}

// UNTIL accepted as YYYYMMDD, YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ — only the
// date part is kept (occurrence granularity here is a day).
const UNTIL_RE = /^(\d{4})(\d{2})(\d{2})(?:T\d{6}Z?)?$/;

/**
 * Rotate every BYDAY code in an rrule string by dayDelta days (MO +1 → TU),
 * leaving everything else in the string untouched. Used when a whole series is
 * dragged to a different weekday: the BYDAY list IS the weekly pattern, so a
 * cross-day series move must rotate it or the series snaps back. A rule with
 * no BYDAY (plain DAILY interval) comes back unchanged — its day lives in the
 * anchor date, which the caller shifts.
 */
export function rotateBydayInRrule(rrule: string, dayDelta: number): string {
  const rot = ((dayDelta % 7) + 7) % 7;
  if (rot === 0) return rrule;
  return rrule.replace(/BYDAY=([^;]*)/i, (_, list: string) => {
    const rotated = list
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter((c) => c !== '')
      .map((c) => {
        const i = (BYDAY_CODES as readonly string[]).indexOf(c);
        return i === -1 ? c : BYDAY_CODES[(i + rot) % 7]!;
      });
    return `BYDAY=${rotated.join(',')}`;
  });
}

/** Parse an RFC5545 weekly rule like "FREQ=WEEKLY;BYDAY=MO,WE,FR". */
export function parseRRule(rrule: string): ParsedRRule {
  const trimmed = rrule.trim();
  if (trimmed === '') throw new Error('rrule is empty');

  const kv = new Map<string, string>();
  for (const part of trimmed.split(';')) {
    if (part === '') continue; // tolerate a trailing semicolon
    const eq = part.indexOf('=');
    if (eq <= 0 || eq === part.length - 1) {
      throw new Error(`malformed rrule part "${part}" in "${rrule}"`);
    }
    kv.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1));
  }

  const freqRaw = kv.get('FREQ');
  if (freqRaw === undefined) throw new Error(`rrule missing FREQ: "${rrule}"`);
  const freq = freqRaw.toUpperCase();
  if (freq !== 'WEEKLY' && freq !== 'DAILY') {
    throw new Error(`unsupported FREQ=${freqRaw} in "${rrule}" — only WEEKLY and DAILY patterns exist in this app`);
  }

  // BYDAY is mandatory for WEEKLY (it IS the pattern) and an optional filter for
  // DAILY. "Every other day" carries no BYDAY; "every weekday" could carry one.
  const bydayRaw = kv.get('BYDAY');
  if (freq === 'WEEKLY' && (bydayRaw === undefined || bydayRaw === '')) {
    throw new Error(`rrule missing BYDAY: "${rrule}"`);
  }
  const byday: ByDay[] = [];
  if (bydayRaw !== undefined && bydayRaw !== '') {
    for (const code of bydayRaw.split(',')) {
      const c = code.trim().toUpperCase();
      if (!(BYDAY_CODES as readonly string[]).includes(c)) {
        throw new Error(`bad BYDAY code "${code}" in "${rrule}"`);
      }
      if (!byday.includes(c as ByDay)) byday.push(c as ByDay); // dedupe
    }
  }

  let interval = 1;
  const intervalRaw = kv.get('INTERVAL');
  if (intervalRaw !== undefined) {
    if (!/^\d+$/.test(intervalRaw) || Number(intervalRaw) < 1) {
      throw new Error(`bad INTERVAL=${intervalRaw} in "${rrule}"`);
    }
    interval = Number(intervalRaw);
  }

  const untilRaw = kv.get('UNTIL');
  if (untilRaw === undefined) return { freq, byday, interval };
  const m = UNTIL_RE.exec(untilRaw);
  if (!m) throw new Error(`bad UNTIL=${untilRaw} in "${rrule}"`);
  return { freq, byday, interval, until: `${m[1]}-${m[2]}-${m[3]}` };
}

function toInstance(e: EventRow, startsAt: string, endsAt: string, recurring: boolean): EventInstance {
  return {
    event_id: e.id,
    instance_date: dateOf(startsAt),
    title: e.title,
    kind: e.kind,
    starts_at: startsAt,
    ends_at: endsAt,
    pinned: e.pinned,
    location: e.location,
    notes: e.notes,
    source: e.source,
    recurring,
    color: e.color,
    workout: e.workout,
  };
}

/**
 * Expand events into concrete instances within [windowStart, windowEnd]
 * (inclusive dates).
 *
 * Non-recurring events appear iff dateOf(starts_at) is inside the window.
 * Recurring events expand weekly per BYDAY: the event's own starts_at date is
 * the pattern anchor — the week containing it is week 0 for INTERVAL purposes
 * and nothing is generated before it. An exception row (any status) drops its
 * occurrence; for 'moved' the replacement is a standalone event row that gets
 * picked up by the non-recurring branch, never synthesized here.
 */
export function expandInstances(
  events: EventRow[],
  exceptions: ExceptionRow[],
  windowStart: string,
  windowEnd: string,
): EventInstance[] {
  // Both 'cancelled' and 'moved' drop the original occurrence.
  // A null byte joins the two parts so no id or date can ever forge a key.
  const dropKey = (id: string, date: string) => `${id}\u0000${date}`;
  const dropped = new Set(exceptions.map((x) => dropKey(x.event_id, x.original_date)));
  const out: EventInstance[] = [];

  for (const e of events) {
    if (e.rrule === null) {
      const d = dateOf(e.starts_at);
      if (d >= windowStart && d <= windowEnd) out.push(toInstance(e, e.starts_at, e.ends_at, false));
      continue;
    }

    const rule = parseRRule(e.rrule);
    const anchor = dateOf(e.starts_at);
    const first = anchor > windowStart ? anchor : windowStart;
    const last = rule.until !== undefined && rule.until < windowEnd ? rule.until : windowEnd;
    if (last < first) continue;

    const startTime = timeOf(e.starts_at);
    // Duration-based end keeps the base HH:mm and survives cross-midnight events.
    const dur = durationMinutes(e.starts_at, e.ends_at);

    if (rule.freq === 'DAILY') {
      // Step from the anchor by INTERVAL days, so the phase ("every OTHER day
      // from Sunday") is fixed by counting, never by date subtraction. An
      // optional BYDAY narrows it ("every weekday").
      for (let d = anchor; d <= last; d = addDaysWall(d, rule.interval)) {
        if (d < first) continue;
        if (rule.byday.length > 0 && !rule.byday.includes(weekdayCode(d))) continue;
        if (dropped.has(dropKey(e.id, d))) continue;
        const startsAt = composeTs(d, startTime);
        out.push(toInstance(e, startsAt, addMinutesWall(startsAt, dur), true));
      }
      continue;
    }

    // Walk week by week from the anchor's Monday (week 0) so INTERVAL is pure
    // counting — no date subtraction, no DST hazards.
    for (let monday = weekMonday(anchor), week = 0; monday <= last; monday = addDaysWall(monday, 7), week++) {
      if (week % rule.interval !== 0) continue;
      for (let i = 0; i < 7; i++) {
        const d = addDaysWall(monday, i);
        if (d > last) break;
        if (d < first) continue;
        if (!rule.byday.includes(weekdayCode(d))) continue;
        if (dropped.has(dropKey(e.id, d))) continue;
        const startsAt = composeTs(d, startTime);
        out.push(toInstance(e, startsAt, addMinutesWall(startsAt, dur), true));
      }
    }
  }

  out.sort((a, b) =>
    a.starts_at < b.starts_at ? -1
    : a.starts_at > b.starts_at ? 1
    : a.title < b.title ? -1
    : a.title > b.title ? 1
    : 0,
  );
  return out;
}
