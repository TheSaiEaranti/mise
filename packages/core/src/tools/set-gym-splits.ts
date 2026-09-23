/**
 * set_gym_splits — "make Mondays chest and back, Tuesdays shoulders and arms,
 * Wednesdays legs."
 *
 * A gym on several weekdays is ONE recurring event with ONE workout field, so it
 * physically cannot carry a different split per weekday — set_workout would stamp
 * all of Mon/Tue/Wed with the same label. Per-weekday splits need a SEPARATE
 * weekly gym per day. That's a split-and-relabel the model can't reach with the
 * existing tools (it can't even delete the old multi-weekday series). This does
 * it in ONE call: it replaces the whole gym schedule with one labelled weekly
 * gym per named weekday, at the gym's time.
 *
 * Like set_recurrence, it reshapes the same-titled cluster wholesale — the old
 * gym rows (and their exceptions) go, fresh per-weekday labelled rows come in.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Conflict, EventChange, MutationToolDef, ToolMode, ToolResult } from '../types';
import { severityOf } from '../types';
import { getDb, schema } from '../db/client';
import { getInstances, getSemester } from '../schedule';
import { buildValidation, newId } from '../proposals';
import { getSplit, findDay } from '../workouts';
import { addDaysWall, addMinutesWall, composeTs, durationMinutes, timeOf, todayInTz, weekdayCode, TIME_RE } from '../time';

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
const DAY_INDEX: Record<string, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };
const DAY_NAME: Record<string, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };

const argsSchema = z.object({
  days: z
    .array(
      z.object({
        day: z.enum(WEEKDAYS).describe('Weekday code: MO TU WE TH FR SA SU.'),
        workout: z.string().describe("The split day for that weekday, by name or key — 'Chest and back', 'Legs', 'Shoulder and arms'."),
      }),
    )
    .min(1)
    .describe('The COMPLETE gym week with a split per day, e.g. [{day:"MO",workout:"Chest and back"},{day:"TU",workout:"Shoulder and arms"},{day:"WE",workout:"Legs"}]. Replaces the whole gym schedule.'),
  start_time: z.string().regex(TIME_RE).optional().describe("HH:mm gym start time. Defaults to the current gym's time."),
  duration_minutes: z.number().int().min(15).max(240).optional().describe("Length of each session. Defaults to the current gym's length."),
});

export type SetGymSplitsArgs = z.infer<typeof argsSchema>;

function refuse(summary: string, conflicts: Conflict[]): ToolResult {
  return { diff: { summary, changes: [], unchanged_pinned: [] }, conflicts };
}

/** First date on/after `from` whose weekday is `day`. */
function firstOnDay(from: string, day: string): string {
  for (let i = 0; i < 7; i++) {
    const d = addDaysWall(from, i);
    if (weekdayCode(d) === day) return d;
  }
  return from;
}

