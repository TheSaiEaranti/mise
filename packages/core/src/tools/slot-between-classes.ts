/**
 * slot_between_classes — "on the days I have two classes, cook between them."
 *
 * This is a MULTI-DAY placement, and the local model can't do those reliably by
 * hand: it only sees a slice of the schedule and tends to fix the first matching
 * day and stop, so "cook between my classes" moved one Wednesday and left the
 * other two-class days alone. Like set_recurring_days / set_recurrence, this does
 * the WHOLE horizon in ONE call: it scans every upcoming day, and on each day
 * where the named block AND two-or-more classes both occur, it drops the block
 * into the gap between the classes (just after the earlier one, honoring a buffer
 * if it fits). Recurring occurrences move via an override; standalone rows are
 * updated — the same retime spine as set_event_time.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Conflict, EventChange, EventInstance, MutationToolDef, ToolMode, ToolResult } from '../types';
import { severityOf, titlesMatch } from '../types';
import { getDb, schema } from '../db/client';
import { getInstances, getSemester } from '../schedule';
import { buildValidation, newId } from '../proposals';
import { makeRoom, commitKnockOns } from '../cascade';
import { addMinutesWall, durationMinutes, fmtDateLong, todayInTz } from '../time';

const argsSchema = z.object({
  event_id: z.string().describe('Id of ANY one block of the thing to slot in, from the schedule table (e.g. a Cook lunches block).'),
  expect_title: z
    .string()
    .describe('REQUIRED: the TITLE of that event_id, copied exactly from the schedule table. Checked against the real event.'),
  gap_minutes: z
    .number()
    .int()
    .min(0)
    .max(240)
    .default(30)
    .describe('Minutes to leave after the earlier class before the block starts, when there is room. Default 30.'),
});

export type SlotBetweenClassesArgs = z.infer<typeof argsSchema>;

function refuse(summary: string, conflicts: Conflict[]): ToolResult {
  return { diff: { summary, changes: [], unchanged_pinned: [] }, conflicts };
}

/** The earliest start (wall ts) in the first inter-class gap that fits `dur`,
 *  leaving `gap` after the earlier class when there's room. null = fits nowhere. */
function slotFor(classes: EventInstance[], dur: number, gap: number): string | null {
  for (let i = 0; i < classes.length - 1; i++) {
    const gapStart = classes[i]!.ends_at;
    const gapEnd = classes[i + 1]!.starts_at;
    const withBuffer = addMinutesWall(gapStart, gap);
    if (addMinutesWall(withBuffer, dur) <= gapEnd) return withBuffer; // fits with the buffer
    if (addMinutesWall(gapStart, dur) <= gapEnd) return gapStart; // fits only flush against the class
  }
  return null;
}

async function run(args: SlotBetweenClassesArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();
  const sem = getSemester(db);
  if (!sem) return refuse('No semester', [{ type: 'constraint', rule: 'no_semester', message: 'Set up a semester first.' }]);

  const row = db.select().from(schema.event).where(eq(schema.event.id, args.event_id)).get();
  if (!row) {
    return refuse('Nothing to slot', [
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

  // The schema default only applies when args are parsed (API/agent path); a
  // direct run() call passes raw args, so default here too.
  const gapMinutes = args.gap_minutes ?? 30;
  const today = todayInTz(sem.timezone);
  const all = getInstances(db, today, sem.end_date);
  const blocks = all.filter((i) => titlesMatch(row.title, i.title) && !i.pinned);
  if (blocks.length === 0) {
    return refuse('Nothing upcoming', [
      { type: 'constraint', rule: 'stale', message: `There are no upcoming ${row.title} sessions to slot in.` },
    ]);
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
  let noRoom = 0;
  for (const b of blocks) {
    const classes = (classesByDate.get(b.instance_date) ?? []).sort((x, y) => x.starts_at.localeCompare(y.starts_at));
    if (classes.length < 2) continue; // not a two-class day
    const dur = durationMinutes(b.starts_at, b.ends_at);
    const start = slotFor(classes, dur, gapMinutes);
    if (!start) {
      noRoom++;
      continue;
    }
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
    const msg =
      noRoom > 0
        ? `No room between the classes to fit ${row.title} on those days.`
        : `No upcoming day has ${row.title} and two classes to slot between.`;
    return refuse('Nothing to slot', [{ type: 'constraint', rule: 'already', message: msg }]);
  }

  // Moving the block may collide with other movable blocks that day; push them.
  const room = makeRoom(db, changes);
  const outcome = buildValidation(db, room.changes);
  const conflicts = [...room.conflicts, ...outcome.conflicts];

  const diff = {
    summary: `${row.title} → between classes on ${changes.length} day${changes.length === 1 ? '' : 's'}`,
    detail:
      changes.map((c) => fmtDateLong(c.instance_date, 'EEE MMM d')).join(', ') + (noRoom > 0 ? ` · ${noRoom} had no room` : ''),
    changes: room.changes,
    unchanged_pinned: outcome.unchanged_pinned,
  };

  if (mode === 'dry') return { diff, conflicts };
  if (conflicts.some((c) => severityOf(c) === 'blocking')) return { diff, conflicts };

  db.transaction((tx) => {
    for (const ch of changes) {
      if (!ch.after) continue;
      if (wasRecurring.get(`${ch.event_id}|${ch.instance_date}`)) {
        // Retime one occurrence of a recurring series: exception + override row.
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
        tx.update(schema.event)
          .set({ starts_at: ch.after.starts_at, ends_at: ch.after.ends_at })
          .where(eq(schema.event.id, ch.event_id))
          .run();
      }
    }
    commitKnockOns(tx as never, sem.id, room.knockOns);
  });

  return { diff, conflicts };
}

export const slotBetweenClassesTool: MutationToolDef<SlotBetweenClassesArgs> = {
  name: 'slot_between_classes',
  description:
    'MULTI-DAY: on EVERY upcoming day where the named block and two-or-more classes both occur, move the block into ' +
    'the gap between the classes — in ONE call. Use for "on the days I have two classes, cook between them", "put my ' +
    'study block between my classes". Pass event_id + expect_title of any one of its blocks; optional gap_minutes ' +
    '(buffer after the earlier class, default 30). It scans the whole schedule so no matching day is missed. ' +
    'Pinned classes cannot be slotted.',
  parameters: z.toJSONSchema(argsSchema) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
