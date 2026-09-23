/**
 * Fast path: the highest-frequency edits, resolved without a model call.
 *
 *   "move <block> to <time>"        → set_event_time (keeps its length)
 *   "move <block> to <day>"         → shift_events single, ±whole days
 *   "push <block> back/up N min"    → shift_events single, ±N minutes
 *   "move <block> N minutes later"  (with "tomorrow's", "monday's", "on friday"…)
 *   "shift everything [after <time>] <day> back/later/earlier N"
 *                                   → shift_events day scope (pinned blocks stay;
 *                                     the tool skips them, the validator checks)
 *
 * It only PROPOSES a tool call. The call then goes through exactly the path a
 * model's call does — dry-run, a Proposal row, the validator via
 * applyProposal — and the validator stays the only authority (I4: a pinned
 * class is never even proposed here; the model explains those).
 *
 * Conservative by design: anything it can't read with certainty returns null
 * and the turn falls through to the model — a bare "at 6", "forward", a
 * plural or compound target, "everything", two matching blocks, no matching
 * block, a move that would cross midnight.
 */
import type { DB } from './db/client';
import { getInstances, getSemester } from './schedule';
import { addDaysWall, addMinutesWall, dateOf, diffMinutes, timeOf, weekdayCode } from './time';
import { normalize, weekdayDate } from './router';
import type { EventInstance } from './types';

export type FastIntent =
  | { kind: 'time'; target: string; day: string | null; time: string }
  | { kind: 'day'; target: string; day: string | null; toDay: string }
  | { kind: 'delta'; target: string; day: string | null; minutes: number }
  | { kind: 'bulk'; day: string; afterTime: string | null; minutes: number };

export interface FastCall {
  tool: 'set_event_time' | 'shift_events';
  args: Record<string, unknown>;
  /** The block being moved; null for a whole-day shift. */
  instance: EventInstance | null;
  date: string;
}

const VERB = '(?:move|push|shift|bump|slide|reschedule)';
// Full names first: "(sat)(day)?" can't match "saturday".
const DAYWORD = '(?:today|tonight|tomorrow|tmrw|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)';
// 24-hour form only when it can't be misread: "08:30", "18:00" — not "11:15"
// (rule 3a reads a bare evening-ish time as PM; the model decides those).
const TIME = '(?:(\\d{1,2})(?::(\\d{2}))? ?(am|pm)|noon|(0\\d|1[3-9]|2[0-3]):([0-5]\\d))';
const NUM = '(\\d{1,3}|an?|one|two|three|half an?)';
const UNIT = '(min|mins|minute|minutes|hour|hours|hr|hrs)';

const WEEKDAY_CODE: Record<string, string> = { sun: 'SU', mon: 'MO', tue: 'TU', wed: 'WE', thu: 'TH', fri: 'FR', sat: 'SA' };

/** Words that mean "more than one thing" — the model handles those. */
const BULK = /\b(?:everything|all|stuff|things|both|and|sessions|blocks|classes|events)\b|,/;

function toMinutes(n: string, unit: string): number | null {
  const base = /^\d+$/.test(n) ? Number(n) : n === 'a' || n === 'an' || n === 'one' ? 1 : n === 'two' ? 2 : n === 'three' ? 3 : /^half/.test(n) ? 0.5 : NaN;
  if (!Number.isFinite(base)) return null;
  const mins = /^h/.test(unit) ? base * 60 : base;
  if (/^half/.test(n) && !/^h/.test(unit)) return null; // "half a minute"
  return Number.isInteger(mins) ? mins : null;
}

function to24(m: RegExpExecArray, i: number): string | null {
  if (m[i] === undefined && m[i + 3] === undefined && /noon/.test(m[0])) return '12:00';
  if (m[i + 3] !== undefined) return `${m[i + 3]}:${m[i + 4]}`; // 24h
  const h = Number(m[i]);
  const min = m[i + 1] ?? '00';
  if (!(h >= 1 && h <= 12)) return null;
  const h24 = m[i + 2] === 'pm' ? (h % 12) + 12 : h % 12;
  return `${String(h24).padStart(2, '0')}:${min}`;
}

