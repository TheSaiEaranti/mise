/**
 * create_event — put a new standalone event on the calendar. (SPEC §4)
 *
 * The model emits date + HH:mm + duration; THIS TOOL composes the timestamps
 * (I3). Kind 'class' is deliberately absent from the enum — classes only come
 * from semester setup, and an agent-created pinned event would be blocked by
 * the validator anyway.
 */
import { z } from 'zod';
import type { Conflict, EventChange, MutationToolDef, ToolMode, ToolResult } from '../types';
import { severityOf, titlesMatch } from '../types';
import { getDb, schema, type DB } from '../db/client';
import { getInstances, getSemester } from '../schedule';
import { buildValidation, newId } from '../proposals';
import { makeRoom, commitKnockOns } from '../cascade';
import { expandInstances, type EventRow } from '../recurrence';
import { getSplit, findDay } from '../workouts';
import { effectiveConstraints } from '@mise/config/settings';
import {
  addDaysWall,
  addMinutesWall,
  composeTs,
  dateOf,
  fmt12,
  fmtDateLong,
  minutesOfDay,
  overlapMinutes,
  parseWindow,
  timeOf,
  weekdayCode,
  DATE_RE,
  TIME_RE,
} from '../time';

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

const repeatSchema = z
  .object({
    frequency: z
      .enum(['daily', 'weekly'])
      .describe("'daily' for 'every day' / 'every other day' / 'every N days'; 'weekly' for named weekdays."),
    interval: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(1)
      .describe("How many days/weeks between occurrences. 'Every other day' → frequency 'daily', interval 2. Default 1."),
    days: z
      .array(z.enum(WEEKDAYS))
      .optional()
      .describe("Weekday codes for a WEEKLY repeat, e.g. ['MO','WE','FR']. Omit for daily. If omitted for weekly, the start date's weekday is used."),
    until: z
      .string()
      .regex(DATE_RE)
      .optional()
      .describe('Optional YYYY-MM-DD last date it repeats. Omit and it runs to the end of the semester.'),
  })
  .describe('Make this a REPEATING event. Omit entirely for a one-off.');

const argsSchema = z.object({
  title: z.string().min(1).describe("Short human title for the event, e.g. 'Gym' or 'Cook lunches'."),
  kind: z
    .enum(['gym', 'cook', 'meal', 'personal', 'commute'])
    .describe("Kind of event. 'class' is not creatable — classes only come from semester setup."),
  date: z
    .string()
    .regex(DATE_RE)
    .describe('Date of the event, YYYY-MM-DD. For a repeating event this is the FIRST occurrence.'),
  start_time: z
    .string()
    .regex(TIME_RE)
    .describe("Start time of day, 'HH:mm' 24h local. The tool composes the full timestamp — never emit one."),
  duration_minutes: z
    .number()
    .int()
    .min(5)
    .max(720)
    .describe('How long the event lasts, in minutes (5–720). The tool computes the end time.'),
  location: z
    .string()
    .optional()
    .describe("Optional location, a dumb string like a campus building code ('GDC') or 'home'. Used for commute checks."),
  notes: z.string().optional().describe('Optional free-text notes.'),
  workout: z
    .string()
    .optional()
    .describe(
      "For a GYM session: WHICH workout from Sai's split it is, by name ('Chest and back', 'Legs') or key. This " +
        "LABELS the gym block and shows its lifts; it does NOT edit the split. Only for kind 'gym'.",
    ),
  repeat: repeatSchema.optional(),
});

export type CreateEventArgs = z.infer<typeof argsSchema>;
type Repeat = z.infer<typeof repeatSchema>;

/** "1 hour" / "90 min" / "2 hours" — unsigned duration phrasing. */
function fmtDuration(mins: number): string {
  if (mins % 60 === 0) {
    const h = mins / 60;
    return `${h} ${h === 1 ? 'hour' : 'hours'}`;
  }
  return `${mins} min`;
}

const DAY_NAME: Record<string, string> = {
  MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun',
};

/** Turn the repeat intent into an rrule string, defaulting the end to the
 *  semester's last day and a weekly-without-days to the start date's weekday. */