async function run(args: SetGymSplitsArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();
  const sem = getSemester(db);
  if (!sem) return refuse('No semester', [{ type: 'constraint', rule: 'no_semester', message: 'Set up a semester first.' }]);

  const today = todayInTz(sem.timezone);
  const anchor = today < sem.start_date ? sem.start_date : today;

  // Resolve every named split to a real split-day key first — a typo shouldn't
  // wipe the gym and leave it unlabelled.
  const split = getSplit(db);
  const resolved: { day: string; key: string; name: string }[] = [];
  for (const d of args.days) {
    const w = findDay(split, d.workout);
    if (!w) {
      return refuse('Unknown split day', [
        { type: 'constraint', rule: 'bad_split', message: `"${d.workout}" isn't one of your split days (${split.days.map((x) => x.name).join(', ')}).` },
      ]);
    }
    resolved.push({ day: d.day, key: w.key, name: w.name });
  }

  // The gym's time comes from the current gym unless overridden.
  const gymInsts = getInstances(db, anchor, sem.end_date).filter((i) => i.kind === 'gym' && !i.pinned);
  const gymRows = db.select().from(schema.event).where(eq(schema.event.kind, 'gym')).all();
  const rep = gymInsts[0];
  let startTime = args.start_time ?? (rep ? timeOf(rep.starts_at) : null);
  let dur = args.duration_minutes ?? (rep ? durationMinutes(rep.starts_at, rep.ends_at) : null);
  if (!startTime || !dur) {
    return refuse('No gym time', [
      { type: 'constraint', rule: 'no_gym', message: `There's no gym on the calendar to read a time from — tell me a start_time (and length) for the gym.` },
    ]);
  }

  const until = sem.end_date.replaceAll('-', '');
  const removed: EventChange[] = gymInsts.map((i) => ({
    event_id: i.event_id,
    instance_date: i.instance_date,
    title: i.title,
    kind: i.kind,
    pinned: false,
    location: i.location,
    before: { starts_at: i.starts_at, ends_at: i.ends_at },
    after: null,
  }));

  const added: EventChange[] = [];
  const newRows: { id: string; date: string; starts_at: string; ends_at: string; rrule: string; workout: string }[] = [];
  for (const r of resolved) {
    const first = firstOnDay(anchor, r.day);
    const starts_at = composeTs(first, startTime);
    const ends_at = addMinutesWall(starts_at, dur);
    const id = newId('evt');
    const rrule = `FREQ=WEEKLY;BYDAY=${r.day};INTERVAL=1;UNTIL=${until}`;
    newRows.push({ id, date: first, starts_at, ends_at, rrule, workout: r.key });
    added.push({
      event_id: id,
      instance_date: first,
      title: 'Gym',
      kind: 'gym',
      pinned: false,
      location: rep?.location ?? null,
      before: null,
      after: { starts_at, ends_at },
      recurrence: `every ${DAY_NAME[r.day]}`,
    });
  }

  const outcome = buildValidation(db, [...removed, ...added]);

  const label = resolved.map((r) => `${DAY_NAME[r.day]}: ${r.name}`).join(' · ');
  const diff = {
    summary: `Gym split days → ${resolved.map((r) => DAY_NAME[r.day]).join('/')}`,
    detail: `${startTime}, ${dur} min · ${label}`,
    changes: [...removed, ...added],
    unchanged_pinned: outcome.unchanged_pinned,
  };

  if (mode === 'dry') return { diff, conflicts: outcome.conflicts };
  if (outcome.conflicts.some((c) => severityOf(c) === 'blocking')) return { diff, conflicts: outcome.conflicts };

  const gymIds = new Set(gymRows.map((r) => r.id));
  db.transaction((tx) => {
    // Drop the old gym world: every gym row and any exceptions on/for them.
    for (const id of gymIds) {
      tx.delete(schema.eventException).where(eq(schema.eventException.event_id, id)).run();
      tx.delete(schema.eventException).where(eq(schema.eventException.override_event_id, id)).run();
    }
    for (const id of gymIds) tx.delete(schema.event).where(eq(schema.event.id, id)).run();
    // Lay down one labelled weekly gym per named weekday.
    for (const r of newRows) {
      tx.insert(schema.event)
        .values({
          id: r.id,
          semester_id: sem.id,
          title: 'Gym',
          kind: 'gym',
          starts_at: r.starts_at,
          ends_at: r.ends_at,
          pinned: false,
          rrule: r.rrule,
          source: 'recurring',
          location: rep?.location ?? null,
          notes: null,
          color: null,
          workout: r.workout,
        })
        .run();
    }
  });

  return { diff, conflicts: outcome.conflicts };
}

export const setGymSplitsTool: MutationToolDef<SetGymSplitsArgs> = {
  name: 'set_gym_splits',
  description:
    'Set a DIFFERENT workout split for each gym weekday — "make Mondays chest and back, Tuesdays shoulders and arms, ' +
    'Wednesdays legs". A gym on several weekdays is one event with one label, so per-weekday splits need one weekly gym ' +
    'PER day; this replaces the whole gym schedule with those labelled per-day sessions in ONE call (never set_workout, ' +
    'which would label every day the same, and never create_event, which would duplicate). Pass days = the complete ' +
    'list of {day, workout}. It reads the gym\'s time from the calendar (or pass start_time/duration_minutes).',
  parameters: z.toJSONSchema(argsSchema) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
