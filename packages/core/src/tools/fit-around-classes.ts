/**
 * fit_around_classes — "fit cook between my classes, or before a class."
 *
 * A generalisation of slot_between_classes for a block whose day rotates (cook
 * every 3 days lands on a 2-class day, a 1-class day, a no-class day in turn).
 * On EVERY day the block occurs, it places it around that day's classes:
 *   - 2+ classes → in the first inter-class gap that fits (after the earlier one,
 *     honouring a buffer),
 *   - exactly 1 class → just BEFORE that class (ending a buffer before it),
 *   - no classes → a midday default (noon), so "cook lunches" stays a daytime
 *     block instead of sitting in the evening.
 * Whole horizon, one call. Recurring occurrences move via an override; standalone
 * rows are updated — the same retime spine as slot_between_classes.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Conflict, EventChange, EventInstance, MutationToolDef, ToolMode, ToolResult } from '../types';
import { severityOf, titlesMatch } from '../types';
import { getDb, schema } from '../db/client';
import { getInstances, getSemester } from '../schedule';
import { buildValidation, newId } from '../proposals';
import { makeRoom, commitKnockOns } from '../cascade';
import { addMinutesWall, composeTs, durationMinutes, fmtDateLong, timeOf, todayInTz } from '../time';

const DAY_START = '07:00'; // nothing lands before the waking day
const DEFAULT_TIME = '12:00'; // no-class days: a daytime lunch slot

const argsSchema = z.object({
  event_id: z.string().describe('Id of ANY one block of the thing to fit, from the schedule table (e.g. a Cook lunches block).'),
  expect_title: z.string().describe('REQUIRED: the TITLE of that event_id, copied exactly from the schedule table. Checked against the real event.'),
  gap_minutes: z
    .number()
    .int()
    .min(0)
    .max(240)
    .default(30)
    .describe('Buffer minutes to leave between the block and a class (after the earlier class when between, before the class when before). Default 30.'),
});

export type FitAroundClassesArgs = z.infer<typeof argsSchema>;

function refuse(summary: string, conflicts: Conflict[]): ToolResult {
  return { diff: { summary, changes: [], unchanged_pinned: [] }, conflicts };
}

/** Where to start the block on a given day, given that day's classes. */
function placeFor(date: string, classes: EventInstance[], dur: number, gap: number): string {
  const sorted = [...classes].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  // 2+ classes → the first inter-class gap that fits (buffer after the earlier).
  for (let i = 0; i < sorted.length - 1; i++) {
    const gapStart = sorted[i]!.ends_at;
    const gapEnd = sorted[i + 1]!.starts_at;
    const withBuffer = addMinutesWall(gapStart, gap);
    if (addMinutesWall(withBuffer, dur) <= gapEnd) return withBuffer;
    if (addMinutesWall(gapStart, dur) <= gapEnd) return gapStart;
  }
  // 1 class (or no gap fit) → just before the first class, buffered.
  if (sorted.length >= 1) {
    const buffered = addMinutesWall(sorted[0]!.starts_at, -(dur + gap));
    if (timeOf(buffered) >= DAY_START) return buffered;
    const flush = addMinutesWall(sorted[0]!.starts_at, -dur);
    if (timeOf(flush) >= DAY_START) return flush;
  }
  // No classes (or nothing fit before an early class) → a midday default.
  return composeTs(date, DEFAULT_TIME);
}