/** Split "<day>'s gym" / "gym on friday" / "gym tomorrow" into target + day word. */
function splitTarget(raw: string): { target: string; day: string | null } | null {
  let t = raw.replace(/^(?:my|the) /, '').trim();
  let day: string | null = null;
  const pre = new RegExp(`^(${DAYWORD})(?:'s)? (?:my |the )?(.+)$`).exec(t);
  const post = new RegExp(`^(.+?) (?:on |this )?(${DAYWORD})$`).exec(t);
  if (pre) {
    day = pre[1]!;
    t = pre[2]!;
  } else if (post) {
    t = post[1]!;
    day = post[2]!;
  }
  t = t.replace(/^(?:my|the) /, '').replace(/ (?:block|session)$/, '').trim();
  if (t.length < 3 || BULK.test(t) || new RegExp(`\\b${DAYWORD}\\b`).test(t)) return null;
  return { target: t, day };
}

/** Parse one of the fast-path phrasings, or null. Pure — no database. */
export function parseFastIntent(message: string): FastIntent | null {
  const m = normalize(message)
    .replace(/^(?:can you |could you |please )/, '')
    .replace(/(?: please)?[.!?]*$/, '')
    .trim();
  if (m.length > 80) return null;

  // Whole-day shift. The day must be named — "push everything back" alone is
  // too vague to act on without the model.
  const bulk = new RegExp(`^${VERB} everything (.+?) (back|later|earlier|up) (?:by )?${NUM} ?${UNIT}$`).exec(m);
  if (bulk) {
    let middle = bulk[1]!;
    let afterTime: string | null = null;
    const at = new RegExp(`\\b(?:after|from|past) ${TIME}`).exec(middle);
    if (at) {
      afterTime = to24(at, 1);
      if (!afterTime) return null;
      middle = middle.replace(at[0], ' ');
    }
    const dm = new RegExp(`\\b(?:on )?(${DAYWORD})\\b`).exec(middle);
    if (!dm) return null;
    if (dm[1] === 'tonight' && afterTime === null) return null; // "tonight" isn't the whole day
    middle = middle.replace(dm[0], ' ').trim();
    if (middle !== '') return null; // something we didn't understand
    const mins = toMinutes(bulk[3]!, bulk[4]!);
    if (mins === null || mins <= 0 || mins > 720) return null;
    const dir = bulk[2]!;
    return { kind: 'bulk', day: dm[1]!, afterTime, minutes: dir === 'earlier' || dir === 'up' ? -mins : mins };
  }

  let r = new RegExp(`^${VERB} (.+?) (?:to|at) ${TIME}$`).exec(m);
  if (r) {
    const time = to24(r, 2);
    const st = splitTarget(r[1]!);
    return time && st ? { kind: 'time', ...st, time } : null;
  }
  r = new RegExp(`^${VERB} (.+?) to (${DAYWORD})$`).exec(m);
  if (r) {
    const st = splitTarget(r[1]!);
    return st ? { kind: 'day', ...st, toDay: r[2]! } : null;
  }
  r = new RegExp(`^${VERB} (.+?) (back|later|earlier|up) (?:by )?${NUM} ?${UNIT}$`).exec(m) ?? null;
  let dir: string | undefined;
  let n: string | undefined;
  let unit: string | undefined;
  let target: string | undefined;
  if (r) [, target, dir, n, unit] = r;
  else {
    const r2 = new RegExp(`^${VERB} (.+?) (?:by )?${NUM} ?${UNIT} (back|later|earlier)$`).exec(m);
    if (r2) [, target, n, unit, dir] = r2;
  }
  if (target && n && unit && dir) {
    const mins = toMinutes(n, unit);
    const st = splitTarget(target);
    if (mins === null || mins <= 0 || mins > 720 || !st) return null;
    return { kind: 'delta', ...st, minutes: dir === 'earlier' || dir === 'up' ? -mins : mins };
  }
  return null;
}

