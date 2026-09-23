/**
 * set_event_time — put ONE event instance at an exact start and end.
 *
 * shift_events moves a block by a delta and keeps its length; this sets the
 * clock times outright, so it is how you change how LONG something is, not just
 * when it starts. It's what the popover's Start/End fields and the resize-drag
 * both commit through, and what the model reaches for when Sai names times
 * ("make gym 6 to 8", "make my cook session 2 hours").
 *
 * Same spine as every other placement:
 *   - the id must be the event that was named (expect_title), or it's refused;
 *   - PINNED events are never retimed — a class stays where it is (I4). The
 *     model can't do it and neither can a click; the block itself doesn't drag
 *     or offer the fields.
 *   - the new time MAKES ROOM: movable things in the way are pushed later, and
 *     landing on a class is refused outright (see cascade.ts).
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Conflict, EventChange, MutationToolDef, ToolMode, ToolResult } from '../types';
import { isRealChange, severityOf, titlesMatch } from '../types';
import { getDb, schema } from '../db/client';
import { getInstances, getSemester } from '../schedule';
import { buildValidation, newId } from '../proposals';
import { makeRoom, commitKnockOns } from '../cascade';
import { composeTs, diffMinutes, fmt12, fmtRange12, minutesOfDay, DATE_RE, TIME_RE } from '../time';

const argsSchema = z.object({
  event_id: z.string().describe('Id of the event instance to retime.'),
  expect_title: z
    .string()
    .describe(
      'REQUIRED: the TITLE of that event_id, copied exactly from the schedule table. Checked against the real ' +
        'event — if the id points at something else, the change is refused.',
    ),
  date: z
    .string()
    .regex(DATE_RE)
    .describe('YYYY-MM-DD of the instance being retimed. For a recurring event this says which occurrence.'),
  start_time: z.string().regex(TIME_RE).describe("New start time of day, 'HH:mm' 24h local."),
  end_time: z.string().regex(TIME_RE).describe("New end time of day, 'HH:mm' 24h local. Must be after start_time."),
});

export type SetEventTimeArgs = z.infer<typeof argsSchema>;

function noTarget(summary: string, conflicts: Conflict[]): ToolResult {
  return { diff: { summary, changes: [], unchanged_pinned: [] }, conflicts };
}

async function run(args: SetEventTimeArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();
  const row = db.select().from(schema.event).where(eq(schema.event.id, args.event_id)).get();
  if (!row) {
    return noTarget('Nothing to retime', [
      { type: 'constraint', rule: 'stale', message: `Event ${args.event_id} no longer exists — nothing was changed` },
    ]);
  }

  // The id must be the event that was named — same guard as shift/cancel.
  if (!titlesMatch(args.expect_title, row.title)) {
    return {
      diff: { summary: 'Wrong event — nothing changed', changes: [], unchanged_pinned: [] },
      conflicts: [{ type: 'wrong_event', event_id: row.id, expected: args.expect_title, actual: row.title }],
    };
  }

  // A class is an anchor. It doesn't move, and it doesn't get its hours edited —
  // not by the model, not by a retime call. (I4)
  if (row.pinned) {
    return {
      diff: {
        summary: `${row.title} is pinned — not retimed`,
        changes: [
          {
            event_id: row.id,
            instance_date: args.date,
            title: row.title,
            kind: row.kind,
            pinned: true,
            before: { starts_at: row.starts_at, ends_at: row.ends_at },
            after: { starts_at: row.starts_at, ends_at: row.ends_at },
          },
        ],
        unchanged_pinned: [],
      },
      conflicts: [{ type: 'pinned_moved', event_id: row.id, title: row.title }],
    };
  }

  // end must be after start. Same day only — nothing in this app crosses
  // midnight, and the day grid stops at 12am.
  if (minutesOfDay(args.end_time) <= minutesOfDay(args.start_time)) {
    return noTarget('Bad times', [
      {
        type: 'constraint',
        rule: 'bad_times',
        message: `${fmt12(args.end_time)} isn't after ${fmt12(args.start_time)} — the end has to come after the start.`,
      },
    ]);
  }

  // Find the instance on that date (recurring events only exist as instances).
  const recurring = row.rrule !== null;
  const inst = recurring
    ? getInstances(db, args.date, args.date).find((i) => i.event_id === args.event_id && i.instance_date === args.date)
    : { starts_at: row.starts_at, ends_at: row.ends_at, instance_date: args.date };
  if (!inst) {
    return noTarget('Nothing to retime', [
      { type: 'constraint', rule: 'stale', message: `${row.title} has no instance on ${args.date} anymore — nothing was changed` },
    ]);
  }

  const after = { starts_at: composeTs(args.date, args.start_time), ends_at: composeTs(args.date, args.end_time) };
  const change: EventChange = {
    event_id: row.id,
    instance_date: args.date,
    title: row.title,
    kind: row.kind,
    pinned: false,
    location: row.location,
    before: { starts_at: inst.starts_at, ends_at: inst.ends_at },
    after,
  };

  // Already exactly there? Say so rather than reporting a change that didn't
  // happen — the resize-drag and the fields can both land on the current time.
  if (!isRealChange(change)) {
    return noTarget('Already at that time', [
      { type: 'constraint', rule: 'already_there', message: `${row.title} is already ${fmtRange12(after.starts_at, after.ends_at)}.` },
    ]);
  }

  const room = makeRoom(db, [change]);
  const outcome = buildValidation(db, room.changes);
  const conflicts = [...room.conflicts, ...outcome.conflicts];

  const pushed = room.knockOns.length;
  const mins = diffMinutes(after.starts_at, after.ends_at);
  const diff = {
    summary: `${row.title} → ${fmtRange12(after.starts_at, after.ends_at)}`,
    detail:
      `${mins % 60 === 0 ? `${mins / 60} ${mins === 60 ? 'hour' : 'hours'}` : `${mins} min`}` +
      (pushed > 0 ? ` · ${pushed} moved to make room` : ''),
    changes: room.changes,
    unchanged_pinned: outcome.unchanged_pinned,
  };

  if (mode === 'dry') return { diff, conflicts };
  if (conflicts.some((c) => severityOf(c) === 'blocking')) return { diff, conflicts };

  const sem = getSemester(db);
  db.transaction((tx) => {
    if (recurring) {
      // Retime ONE occurrence: exception + standalone override at the new times,
      // carrying the base event's look so the moved instance still reads right.
      const base = tx.select().from(schema.event).where(eq(schema.event.id, row.id)).get();
      if (base && sem) {
        const overrideId = newId('evt');
        tx.insert(schema.event)
          .values({
            id: overrideId,
            semester_id: sem.id,
            title: base.title,
            kind: base.kind,
            starts_at: after.starts_at,
            ends_at: after.ends_at,
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
          .values({
            id: newId('exc'),
            event_id: row.id,
            original_date: args.date,
            status: 'moved',
            override_event_id: overrideId,
          })
          .run();
      }
    } else {
      tx.update(schema.event)
        .set({ starts_at: after.starts_at, ends_at: after.ends_at })
        .where(eq(schema.event.id, row.id))
        .run();
    }
    if (sem) commitKnockOns(tx as never, sem.id, room.knockOns);
  });

  return { diff, conflicts };
}

export const setEventTimeTool: MutationToolDef<SetEventTimeArgs> = {
  name: 'set_event_time',
  description:
    'Set one event to an exact start and end time (HH:mm) — use this when Sai names the times or a new length, ' +
    '"make gym 6 to 8", "cook session should be 2 hours". Unlike shift_events this changes how long the block is, ' +
    'not just when it starts. Pinned events (classes) cannot be retimed. If the new time collides with something ' +
    'movable it is pushed later automatically; landing on a class is refused.',
  parameters: z.toJSONSchema(argsSchema) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