async function run(args: FitAroundClassesArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();
  const sem = getSemester(db);
  if (!sem) return refuse('No semester', [{ type: 'constraint', rule: 'no_semester', message: 'Set up a semester first.' }]);

  const row = db.select().from(schema.event).where(eq(schema.event.id, args.event_id)).get();
  if (!row) {
    return refuse('Nothing to fit', [{ type: 'constraint', rule: 'stale', message: `Event ${args.event_id} no longer exists — nothing was changed.` }]);
  }
  if (!titlesMatch(args.expect_title, row.title)) {
    return {
      diff: { summary: 'Wrong event — nothing changed', changes: [], unchanged_pinned: [] },
      conflicts: [{ type: 'wrong_event', event_id: row.id, expected: args.expect_title, actual: row.title }],
    };
  }
  if (row.pinned) {
    return { diff: { summary: `${row.title} is pinned`, changes: [], unchanged_pinned: [] }, conflicts: [{ type: 'pinned_moved', event_id: row.id, title: row.title }] };
  }

  const gap = args.gap_minutes ?? 30;
  const today = todayInTz(sem.timezone);
  const all = getInstances(db, today, sem.end_date);
  const blocks = all.filter((i) => titlesMatch(row.title, i.title) && !i.pinned);
  if (blocks.length === 0) {
    return refuse('Nothing upcoming', [{ type: 'constraint', rule: 'stale', message: `There are no upcoming ${row.title} sessions to fit.` }]);
  }
  const classesByDate = new Map<string, EventInstance[]>();
  for (const i of all) {
    if (i.kind !== 'class') continue;
    const list = classesByDate.get(i.instance_date) ?? [];
    list.push(i);
    classesByDate.set(i.instance_date, list);
  }

  const changes: EventChange[] = [];
  const wasRecurring = new Map<string, boolean>();
  for (const b of blocks) {
    const classes = classesByDate.get(b.instance_date) ?? [];
    const dur = durationMinutes(b.starts_at, b.ends_at);
    const start = placeFor(b.instance_date, classes, dur, gap);
    const end = addMinutesWall(start, dur);
    if (start === b.starts_at && end === b.ends_at) continue; // already there
    changes.push({
      event_id: b.event_id,
      instance_date: b.instance_date,
      title: b.title,
      kind: b.kind,
      pinned: false,
      location: b.location,
      before: { starts_at: b.starts_at, ends_at: b.ends_at },
      after: { starts_at: start, ends_at: end },
    });
    wasRecurring.set(`${b.event_id}|${b.instance_date}`, !!b.recurring);
  }

  if (changes.length === 0) {
    return refuse('Nothing to fit', [{ type: 'constraint', rule: 'already', message: `${row.title} is already fitted around your classes.` }]);
  }

  const room = makeRoom(db, changes);
  const outcome = buildValidation(db, room.changes);
  const conflicts = [...room.conflicts, ...outcome.conflicts];

  const diff = {
    summary: `${row.title} → fitted around classes on ${changes.length} day${changes.length === 1 ? '' : 's'}`,
    detail: changes.map((c) => `${fmtDateLong(c.instance_date, 'EEE')} ${timeOf(c.after!.starts_at)}`).join(' · '),
    changes: room.changes,
    unchanged_pinned: outcome.unchanged_pinned,
  };
  if (mode === 'dry') return { diff, conflicts };
  if (conflicts.some((c) => severityOf(c) === 'blocking')) return { diff, conflicts };

  db.transaction((tx) => {
    for (const ch of changes) {
      if (!ch.after) continue;
      if (wasRecurring.get(`${ch.event_id}|${ch.instance_date}`)) {
        const base = tx.select().from(schema.event).where(eq(schema.event.id, ch.event_id)).get();
        if (!base) continue;
        const overrideId = newId('evt');
        tx.insert(schema.event)
          .values({
            id: overrideId,
            semester_id: sem.id,
            title: base.title,
            kind: base.kind,
            starts_at: ch.after.starts_at,
            ends_at: ch.after.ends_at,
            pinned: base.pinned,
            rrule: null,
            source: 'agent',
            location: base.location,
            notes: base.notes,
            color: base.color,
            workout: base.workout,
          })
          .run();
        tx.insert(schema.eventException)
          .values({ id: newId('exc'), event_id: ch.event_id, original_date: ch.instance_date, status: 'moved', override_event_id: overrideId })
          .run();
      } else {
        tx.update(schema.event).set({ starts_at: ch.after.starts_at, ends_at: ch.after.ends_at }).where(eq(schema.event.id, ch.event_id)).run();
      }
    }
    commitKnockOns(tx as never, sem.id, room.knockOns);
  });
  return { diff, conflicts };
}

export const fitAroundClassesTool: MutationToolDef<FitAroundClassesArgs> = {
  name: 'fit_around_classes',
  description:
    'MULTI-DAY: fit a block around each day\'s classes — "fit cook between my classes or before a class", "put cook ' +
    'around my class schedule". On EVERY upcoming day the block occurs it places it: in the gap BETWEEN classes when ' +
    'there are two, just BEFORE the class when there is one, and at a midday default when there are none. One call, whole ' +
    'schedule. Use this (not create_event, which drops it in a default evening slot) whenever a block should sit relative ' +
    "to that day's classes. Pass event_id + expect_title of any one block; optional gap_minutes (buffer, default 30).",
  parameters: z.toJSONSchema(argsSchema) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
