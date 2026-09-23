/**
 * drop_class — remove a class from the schedule for good: the whole weekly
 * series, every meeting, through the end of the semester.
 *
 * This is the one sanctioned way to delete a PINNED event. Everything else in
 * the app treats a class as an anchor that cannot be touched — cancel_event
 * refuses it, the model can't move it — because a class is the fixed thing the
 * rest of the day is arranged around, and nothing automatic should be able to
 * make one disappear. Dropping a course you're no longer taking is a real,
 * deliberate act, so it gets its own tool, and like setup_semester and
 * add_classes that tool is HIDDEN FROM THE MODEL (I4): it is reachable only
 * from a click on the class itself, never from chat and never from anything the
 * model decides. A misread request or an injected instruction cannot drop your
 * courses; only you, on that specific block, can.
 *
 * It is not auto-applied and not undoable — removing a course is not a small
 * change. The click confirms; after that it's gone, and the proposal row is the
 * record that it happened.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Conflict, EventChange, MutationToolDef, ToolMode, ToolResult } from '../types';
import { titlesMatch } from '../types';
import { getDb, schema } from '../db/client';
import { dateOf, fmtDateLong } from '../time';

const argsSchema = z.object({
  event_id: z.string().describe('Id of the class to drop.'),
  expect_title: z
    .string()
    .describe(
      'REQUIRED: the TITLE of that event_id, copied exactly from the schedule. Checked against the real ' +
        'event — if the id points at something else, the drop is refused. Removing the wrong course is not recoverable.',
    ),
});

export type DropClassArgs = z.infer<typeof argsSchema>;

function refuse(summary: string, conflicts: Conflict[]): ToolResult {
  return { diff: { summary, changes: [], unchanged_pinned: [] }, conflicts };
}

const DAY_NAMES: Record<string, string> = {
  MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun',
};

/** "Tue/Thu, through Dec 15" — the pattern being removed, from the rrule. */
function describeSeries(rrule: string | null): string | undefined {
  if (!rrule) return undefined;
  const byday = /BYDAY=([^;]+)/.exec(rrule)?.[1];
  const until = /UNTIL=(\d{4})(\d{2})(\d{2})/.exec(rrule);
  const days = byday
    ? byday.split(',').map((d) => DAY_NAMES[d] ?? d).join('/')
    : undefined;
  const through = until ? `through ${fmtDateLong(`${until[1]}-${until[2]}-${until[3]}`, 'MMM d')}` : undefined;
  return [days, through].filter(Boolean).join(', ') || undefined;
}

async function run(args: DropClassArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();
  const row = db.select().from(schema.event).where(eq(schema.event.id, args.event_id)).get();

  if (!row) {
    return refuse('Nothing to drop', [
      { type: 'constraint', rule: 'stale', message: `That class is no longer on your schedule — nothing was changed.` },
    ]);
  }

  // The id must be the class that was named. Same guard as cancel_event: the one
  // thing worse than not dropping the class is dropping a different one.
  if (!titlesMatch(args.expect_title, row.title)) {
    return {
      diff: { summary: 'Wrong event — nothing dropped', changes: [], unchanged_pinned: [] },
      conflicts: [{ type: 'wrong_event', event_id: row.id, expected: args.expect_title, actual: row.title }],
    };
  }

  // This tool is for CLASSES. A one-off event, a gym block, a cook session — all
  // of those come out with cancel_event, which is undoable and warns about the
  // lunches a cook session was feeding. drop_class is the pinned-class exception
  // and nothing else; refuse anything that isn't one rather than quietly become
  // a second, unguarded delete.
  if (row.kind !== 'class') {
    return refuse('Not a class', [
      {
        type: 'constraint',
        rule: 'not_a_class',
        message: `${row.title} isn't a class — cancel it from chat instead. Dropping is only for classes you've stopped taking.`,
      },
    ]);
  }

  // The representative row for the card: the first meeting of the series, struck
  // through. The detail line says it's the whole series, so one row is honest —
  // dumping every weekly occurrence would bury that.
  const change: EventChange = {
    event_id: row.id,
    instance_date: dateOf(row.starts_at),
    title: row.title,
    kind: row.kind,
    pinned: true,
    location: row.location,
    before: { starts_at: row.starts_at, ends_at: row.ends_at },
    after: null,
  };

  const series = describeSeries(row.rrule);
  const diff = {
    summary: `Drop ${row.title}`,
    detail: series ? `Removes every meeting — ${series}` : 'Removes it from your schedule for good',
    changes: [change],
    unchanged_pinned: [],
  };

  // A removal can't collide with anything, so there are no conflicts to compute
  // and dry === commit. That also means the approve-time re-check sees an
  // identical diff and never spuriously bounces it to needs_review.
  if (mode === 'dry') return { diff, conflicts: [] };

  db.transaction((tx) => {
    // Any single-instance edits made to this class over the semester: a skipped
    // lecture (cancelled exception) or a moved one (which spawned a standalone
    // override row). Clear the exceptions, and delete the override rows they
    // point at, so nothing is orphaned behind the class that's leaving.
    const exceptions = tx
      .select()
      .from(schema.eventException)
      .where(eq(schema.eventException.event_id, row.id))
      .all();
    for (const exc of exceptions) {
      if (exc.override_event_id) {
        tx.delete(schema.event).where(eq(schema.event.id, exc.override_event_id)).run();
      }
      tx.delete(schema.eventException).where(eq(schema.eventException.id, exc.id)).run();
    }
    tx.delete(schema.event).where(eq(schema.event.id, row.id)).run();
  });

  return { diff, conflicts: [] };
}

export const dropClassTool: MutationToolDef<DropClassArgs> = {
  name: 'drop_class',
  description:
    'Remove a class you no longer take — the whole weekly series, through the end of the semester. ' +
    'User-initiated only (a click on the class); not available to the chat model.',
  parameters: z.toJSONSchema(argsSchema) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
