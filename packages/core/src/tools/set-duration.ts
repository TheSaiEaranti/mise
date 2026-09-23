/**
 * set_duration — "make all breakfasts 30 minutes."
 *
 * Length lives on the event ROW (start→end), and a recurring block is one row
 * with many occurrences, so there was no way to change how long a whole series
 * is — resize (set_event_time) only touches one instance, and the model, asked
 * "make all breakfasts 30 min", eyeballs one and says "already 30" while the rest
 * are 60. This sets the length of EVERY same-titled block — both recurring series
 * and any moved one-off overrides — in one call, keeping each block's start and
 * trimming/extending its end.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Conflict, EventChange, MutationToolDef, ToolMode, ToolResult } from '../types';
import { severityOf, titlesMatch } from '../types';
import { getDb, schema } from '../db/client';
import { getInstances, getSemester } from '../schedule';
import { buildValidation } from '../proposals';
import { addDaysWall, addMinutesWall, durationMinutes, todayInTz } from '../time';

const argsSchema = z.object({
  event_id: z.string().describe('Id of ANY one block of the thing to resize, from the schedule table.'),
  expect_title: z.string().describe("REQUIRED: that block's TITLE, copied exactly. Checked against the real event."),
  duration_minutes: z.number().int().min(5).max(480).describe('New length in minutes for EVERY block with this title (start stays; end moves).'),
});

export type SetDurationArgs = z.infer<typeof argsSchema>;

function refuse(summary: string, conflicts: Conflict[]): ToolResult {
  return { diff: { summary, changes: [], unchanged_pinned: [] }, conflicts };
}

async function run(args: SetDurationArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();
  const sem = getSemester(db);
  if (!sem) return refuse('No semester', [{ type: 'constraint', rule: 'no_semester', message: 'Set up a semester first.' }]);

  const row = db.select().from(schema.event).where(eq(schema.event.id, args.event_id)).get();
  if (!row) {
    return refuse('Nothing to resize', [
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

  // Every row that carries this title — recurring series bases AND moved
  // one-off overrides — is what "all of them" means.
  const rows = db.select().from(schema.event).all().filter((e) => titlesMatch(row.title, e.title) && !e.pinned);
  const toUpdate = rows.filter((e) => durationMinutes(e.starts_at, e.ends_at) !== args.duration_minutes);
  if (toUpdate.length === 0) {
    return refuse(`${row.title} already ${args.duration_minutes} min`, [
      { type: 'constraint', rule: 'already', message: `Every ${row.title} is already ${args.duration_minutes} minutes.` },
    ]);
  }

  // Diff from the RENDERED near-term instances that change length, so the card
  // shows real days; the commit sets the length on every row (all weeks).
  const anchor = todayInTz(sem.timezone) < sem.start_date ? sem.start_date : todayInTz(sem.timezone);
  const insts = getInstances(db, anchor, addDaysWall(anchor, 14)).filter(
    (i) => titlesMatch(row.title, i.title) && !i.pinned && durationMinutes(i.starts_at, i.ends_at) !== args.duration_minutes,
  );
  const changes: EventChange[] = insts.map((i) => ({
    event_id: i.event_id,
    instance_date: i.instance_date,
    title: i.title,
    kind: i.kind,
    pinned: false,
    location: i.location,
    before: { starts_at: i.starts_at, ends_at: i.ends_at },
    after: { starts_at: i.starts_at, ends_at: addMinutesWall(i.starts_at, args.duration_minutes) },
  }));
  const outcome = buildValidation(db, changes);

  const diff = {
    summary: `${row.title} → ${args.duration_minutes} min`,
    detail: `every ${row.title} set to ${args.duration_minutes} minutes`,
    changes,
    unchanged_pinned: outcome.unchanged_pinned,
  };
  if (mode === 'dry') return { diff, conflicts: outcome.conflicts };
  if (outcome.conflicts.some((c) => severityOf(c) === 'blocking')) return { diff, conflicts: outcome.conflicts };

  db.transaction((tx) => {
    for (const e of toUpdate) {
      tx.update(schema.event).set({ ends_at: addMinutesWall(e.starts_at, args.duration_minutes) }).where(eq(schema.event.id, e.id)).run();
    }
  });
  return { diff, conflicts: outcome.conflicts };
}

export const setDurationTool: MutationToolDef<SetDurationArgs> = {
  name: 'set_duration',
  description:
    'Set how LONG every block with a given title is — "make all breakfasts 30 minutes", "make my study blocks an hour". ' +
    'It changes the length of EVERY same-titled block at once (each recurring series and any moved one-off), keeping each ' +
    "block's start time and moving its end. Use this for \"make all X N minutes\"; never say they're already that length " +
    'without checking — the tool checks every one. Pass event_id + expect_title of any one block + duration_minutes.',
  parameters: z.toJSONSchema(argsSchema) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
