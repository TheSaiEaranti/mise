/**
 * shift_events — move a set of calendar instances by a delta. (SPEC §4)
 *
 * The model emits INTENT ONLY (scope + delta_minutes); this tool computes the
 * new timestamps via time.ts (I3). Pinned instances are never targeted — they
 * show up in the diff's unchanged_pinned section instead (I4), and the
 * validator would block them anyway.
 */
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { EventKind, EventChange, MutationToolDef, ToolMode, ToolResult } from '../types';
import { EVENT_KINDS, severityOf, titlesMatch } from '../types';
import { getDb, schema, type DB } from '../db/client';
import { getInstances, getSemester } from '../schedule';
import { buildValidation, newId } from '../proposals';
import { makeRoom, commitKnockOns } from '../cascade';
import { rotateBydayInRrule } from '../recurrence';
import { addDaysWall, addMinutesWall, composeTs, dateOf, durationMinutes, fmt12, fmtDateLong, timeOf, DATE_RE, TIME_RE } from '../time';
import type { EventInstance } from '../types';

const argsSchema = z
  .object({
    scope: z
      .enum(['day', 'range', 'single', 'series'])
      .describe(
        "What to shift: every instance on one day ('day'), across a date range ('range'), a single event instance " +
          "('single'), or the WHOLE recurring series ('series' — every occurrence of a repeating event moves to the new " +
          "time, and it STICKS across weeks; this is what a drag on a repeating block should do).",
      ),
    date: z
      .string()
      .regex(DATE_RE)
      .describe('Anchor date, YYYY-MM-DD. For scope day/single this is the day being shifted.'),
    end_date: z
      .string()
      .regex(DATE_RE)
      .optional()
      .describe("Last date of the range, YYYY-MM-DD, inclusive. Required when scope is 'range'."),
    event_id: z
      .string()
      .optional()
      .describe("Id of the event to shift. Required when scope is 'single'."),
    expect_title: z
      .string()
      .optional()
      .describe(
        "Required when scope is 'single': the TITLE of that event_id, copied exactly from the schedule table. " +
          'This is checked against the real event — if the id you picked is a different event, the move is refused. ' +
          "If the thing Sai named isn't in the table on that date, say so instead of picking another event.",
      ),
    delta_minutes: z
      .number()
      .int()
      // ±1 week: a cross-day drag on the week grid is expressed as a delta too
      // (e.g. Tue 17:00 → Thu 18:00 is +2910), so day-crossing moves stay pure
      // intent and the tool still owns every timestamp. (I3)
      .min(-10080)
      .max(10080)
      .describe(
        'Minutes to shift by: positive = later, negative = earlier. Never 0. ' +
          'Whole days are multiples of 1440 (tomorrow = +1440). ' +
          'Never emit a timestamp — the tool computes new times.',
      ),
    kinds: z
      .array(z.enum(EVENT_KINDS as [EventKind, ...EventKind[]]))
      .optional()
      .describe('Optional filter: only shift instances of these kinds (e.g. only gym and cook).'),
    after_time: z
      .string()
      .regex(TIME_RE)
      .optional()
      .describe("Optional HH:mm — only shift instances starting at or after this time of day (e.g. '15:00' for \"everything after 3pm\")."),
  })
  .superRefine((v, ctx) => {
    if (v.delta_minutes === 0) {
      ctx.addIssue({ code: 'custom', path: ['delta_minutes'], message: 'delta_minutes must not be 0' });
    }
    if (v.scope === 'range' && v.end_date === undefined) {
      ctx.addIssue({ code: 'custom', path: ['end_date'], message: "end_date is required when scope is 'range'" });
    }
    if ((v.scope === 'single' || v.scope === 'series') && v.event_id === undefined) {
      ctx.addIssue({ code: 'custom', path: ['event_id'], message: `event_id is required when scope is '${v.scope}'` });
    }
    // Required, not optional: an unchecked id is exactly how the wrong event
    // gets moved. Omitting it fails the schema and the model is asked again.
    if ((v.scope === 'single' || v.scope === 'series') && v.expect_title === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['expect_title'],
        message:
          `expect_title is required when scope is '${v.scope}' — copy the title of that event_id from the schedule table`,
      });
    }
  });

