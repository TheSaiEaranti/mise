/**
 * set_recurring_days — change WHICH WEEKDAYS a repeating thing happens on.
 *
 * "Gym only Mon/Tue/Wed, no weekends" used to be impossible: the model had no
 * primitive for it, so it fell back to a stream of cancels-and-creates, ran out
 * of its 4 calls on a single week, and left the rest untouched (dropping a day
 * in the bargain). This does the whole reshape in ONE call, across every week
 * through the end of the semester.
 *
 * It works on the CLUSTER of same-titled, movable blocks — because gym is stored
 * as separate one-off rows (each carrying its own workout), not a single series,
 * so there's no rrule to just edit. `days` is the COMPLETE set it should be on
 * afterward: weekdays you drop are cancelled, weekdays you add get a new block
 * copied from a sibling (same time of day, kind, location, workout). Days that
 * are already right are left alone.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Conflict, EventChange, EventInstance, MutationToolDef, ToolMode, ToolResult } from '../types';
import { severityOf, titlesMatch } from '../types';
import { getDb, schema } from '../db/client';
import { getInstances, getSemester } from '../schedule';
import { buildValidation, newId } from '../proposals';
import { makeRoom, commitKnockOns } from '../cascade';
import {
  addDaysWall,
  addMinutesWall,
  composeTs,
  dateOf,
  durationMinutes,
  timeOf,
  todayInTz,
  weekMonday,
  weekdayCode,
} from '../time';

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
type Weekday = (typeof WEEKDAYS)[number];
const DAY_NAME: Record<Weekday, string> = {
  MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun',
};
const DAY_INDEX: Record<Weekday, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

const argsSchema = z.object({
  event_id: z.string().describe('Id of ANY one block of the repeating thing to reshape, from the schedule table.'),
  expect_title: z
    .string()
    .describe(
      'REQUIRED: the TITLE of that event_id, copied exactly from the schedule table. Checked against the real ' +
        'event — a mismatch refuses the change.',
    ),
  days: z
    .array(z.enum(WEEKDAYS))
    .min(1)
    .describe(
      "The COMPLETE set of weekdays it should happen on afterward, e.g. ['MO','TU','WE']. This REPLACES the current " +
        "days — the whole list, not just what's changing. 'no weekends' when he's on Mon/Wed/Sat is ['MO','WE'].",
    ),
});

export type SetRecurringDaysArgs = z.infer<typeof argsSchema>;

function refuse(summary: string, conflicts: Conflict[]): ToolResult {
  return { diff: { summary, changes: [], unchanged_pinned: [] }, conflicts };
}

async function run(args: SetRecurringDaysArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();
  const sem = getSemester(db);
  if (!sem) return refuse('No semester', [{ type: 'constraint', rule: 'no_semester', message: 'Set up a semester first.' }]);

  const row = db.select().from(schema.event).where(eq(schema.event.id, args.event_id)).get();
  if (!row) {
    return refuse('Nothing to reshape', [
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

  const wanted = new Set(args.days);
  const today = todayInTz(sem.timezone);

  // Every current instance of this same-titled, movable cluster from today on.
  const cluster = getInstances(db, today, sem.end_date).filter(
    (i) => titlesMatch(row.title, i.title) && !i.pinned,
  );
  if (cluster.length === 0) {
    return refuse('Nothing upcoming to reshape', [
      { type: 'constraint', rule: 'stale', message: `There are no upcoming ${row.title} sessions to change.` },
    ]);
  }
  const haveByDate = new Map<string, EventInstance>();
  for (const i of cluster) haveByDate.set(i.instance_date, i);

  // Only reshape the WEEKS the thing already spans — never conjure it into weeks
  // it was never in. New days fill in within those weeks; the last cluster week's
  // Sunday is the far edge (clamped to the semester), and today is the near one.
  const loopStart = weekMonday(cluster[0]!.instance_date);
  const lastWeekSunday = addDaysWall(weekMonday(cluster[cluster.length - 1]!.instance_date), 6);
  const loopEnd = lastWeekSunday < sem.end_date ? lastWeekSunday : sem.end_date;

  // A representative to copy time/kind/location/workout onto new blocks.
  const rep = cluster[0] ?? {
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    kind: row.kind,
    location: row.location,
    workout: row.workout,
  };
  const startTime = timeOf(rep.starts_at);
  const dur = durationMinutes(rep.starts_at, rep.ends_at);

  const removed: EventChange[] = [];
  const added: EventChange[] = [];

  // 1) Drop every instance on a weekday we no longer want.
  for (const inst of cluster) {
    if (!wanted.has(weekdayCode(inst.instance_date))) {
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
    }
  }

  // 2) For each week in the horizon, add a block on every wanted weekday that
  //    doesn't already have one. Weeks are anchored to Monday so the day offsets
  //    are stable; we never touch a past date.
  for (let monday = loopStart; monday <= loopEnd; monday = addDaysWall(monday, 7)) {
    for (const d of args.days) {
      const date = addDaysWall(monday, DAY_INDEX[d]);
      if (date < today || date > loopEnd) continue;
      if (haveByDate.has(date)) continue; // already there — leave it
      const starts_at = composeTs(date, startTime);
      added.push({
        event_id: newId('evt'),
        instance_date: date,
        title: row.title,
        kind: rep.kind,
        pinned: false,
        location: rep.location,
        before: null,
        after: { starts_at, ends_at: addMinutesWall(starts_at, dur) },
      });
    }
  }

  if (removed.length === 0 && added.length === 0) {
    return refuse('Already on those days', [
      { type: 'constraint', rule: 'already', message: `${row.title} already runs on exactly those days.` },
    ]);
  }

  // New blocks make room like any placement (never land on a class); removals
  // never conflict. Validate the whole batch.
  const room = makeRoom(db, added);
  const allChanges = [...removed, ...room.changes];
  const outcome = buildValidation(db, allChanges);
  const conflicts = [...room.conflicts, ...outcome.conflicts];

  const kept = args.days.map((d) => DAY_NAME[d]).join('/');
  const diff = {
    summary: `${row.title} → ${kept}`,
    detail:
      `Now on ${kept}` +
      (removed.length ? ` · dropped ${removed.length} session${removed.length === 1 ? '' : 's'}` : '') +
      (added.length ? ` · added ${added.length}` : ''),
    changes: allChanges,
    unchanged_pinned: outcome.unchanged_pinned,
  };

  if (mode === 'dry') return { diff, conflicts };
  if (conflicts.some((c) => severityOf(c) === 'blocking')) return { diff, conflicts };

  db.transaction((tx) => {
    // Removals: a recurring occurrence is hidden with a 'cancelled' exception;
    // a standalone block is deleted outright.
    for (const ch of removed) {
      const inst = haveByDate.get(ch.instance_date);
      if (inst?.recurring) {
        tx.insert(schema.eventException)
          .values({ id: newId('exc'), event_id: ch.event_id, original_date: ch.instance_date, status: 'cancelled', override_event_id: null })
          .run();
      } else {
        tx.delete(schema.event).where(eq(schema.event.id, ch.event_id)).run();
      }
    }
    // Additions: fresh one-off rows carrying the cluster's look.
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
    commitKnockOns(tx as never, sem.id, room.knockOns);
  });

  return { diff, conflicts };
}

export const setRecurringDaysTool: MutationToolDef<SetRecurringDaysArgs> = {
  name: 'set_recurring_days',
  description:
    "Change WHICH WEEKDAYS a repeating thing happens on — 'gym only Mon/Tue/Wed', 'no gym on weekends', 'move cook " +
    "to Tue/Thu'. Pass event_id + expect_title of ANY one of its blocks and days = the COMPLETE weekday set it " +
    'should be on afterward (the whole list, not just what changes). It reshapes every week at once, keeping the ' +
    'time of day. This is WHICH-DAYS; shift_events/set_event_time change WHAT-TIME. Pinned classes cannot be reshaped.',
  parameters: z.toJSONSchema(argsSchema) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