function dayWordToDate(word: string, today: string, from: string): string | null {
  if (word === 'today' || word === 'tonight') return today;
  if (word === 'tomorrow' || word === 'tmrw') return addDaysWall(today, 1);
  const code = WEEKDAY_CODE[word.slice(0, 3)];
  if (!code) return null;
  // Exactly the CALENDAR block's rule: a bare weekday is the soonest one at or
  // after today — never "the one after <from>", which jumps a week for an
  // earlier weekday ("thursday's gym to tuesday").
  void from;
  return weekdayDate(today, code);
}

/**
 * Turn a parsed intent into ONE tool call against the real calendar, or null
 * when the calendar makes it ambiguous. `today` is the context's today (the
 * same one the CALENDAR block uses).
 */
export function resolveFastCall(db: DB, intent: FastIntent, today: string): FastCall | null {
  const date = intent.day ? dayWordToDate(intent.day, today, today) : today; // no day named → today (rule 5a)
  if (!date) return null;
  if (intent.kind === 'bulk') {
    const movable = getInstances(db, date, date).filter(
      (i) => !i.pinned && (intent.afterTime === null || timeOf(i.starts_at) >= intent.afterTime),
    );
    if (movable.length === 0) return null; // nothing to shift — let the model say so
    // Nothing may be pushed past midnight (or before it).
    if (movable.some((i) => dateOf(addMinutesWall(i.starts_at, intent.minutes)) !== date || dateOf(addMinutesWall(i.ends_at, intent.minutes)) !== date)) return null;
    return {
      tool: 'shift_events',
      args: { scope: 'day', date, delta_minutes: intent.minutes, ...(intent.afterTime ? { after_time: intent.afterTime } : {}) },
      instance: null,
      date,
    };
  }
  const t = intent.target;
  const kind = /^(?:gym|workout|lift|lifting)$/.test(t) ? 'gym' : /^(?:cook|cooking|meal prep|cook lunches)$/.test(t) ? 'cook' : null;
  // Whole words only: "run" must not match "Brunch".
  const word = new RegExp(`(?:^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`);
  const matches = getInstances(db, date, date).filter((i) => (kind ? i.kind === kind : word.test(i.title.toLowerCase())));
  if (matches.length !== 1) return null;
  const inst = matches[0]!;
  if (inst.pinned) return null; // the model explains why a class can't move

  if (intent.kind === 'time') {
    // "12am" / "1:30am": a start in the small hours is almost never meant
    // literally (and would land earlier today). The model can ask.
    if (intent.time < '05:00') return null;
    const len = diffMinutes(inst.starts_at, inst.ends_at);
    const start = `${date}T${intent.time}`;
    const end = addMinutesWall(start, len);
    if (dateOf(end) !== date || start === inst.starts_at) return null;
    return {
      tool: 'set_event_time',
      args: { event_id: inst.event_id, expect_title: inst.title, date, start_time: intent.time, end_time: timeOf(end) },
      instance: inst,
      date,
    };
  }
  let delta: number;
  if (intent.kind === 'day') {
    const to = dayWordToDate(intent.toDay, today, date);
    // Forward moves only; "thursday's gym to tuesday" (backward, or a week
    // out) is the model's to resolve.
    if (!to || to <= date) return null;
    const sem = getSemester(db);
    if (sem && to > sem.end_date) return null; // past the term: it would vanish from view
    const days = Math.round(diffMinutes(`${date}T00:00`, `${to}T00:00`) / 1440);
    if (days <= 0 || weekdayCode(to) === weekdayCode(date)) return null;
    delta = days * 1440;
  } else {
    delta = intent.minutes;
    if (dateOf(addMinutesWall(inst.starts_at, delta)) !== date || dateOf(addMinutesWall(inst.ends_at, delta)) !== date) return null;
  }
  return {
    tool: 'shift_events',
    args: { scope: 'single', date, event_id: inst.event_id, expect_title: inst.title, delta_minutes: delta },
    instance: inst,
    date,
  };
}