export type ShiftEventsArgs = z.infer<typeof argsSchema>;

/** "+60 min" — the diff-card summary form (always minutes). */
function fmtDeltaMin(mins: number): string {
  return `${mins < 0 ? '-' : '+'}${Math.abs(mins)} min`;
}

/** "+1 hour" / "-30 min" / "+90 min" — detail form, hours when divisible by 60. */
function fmtDeltaHuman(mins: number): string {
  const sign = mins < 0 ? '-' : '+';
  const abs = Math.abs(mins);
  if (abs % 60 === 0) {
    const h = abs / 60;
    return `${sign}${h} ${h === 1 ? 'hour' : 'hours'}`;
  }
  return `${sign}${abs} min`;
}

function summaryFor(args: ShiftEventsArgs, targetTitle: string | null): string {
  const delta = fmtDeltaMin(args.delta_minutes);
  if (args.scope === 'single') return `Shift ${targetTitle ?? 'event'} · ${delta}`;
  if (args.scope === 'range' && args.end_date !== undefined && args.end_date !== args.date) {
    return `Shift ${fmtDateLong(args.date, 'MMM d')}–${fmtDateLong(args.end_date, 'MMM d')} · ${delta}`;
  }
  return `Shift ${fmtDateLong(args.date, 'EEEE')} · ${delta}`;
}

function selectTargets(args: ShiftEventsArgs, instances: EventInstance[]): EventInstance[] {
  let targets = instances;
  if (args.scope === 'single') {
    targets = targets.filter((i) => i.event_id === args.event_id && i.instance_date === args.date);
  }
  // Pinned instances are never shift targets (I4) — they render as
  // unchanged_pinned in the diff instead.
  targets = targets.filter((i) => !i.pinned);
  if (args.kinds !== undefined && args.kinds.length > 0) {
    targets = targets.filter((i) => args.kinds!.includes(i.kind));
  }
  if (args.after_time !== undefined) {
    targets = targets.filter((i) => timeOf(i.starts_at) >= args.after_time!);
  }
  return targets;
}

/**
 * Move a whole RECURRING SERIES to a new time (what a drag on a repeating block
 * should do). The anchor is the instance the user grabbed — either the base
 * recurring row or a moved-override that points back at it. We set the base
 * event's time to where the anchor was dragged, and clear the series' moved
 * overrides so every occurrence follows — so the change STICKS across weeks
 * instead of evaporating next week (the "my manual move didn't record" bug).
 */