function buildRRule(repeat: Repeat, anchorDate: string, semesterEnd: string): string {
  const until = (repeat.until ?? semesterEnd).replaceAll('-', '');
  const interval = repeat.interval ?? 1;
  if (repeat.frequency === 'daily') {
    const byday = repeat.days && repeat.days.length > 0 ? `;BYDAY=${repeat.days.join(',')}` : '';
    return `FREQ=DAILY;INTERVAL=${interval}${byday};UNTIL=${until}`;
  }
  const days = repeat.days && repeat.days.length > 0 ? repeat.days : [weekdayCode(anchorDate)];
  return `FREQ=WEEKLY;BYDAY=${days.join(',')};INTERVAL=${interval};UNTIL=${until}`;
}

/** "every other day" / "every Mon/Wed/Fri" — the human phrase for the card. */
function describeRepeat(repeat: Repeat, anchorDate: string): string {
  const n = repeat.interval ?? 1;
  if (repeat.frequency === 'daily') {
    if (repeat.days && repeat.days.length > 0) {
      const which = repeat.days.map((d) => DAY_NAME[d]).join('/');
      return n === 1 ? `every ${which}` : `every ${n} days on ${which}`;
    }
    return n === 1 ? 'every day' : n === 2 ? 'every other day' : `every ${n} days`;
  }
  const days = (repeat.days && repeat.days.length > 0 ? repeat.days : [weekdayCode(anchorDate)])
    .map((d) => DAY_NAME[d])
    .join('/');
  return n === 1 ? `every ${days}` : `every ${n} weeks on ${days}`;
}

const WAKE_LO = '06:00';
const WAKE_HI = '22:00';
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * A repeating event has to be clear on EVERY day it lands, not just its first.
 * The old check only looked at the anchor — so "cook every other day from
 * Sunday" passed (Sunday had no gym) and then sat on top of the gym every other
 * weekday. This finds a single time-of-day that overlaps nothing on any
 * occurrence, searching OUTWARD from the intended time so the block lands as
 * close to it as it can (18:00 blocked by the gym → 18:30, right after it).
 *
 * The new series yields; it never shoves what's already there. Returns the
 * chosen minute-of-day, or null when those days are too full to fit it anywhere.
 */
function findClearTime(
  db: DB,
  args: { title: string; kind: EventChange['kind']; location: string | null },
  rrule: string,
  anchorDate: string,
  semesterEnd: string,
  durationMinutes: number,
  requestedMin: number,
): number | null {
  const at = hhmm(requestedMin);
  const synthetic: EventRow = {
    id: 'synthetic', semester_id: '', title: args.title, kind: args.kind,
    starts_at: composeTs(anchorDate, at), ends_at: addMinutesWall(composeTs(anchorDate, at), durationMinutes),
    pinned: false, rrule, source: 'agent', location: args.location, notes: null, color: null, workout: null,
  };
  const occDates = expandInstances([synthetic], [], anchorDate, semesterEnd).map((o) => o.instance_date);
  if (occDates.length === 0) return requestedMin;

  const busyByDate = new Map<string, { starts_at: string; ends_at: string }[]>();
  for (const b of getInstances(db, anchorDate, occDates[occDates.length - 1]!)) {
    const arr = busyByDate.get(b.instance_date) ?? [];
    arr.push(b);
    busyByDate.set(b.instance_date, arr);
  }
  const sleep = parseWindow(effectiveConstraints().sleep.protect);
  const lo = minutesOfDay(WAKE_LO);
  const hi = minutesOfDay(WAKE_HI);

  // The HARD bound is the protected SLEEP window (Sai's real, editable hours),
  // not the tighter wake band — so an explicit 1 AM (outside a 2-9am sleep
  // window) is honoured. `fits` = clears sleep + collisions; `clearAt` adds the
  // wake band, used only when we have to SEARCH for a slot.
  const fits = (startMin: number): boolean => {
    if (startMin < 0 || startMin + durationMinutes > 24 * 60) return false;
    const t = hhmm(startMin);
    for (const d of occDates) {
      const s = composeTs(d, t);
      const e = addMinutesWall(s, durationMinutes);
      if (dateOf(e) !== d) return false; // crosses midnight
      for (const [ss, se] of sleepSegments(sleep, d)) if (overlapMinutes(s, e, ss, se) > 0) return false;
      const day = busyByDate.get(d) ?? [];
      if (day.some((i) => overlapMinutes(s, e, i.starts_at, i.ends_at) > 0)) return false;
    }
    return true;
  };
  const clearAt = (startMin: number): boolean => startMin >= lo && startMin + durationMinutes <= hi && fits(startMin);

  // Honour the exact time asked for if it clears sleep + collisions, even
  // outside the wake band. Only if it collides do we search the wake band.
  if (fits(requestedMin)) return requestedMin;
  for (let delta = 15; delta <= 24 * 60; delta += 15) {
    if (clearAt(requestedMin + delta)) return requestedMin + delta;
    if (clearAt(requestedMin - delta)) return requestedMin - delta;
  }
  return null;
}

