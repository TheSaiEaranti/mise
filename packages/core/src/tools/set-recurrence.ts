/**
 * set_recurrence — change HOW OFTEN a repeating thing happens to "every N days".
 *
 * The sibling tool set_recurring_days handles WHICH WEEKDAYS ('Mon/Wed/Fri').
 * But "make cook every third day" / "every other day" is an INTERVAL, not a
 * weekday set — it rotates through the week (07-16, 07-19, 07-22, …). There was
 * no primitive for it, so the model fell back to create_event with a custom
 * rrule, which STACKED a second cook series on top of the old one — leaving cook
 * on Mon+Wed+Thu+Sat instead of replacing the schedule. This is the missing
 * primitive: it reshapes the existing same-titled cluster in place.
 *
 * Same machinery as set_recurring_days: it works on the CLUSTER of same-titled
 * movable blocks (a thing's schedule can be a recurring series PLUS one-off
 * overrides), drops every occurrence that isn't on the new every-N-days grid,
 * and lays a fresh block on every grid date that lacks one — at a single uniform
 * time. Occurrences already on the grid at that time are left alone. Removals of
 * a recurring occurrence become a 'cancelled' exception; standalone rows are
 * deleted; additions are new one-off rows. That keeps undo identical to
 * set_recurring_days.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Conflict, EventChange, EventInstance, MutationToolDef, ToolMode, ToolResult } from '../types';
import { severityOf, titlesMatch } from '../types';
import { getDb, schema } from '../db/client';
import { getInstances, getSemester } from '../schedule';
import { buildValidation, newId } from '../proposals';
import { addDaysWall, addMinutesWall, composeTs, DATE_RE, durationMinutes, timeOf, todayInTz } from '../time';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const argsSchema = z.object({
  event_id: z.string().describe('Id of ANY one block of the repeating thing to re-cadence, from the schedule table.'),
  expect_title: z
    .string()
    .describe(
      'REQUIRED: the TITLE of that event_id, copied exactly from the schedule table. Checked against the real ' +
        'event — a mismatch refuses the change.',
    ),
  interval_days: z
    .number()
    .int()
    .min(1)
    .max(60)
    .describe('Repeat every this many days. 2 = every other day, 3 = every third day, 7 = weekly.'),
  start_date: z
    .string()
    .regex(DATE_RE)
    .optional()
    .describe('YYYY-MM-DD of the FIRST occurrence of the new pattern. Defaults to the next upcoming block.'),
  time: z
    .string()
    .regex(TIME_RE)
    .optional()
    .describe("HH:mm (24h) start time for every occurrence. Defaults to the block's current time of day."),
});

export type SetRecurrenceArgs = z.infer<typeof argsSchema>;

function refuse(summary: string, conflicts: Conflict[]): ToolResult {
  return { diff: { summary, changes: [], unchanged_pinned: [] }, conflicts };
}

async function run(args: SetRecurrenceArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();
  const sem = getSemester(db);
  if (!sem) return refuse('No semester', [{ type: 'constraint', rule: 'no_semester', message: 'Set up a semester first.' }]);

  const row = db.select().from(schema.event).where(eq(schema.event.id, args.event_id)).get();
  if (!row) {
    return refuse('Nothing to re-cadence', [
      { type: 'constraint', rule: 'stale', message: `Event ${args.event_id} no longer exists — nothing was changed.` },
    ]);
  }
  if (!titlesMatch(args.expect_title, row.title)) {
    return {
      diff: { summary: 'Wrong event — nothing changed', changes: [], unchanged_pinned: [] },
      conflicts: [{ type: 'wrong_event', event_id: row.id, expected: args.expect_title, actual: row.title }],
    };
  }
  if (row.pinned) {
    return {
      diff: { summary: `${row.title} is pinned`, changes: [], unchanged_pinned: [] },
      conflicts: [{ type: 'pinned_moved', event_id: row.id, title: row.title }],
    };
  }

  const today = todayInTz(sem.timezone);

  // Every current instance of this same-titled, movable cluster from today on.
  const cluster = getInstances(db, today, sem.end_date).filter((i) => titlesMatch(row.title, i.title) && !i.pinned);
  if (cluster.length === 0) {
    return refuse('Nothing upcoming to re-cadence', [
      { type: 'constraint', rule: 'stale', message: `There are no upcoming ${row.title} sessions to change.` },
    ]);
  }

  const rep = cluster[0]!;
  const startTime = args.time ?? timeOf(rep.starts_at);
  const dur = durationMinutes(rep.starts_at, rep.ends_at);
  const N = args.interval_days;

  // The every-N-days grid, from the anchor through the cluster's current horizon.
  const anchor = args.start_date && args.start_date >= today ? args.start_date : cluster[0]!.instance_date;
  const farEdge = cluster[cluster.length - 1]!.instance_date; // already within the semester
  const targetDates: string[] = [];
  for (let d = anchor; d <= farEdge; d = addDaysWall(d, N)) if (d >= today) targetDates.push(d);
  if (targetDates.length === 0) {
    return refuse('No dates', [
      { type: 'constraint', rule: 'bad_range', message: `Every ${N} days from ${anchor} lands no sessions before ${farEdge}.` },
    ]);
  }
  const targetSet = new Set(targetDates);

  const byDate = new Map<string, EventInstance[]>();
  for (const i of cluster) {
    const list = byDate.get(i.instance_date) ?? [];
    list.push(i);
    byDate.set(i.instance_date, list);
  }

  const removed: EventChange[] = [];
  const added: EventChange[] = [];
  // event_id|date → was it a recurring occurrence (cancel via exception) or a
  // standalone row (delete)? Needed only at commit.
  const wasRecurring = new Map<string, boolean>();
  const drop = (inst: EventInstance) => {
    removed.push({
      event_id: inst.event_id,
      instance_date: inst.instance_date,
      title: inst.title,
      kind: inst.kind,
      pinned: false,
      location: inst.location,
      before: { starts_at: inst.starts_at, ends_at: inst.ends_at },
      after: null,
    });
    wasRecurring.set(`${inst.event_id}|${inst.instance_date}`, !!inst.recurring);
  };

  // Drop every occurrence not on the grid.
  for (const inst of cluster) if (!targetSet.has(inst.instance_date)) drop(inst);
  // On each grid date, keep ONE block at the target time; drop the rest; add one
  // if none is already there (this dedupes and unifies the time in one pass).
  for (const date of targetDates) {
    const existing = byDate.get(date) ?? [];
    const keeper = existing.find((i) => timeOf(i.starts_at) === startTime);
    if (keeper) {
      for (const i of existing) if (i !== keeper) drop(i);
    } else {
      for (const i of existing) drop(i);
      const starts_at = composeTs(date, startTime);
      added.push({
        event_id: newId('evt'),
        instance_date: date,
        title: row.title,
        kind: row.kind,
        pinned: false,
        location: rep.location,
        before: null,
        after: { starts_at, ends_at: addMinutesWall(starts_at, dur) },
      });
    }
  }

  if (removed.length === 0 && added.length === 0) {
    return refuse('Already every ' + N + ' days', [
      { type: 'constraint', rule: 'already', message: `${row.title} already runs every ${N} days at that time.` },
    ]);
  }

  const outcome = buildValidation(db, [...removed, ...added]);

  const diff = {
    summary: `${row.title} → every ${N} days`,
    detail:
      `Every ${N} day${N === 1 ? '' : 's'} at ${startTime}` +
      (removed.length ? ` · dropped ${removed.length}` : '') +
      (added.length ? ` · added ${added.length}` : ''),
    changes: [...removed, ...added],
    unchanged_pinned: outcome.unchanged_pinned,
  };

  if (mode === 'dry') return { diff, conflicts: outcome.conflicts };
  if (outcome.conflicts.some((c) => severityOf(c) === 'blocking')) return { diff, conflicts: outcome.conflicts };

  db.transaction((tx) => {
    for (const ch of removed) {
      if (wasRecurring.get(`${ch.event_id}|${ch.instance_date}`)) {
        tx.insert(schema.eventException)
          .values({ id: newId('exc'), event_id: ch.event_id, original_date: ch.instance_date, status: 'cancelled', override_event_id: null })
          .run();
      } else {
        tx.delete(schema.event).where(eq(schema.event.id, ch.event_id)).run();
      }
    }
    for (const ch of added) {
      if (!ch.after) continue;
      tx.insert(schema.event)
        .values({
          id: ch.event_id,
          semester_id: sem.id,
          title: ch.title,
          kind: ch.kind,
          starts_at: ch.after.starts_at,
          ends_at: ch.after.ends_at,
          pinned: false,
          rrule: null,
          source: 'agent',
          location: ch.location ?? null,
          notes: null,
          color: row.color,
          workout: rep.workout,
        })
        .run();
    }
  });

  return { diff, conflicts: outcome.conflicts };
}

export const setRecurrenceTool: MutationToolDef<SetRecurrenceArgs> = {
  name: 'set_recurrence',
  description:
    'Change HOW OFTEN a repeating thing happens to an INTERVAL — "make cook every third day", "gym every other day", ' +
    '"every 3 days". Pass event_id + expect_title of ANY one of its blocks and interval_days (2 = every other day, ' +
    '3 = every third day). Optionally start_date (first occurrence) and time (HH:mm). It REPLACES the current cadence ' +
    'in place across the whole schedule — never create a NEW event for this, or you double-book the old and new ' +
    'patterns. This is HOW-OFTEN (interval); set_recurring_days is WHICH-WEEKDAYS (Mon/Wed/Fri). Pinned classes cannot ' +
    'be re-cadenced.',
  parameters: z.toJSONSchema(argsSchema) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