async function runSeries(db: DB, args: ShiftEventsArgs, mode: ToolMode): Promise<ToolResult> {
  const anchor = getInstances(db, args.date, args.date).find(
    (i) => i.event_id === args.event_id && i.instance_date === args.date,
  );
  if (!anchor) {
    return {
      diff: { summary: 'Nothing to shift', changes: [], unchanged_pinned: [] },
      conflicts:
        mode === 'commit'
          ? [{ type: 'constraint', rule: 'stale', message: `Event ${args.event_id} has no instance on ${args.date} anymore — nothing was changed` }]
          : [],
    };
  }
  if (args.expect_title !== undefined && !titlesMatch(args.expect_title, anchor.title)) {
    return {
      diff: { summary: 'Wrong event — nothing moved', changes: [], unchanged_pinned: [] },
      conflicts: [{ type: 'wrong_event', event_id: anchor.event_id, expected: args.expect_title, actual: anchor.title }],
    };
  }
  if (anchor.pinned) {
    return {
      diff: { summary: `${anchor.title} is pinned`, changes: [], unchanged_pinned: [] },
      conflicts: [{ type: 'pinned_moved', event_id: anchor.event_id, title: anchor.title }],
    };
  }

  // Resolve the recurring BASE event — the anchor id is either the base itself
  // or a moved-override row pointing back at it.
  let baseId = args.event_id!;
  let base = db.select().from(schema.event).where(eq(schema.event.id, baseId)).get();
  if (!base || base.rrule === null) {
    const exc = db
      .select()
      .from(schema.eventException)
      .where(and(eq(schema.eventException.override_event_id, baseId), eq(schema.eventException.status, 'moved')))
      .get();
    if (exc) {
      baseId = exc.event_id;
      base = db.select().from(schema.event).where(eq(schema.event.id, baseId)).get();
    }
  }
  if (!base || base.rrule === null) {
    return {
      diff: { summary: 'Not a repeating event', changes: [], unchanged_pinned: [] },
      conflicts: [{ type: 'constraint', rule: 'not_recurring', message: `${anchor.title} doesn't repeat — a single move already sticks.` }],
    };
  }

  const dur = durationMinutes(base.starts_at, base.ends_at);
  const anchorNewStart = addMinutesWall(anchor.starts_at, args.delta_minutes);
  const anchorNewEnd = addMinutesWall(anchor.ends_at, args.delta_minutes);
  // A drag can cross days (Tue → Wed is +1440), and for a series that means the
  // PATTERN moves: the base anchor date shifts by the same day count and every
  // BYDAY weekday rotates with it. Taking only timeOf() here was the bug where
  // a cross-day drag retimed the series but snapped it back to its old weekday.
  const dayDelta = Math.round(
    durationMinutes(composeTs(args.date, '00:00'), composeTs(dateOf(anchorNewStart), '00:00')) / (24 * 60),
  );
  const newBaseStart = composeTs(addDaysWall(dateOf(base.starts_at), dayDelta), timeOf(anchorNewStart));
  const newBaseEnd = addMinutesWall(newBaseStart, dur);
  const newRRule = rotateBydayInRrule(base.rrule, dayDelta);

  // Validate the anchor day — a class collision there refuses the whole move.
  const change: EventChange = {
    event_id: anchor.event_id,
    instance_date: args.date,
    title: anchor.title,
    kind: anchor.kind,
    pinned: false,
    location: anchor.location,
    before: { starts_at: anchor.starts_at, ends_at: anchor.ends_at },
    after: { starts_at: anchorNewStart, ends_at: anchorNewEnd },
  };
  const outcome = buildValidation(db, [change]);
  const conflicts = outcome.conflicts;

  const diff = {
    summary: `Move all ${anchor.title} · ${fmtDeltaMin(args.delta_minutes)}`,
    detail:
      dayDelta !== 0
        ? `every occurrence → ${fmtDateLong(dateOf(anchorNewStart), 'EEEE')} ${fmt12(anchorNewStart)} — sticks across weeks`
        : `every occurrence → ${fmt12(anchorNewStart)} — sticks across weeks`,
    changes: [change],
    unchanged_pinned: outcome.unchanged_pinned,
  };
  if (mode === 'dry') return { diff, conflicts };
  if (conflicts.some((c) => severityOf(c) === 'blocking')) return { diff, conflicts };

  db.transaction((tx) => {
    tx.update(schema.event)
      .set({ starts_at: newBaseStart, ends_at: newBaseEnd, rrule: newRRule })
      .where(eq(schema.event.id, baseId))
      .run();
    // Clear the series' MOVED overrides so every occurrence follows the new base
    // time (cancellations stay cancelled).
    const excs = tx
      .select()
      .from(schema.eventException)
      .where(and(eq(schema.eventException.event_id, baseId), eq(schema.eventException.status, 'moved')))
      .all();
    for (const x of excs) {
      if (x.override_event_id) tx.delete(schema.event).where(eq(schema.event.id, x.override_event_id)).run();
      tx.delete(schema.eventException).where(eq(schema.eventException.id, x.id)).run();
    }
  });
  return { diff, conflicts };
}

