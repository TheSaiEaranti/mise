/**
 * cancel_event — remove one event (or one instance of a recurring event)
 * from the calendar. (SPEC §4)
 *
 * A cancel aimed at a pinned event is NOT silently skipped: the change is
 * built anyway so the validator emits a blocking pinned_moved and the user
 * sees exactly what was refused (I4).
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Conflict, EventChange, MutationToolDef, ToolMode, ToolResult } from '../types';
import { severityOf, titlesMatch } from '../types';
import { getDb, schema } from '../db/client';
import { getInstances } from '../schedule';
import { buildValidation, newId } from '../proposals';
import { dateOf, fmtDateLong, DATE_RE } from '../time';

const argsSchema = z.object({
  event_id: z.string().describe('Id of the event to cancel.'),
  expect_title: z
    .string()
    .describe(
      'REQUIRED: the TITLE of that event_id, copied exactly from the schedule table. Checked against the real ' +
        'event — if the id you picked is a different event, the cancel is refused. Cancelling the wrong thing is ' +
        "not recoverable, so if what Sai named isn't in the table on that date, say so instead of guessing.",
    ),
  date: z
    .string()
    .regex(DATE_RE)
    .optional()
    .describe('YYYY-MM-DD of the instance to cancel. Required when the event is recurring — says which occurrence.'),
  reason: z.string().optional().describe('Optional short reason, shown in the diff card.'),
});

export type CancelEventArgs = z.infer<typeof argsSchema>;

function noTarget(conflicts: Conflict[]): ToolResult {
  return { diff: { summary: 'Nothing to cancel', changes: [], unchanged_pinned: [] }, conflicts };
}

async function run(args: CancelEventArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();
  const row = db.select().from(schema.event).where(eq(schema.event.id, args.event_id)).get();
  if (!row) {
    return noTarget([
      { type: 'constraint', rule: 'stale', message: `Event ${args.event_id} no longer exists — nothing was changed` },
    ]);
  }

  // The id must be the event that was named. See the wrong_event conflict in
  // types.ts — this is the check that stops "cancel the gym" deleting a cook
  // session because the model copied the wrong row out of the table.
  if (!titlesMatch(args.expect_title, row.title)) {
    return {
      diff: { summary: 'Wrong event — nothing cancelled', changes: [], unchanged_pinned: [] },
      conflicts: [
        { type: 'wrong_event', event_id: row.id, expected: args.expect_title, actual: row.title },
      ],
    };
  }

  const recurring = row.rrule !== null;
  let instance: { starts_at: string; ends_at: string; instance_date: string };

  if (recurring) {
    if (args.date === undefined) {
      return noTarget([
        {
          type: 'constraint',
          rule: 'missing_date',
          message: `${row.title} repeats — specify which date's occurrence to cancel`,
        },
      ]);
    }
    const inst = getInstances(db, args.date, args.date).find(
      (i) => i.event_id === args.event_id && i.instance_date === args.date,
    );
    if (!inst) {
      return noTarget([
        {
          type: 'constraint',
          rule: 'stale',
          message: `${row.title} has no instance on ${args.date} anymore — nothing was changed`,
        },
      ]);
    }
    instance = { starts_at: inst.starts_at, ends_at: inst.ends_at, instance_date: inst.instance_date };
  } else {
    instance = { starts_at: row.starts_at, ends_at: row.ends_at, instance_date: dateOf(row.starts_at) };
  }

  // Built even when pinned — the validator must emit pinned_moved so the
  // refusal is visible, not silent (I4).
  const changes: EventChange[] = [
    {
      event_id: row.id,
      instance_date: instance.instance_date,
      title: row.title,
      kind: row.kind,
      pinned: row.pinned,
      // Carried so an undo can recreate a cancelled one-off with its location
      // intact (see undo.ts).
      location: row.location,
      before: { starts_at: instance.starts_at, ends_at: instance.ends_at },
      after: null,
    },
  ];

  const outcome = buildValidation(db, changes);
  const diff = {
    summary: `Cancel ${row.title} · ${fmtDateLong(instance.instance_date, 'EEE MMM d')}`,
    detail: args.reason,
    changes,
    unchanged_pinned: outcome.unchanged_pinned,
  };

  if (mode === 'dry') return { diff, conflicts: outcome.conflicts };

  if (outcome.conflicts.some((c) => severityOf(c) === 'blocking')) {
    return { diff, conflicts: outcome.conflicts };
  }

  db.transaction((tx) => {
    if (recurring) {
      // Cancel ONE instance: exception row; the expander drops the occurrence.
      tx.insert(schema.eventException)
        .values({
          id: newId('exc'),
          event_id: row.id,
          original_date: instance.instance_date,
          status: 'cancelled',
          override_event_id: null,
        })
        .run();
    } else {
      // Standalone: delete the row. The proposal row is the audit trail.
      tx.delete(schema.event).where(eq(schema.event.id, row.id)).run();
    }
  });

  return { diff, conflicts: outcome.conflicts };
}

export const cancelEventTool: MutationToolDef<CancelEventArgs> = {
  name: 'cancel_event',
  description:
    'Cancel an event. For a recurring event, pass date (YYYY-MM-DD) to cancel just that occurrence. ' +
    'Pinned events (classes, exams) cannot be cancelled — the proposal will be blocked.',
  parameters: z.toJSONSchema(argsSchema) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