/** The protected sleep window as [start,end] timestamp segments on a date (a
 *  window wrapping midnight splits into two). Mirrors the validator's check. */
function sleepSegments(sleep: { start: string; end: string }, date: string): Array<[string, string]> {
  if (sleep.start < sleep.end) return [[composeTs(date, sleep.start), composeTs(date, sleep.end)]];
  if (sleep.start === sleep.end) return [];
  const segs: Array<[string, string]> = [];
  if (sleep.end !== '00:00') segs.push([composeTs(date, '00:00'), composeTs(date, sleep.end)]);
  segs.push([composeTs(date, sleep.start), composeTs(addDaysWall(date, 1), '00:00')]);
  return segs;
}

async function run(args: CreateEventArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();
  const recurring = args.repeat !== undefined;

  const sem = getSemester(db);
  if (!sem) {
    // Nothing to attach the event to; both modes are a no-op.
    const summary = recurring
      ? `Create ${args.title} · ${describeRepeat(args.repeat!, args.date)}`
      : `Create ${args.title} · ${fmtDateLong(args.date, 'EEE MMM d')}`;
    return {
      diff: { summary, changes: [], unchanged_pinned: [] },
      conflicts: [{ type: 'constraint', rule: 'no_semester', message: 'Set up a semester first' }],
    };
  }

  // The calendar begins at the semester start, so an event dated before it lands
  // in the invisible pre-term zone — the classic "I added it on 'today', but the
  // term hasn't begun, so I can't see it." Clamp a too-early date up to the term
  // start; a recurring pattern then takes its first occurrence from there.
  const preTerm = args.date < sem.start_date;
  if (preTerm) args.date = sem.start_date;

  const summary = recurring
    ? `Create ${args.title} · ${describeRepeat(args.repeat!, args.date)}`
    : `Create ${args.title} · ${fmtDateLong(args.date, 'EEE MMM d')}`;

  // Don't pile up an IDENTICAL copy — but only a real one. The block is a
  // duplicate when something with the same title already sits at the same time
  // on the same day (the retry that re-adds "Cook lunches" over itself). It is
  // NOT a duplicate just because the title matches: three "Gym" sessions on
  // Mon/Tue/Wed, or a second cook at a different hour, are all legitimate. So we
  // check the first occurrence for an actual time clash, not the title alone.
  const firstStart = composeTs(args.date, args.start_time);
  const firstEnd = addMinutesWall(firstStart, args.duration_minutes);
  const clash = getInstances(db, args.date, args.date).find(
    (i) => titlesMatch(args.title, i.title) && overlapMinutes(firstStart, firstEnd, i.starts_at, i.ends_at) > 0,
  );
  if (clash) {
    return {
      diff: { summary: `${clash.title} is already there`, changes: [], unchanged_pinned: [] },
      conflicts: [
        {
          type: 'constraint',
          rule: 'duplicate',
          message: `You already have ${clash.title} at that time on ${fmtDateLong(args.date, 'EEEE')} — I didn't add a duplicate.`,
        },
      ],
    };
  }

  const rrule = recurring ? buildRRule(args.repeat!, args.date, sem.end_date) : null;
  const eventId = newId('evt');

  // A gym session can name WHICH workout it is ("Chest and back"). Resolve the
  // name (or key) to a split key so the block shows the right label and lifts.
  // Never a title edit and never on a non-gym event.
  const workoutKey =
    args.kind === 'gym' && args.workout ? (findDay(getSplit(db), args.workout)?.key ?? null) : null;

  // For a repeating event, find a time-of-day that clears EVERY occurrence, not
  // just the first — otherwise a series slotted in on a free Sunday sits on the
  // gym every other weekday. The block yields to what's already there.
  let start_time = args.start_time;
  let adjusted = false;
  if (recurring) {
    const chosen = findClearTime(
      db,
      { title: args.title, kind: args.kind, location: args.location ?? null },
      rrule!,
      args.date,
      sem.end_date,
      args.duration_minutes,
      minutesOfDay(args.start_time),
    );
    if (chosen === null) {
      return {
        diff: { summary: `No clear time for ${args.title}`, changes: [], unchanged_pinned: [] },
        conflicts: [
          {
            type: 'constraint',
            rule: 'no_clear_slot',
            message: `I couldn't find a time that's free on every one of those days — those days are pretty full. Tell me a specific time for ${args.title}, or free something up first.`,
          },
        ],
      };
    }
    adjusted = chosen !== minutesOfDay(args.start_time);
    start_time = hhmm(chosen);
  }

  const starts_at = composeTs(args.date, start_time);
  const ends_at = addMinutesWall(starts_at, args.duration_minutes);

  // The first occurrence is what we validate and show. For a repeating event the
  // change carries no before, exactly like a one-off — the card's detail line is
  // what says it recurs.
  const firstChange: EventChange = {
    event_id: eventId,
    instance_date: args.date,
    title: args.title,
    kind: args.kind,
    pinned: false,
    location: args.location ?? null,
    before: null,
    after: { starts_at, ends_at },
    recurrence: recurring ? describeRepeat(args.repeat!, args.date) : null,
  };

  // A one-off event makes room: it pushes movable things aside and never lands
  // on a class. A repeating event has ALREADY been placed at a clear time above
  // (findClearTime), so it neither pushes nor needs a cascade — it just goes in.
  const room = recurring ? null : makeRoom(db, [firstChange]);
  const changes = room ? room.changes : [firstChange];
  const knockOns = room ? room.knockOns : [];
  const outcome = buildValidation(db, changes);
  const conflicts: Conflict[] = [
    ...(preTerm
      ? [
          {
            type: 'constraint' as const,
            rule: 'pre_term',
            message: `The term starts ${fmtDateLong(sem.start_date, 'EEE MMM d')}; I scheduled ${args.title} from there, since the date given was before the term began.`,
          },
        ]
      : []),
    ...(room ? [...room.conflicts, ...outcome.conflicts] : outcome.conflicts),
  ];

  const pushed = knockOns.length;
  const base = `${fmt12(start_time)}–${fmt12(ends_at)}, ${fmtDuration(args.duration_minutes)}`;
  const detail = recurring
    ? `${base} · ${describeRepeat(args.repeat!, args.date)} through ${fmtDateLong(args.repeat!.until ?? sem.end_date, 'MMM d')}` +
      (adjusted ? ' · moved to a slot clear of your other events' : '')
    : base + (pushed > 0 ? ` · ${pushed} moved to make room` : '');
  const diff = { summary, detail, changes, unchanged_pinned: outcome.unchanged_pinned };

  if (mode === 'dry') return { diff, conflicts };

  if (conflicts.some((c) => severityOf(c) === 'blocking')) {
    return { diff, conflicts };
  }

  db.transaction((tx) => {
    tx.insert(schema.event)
      .values({
        id: eventId,
        semester_id: sem.id,
        title: args.title,
        kind: args.kind,
        starts_at,
        ends_at,
        pinned: false,
        rrule,
        source: 'agent',
        location: args.location ?? null,
        notes: args.notes ?? null,
        workout: workoutKey,
      })
      .run();
    commitKnockOns(tx as never, sem.id, knockOns);
  });

  return { diff, conflicts };
}

export const createEventTool: MutationToolDef<CreateEventArgs> = {
  name: 'create_event',
  description:
    'Create a calendar event from a date, start time (HH:mm) and duration in minutes. The tool computes the ' +
    'timestamps — never emit one. For a REPEATING event ("cook lunches every other day", "gym Mon/Wed/Fri") pass ' +
    'repeat: {frequency, interval, days} and it creates the whole series in one call — never make many single ' +
    'events for one repeating thing. For a GYM session pass workout to LABEL it with a split day ("Chest and ' +
    'back") — that labels the block, it does not edit the split. Does NOT create classes — a real course is add_classes (it pins them); create_event is for gym/cook/meal/personal/commute only.',
  parameters: z.toJSONSchema(argsSchema) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