async function run(args: ShiftEventsArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();
  if (args.scope === 'series') return runSeries(db, args, mode);
  const windowEnd = args.scope === 'range' ? (args.end_date ?? args.date) : args.date;
  const instances = getInstances(db, args.date, windowEnd);
  const targets = selectTargets(args, instances);

  // Is this the event that was actually named? The model picks the id out of a
  // table and can pick the wrong row — asked for "tomorrow's gym" on a day with
  // no gym, it once grabbed the cook session and the move was applied. So it
  // must also say WHICH event it believes it is moving, and we refuse if the id
  // it chose is something else.
  if (args.scope === 'single' && args.expect_title !== undefined && targets.length === 1) {
    const t = targets[0]!;
    if (!titlesMatch(args.expect_title, t.title)) {
      return {
        diff: { summary: 'Wrong event — nothing moved', changes: [], unchanged_pinned: [] },
        conflicts: [
          { type: 'wrong_event', event_id: t.event_id, expected: args.expect_title, actual: t.title },
        ],
      };
    }
  }

  if (targets.length === 0) {
    // Nothing matched. In commit mode a vanished 'single' target is stale —
    // surface it and write nothing (the API layer treats this as needs-review).
    const stale =
      mode === 'commit' && args.scope === 'single'
        ? [{ type: 'constraint' as const, rule: 'stale', message: `Event ${args.event_id} has no instance on ${args.date} anymore — nothing was changed` }]
        : [];
    return {
      diff: { summary: 'Nothing to shift', changes: [], unchanged_pinned: [] },
      conflicts: stale,
    };
  }

  const changes: EventChange[] = targets.map((t) => ({
    event_id: t.event_id,
    instance_date: t.instance_date,
    title: t.title,
    kind: t.kind,
    pinned: t.pinned,
    before: { starts_at: t.starts_at, ends_at: t.ends_at },
    after: {
      starts_at: addMinutesWall(t.starts_at, args.delta_minutes),
      ends_at: addMinutesWall(t.ends_at, args.delta_minutes),
    },
  }));

  // Move the schedule around it, don't drop it on top of things. Landing on a
  // class is refused; movable events in the way are pushed later, and those
  // pushes are real changes in the diff.
  const room = makeRoom(db, changes);
  const allChanges = room.changes;

  const outcome = buildValidation(db, allChanges);
  const conflicts = [...room.conflicts, ...outcome.conflicts];

  const pushed = room.knockOns.length;
  const diff = {
    summary: summaryFor(args, targets[0]?.title ?? null),
    detail:
      args.after_time !== undefined
        ? `Everything after ${fmt12(args.after_time)}, ${fmtDeltaHuman(args.delta_minutes)}`
        : pushed > 0
          ? `${pushed} other event${pushed === 1 ? '' : 's'} moved to make room`
          : undefined,
    changes: allChanges,
    unchanged_pinned: outcome.unchanged_pinned,
  };

  if (mode === 'dry') return { diff, conflicts };

  if (conflicts.some((c) => severityOf(c) === 'blocking')) {
    return { diff, conflicts };
  }

  const sem = getSemester(db);
  db.transaction((tx) => {
    for (const t of targets) {
      const after = {
        starts_at: addMinutesWall(t.starts_at, args.delta_minutes),
        ends_at: addMinutesWall(t.ends_at, args.delta_minutes),
      };
      if (t.recurring) {
        // Move ONE instance of a recurring event: exception + standalone
        // override row at the new times.
        const base = tx.select().from(schema.event).where(eq(schema.event.id, t.event_id)).get();
        if (!base || !sem) continue;
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
            // Carry the cosmetic + derived fields too, or a shifted recurring gym
            // loses its workout label and colour (set_event_time copies both).
            color: base.color,
            workout: base.workout,
          })
          .run();
        tx.insert(schema.eventException)
          .values({
            id: newId('exc'),
            event_id: t.event_id,
            original_date: t.instance_date,
            status: 'moved',
            override_event_id: overrideId,
          })
          .run();
      } else {
        tx.update(schema.event)
          .set({ starts_at: after.starts_at, ends_at: after.ends_at })
          .where(eq(schema.event.id, t.event_id))
          .run();
      }
    }
    // …and everything that had to move for it, in the SAME transaction: the
    // move and the room it needed land together or not at all.
    if (sem) commitKnockOns(tx as never, sem.id, room.knockOns);
  });

  return { diff, conflicts };
}

export const shiftEventsTool: MutationToolDef<ShiftEventsArgs> = {
  name: 'shift_events',
  description:
    'Shift calendar events by a number of minutes: a whole day, a date range, or a single event instance. ' +
    'Emit delta_minutes only — never a timestamp. Pinned events (classes, exams) are never moved; they are ' +
    'shown untouched in the diff. If the new time collides with something movable, THE SCHEDULE MAKES ROOM: ' +
    'whatever is in the way is pushed later automatically and shown in the diff. If it would land on a class, ' +
    'the move is refused — so you never need to check for collisions yourself. Optional filters: kinds and ' +
    'after_time (only instances starting at/after HH:mm).',
  parameters: z.toJSONSchema(argsSchema) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
