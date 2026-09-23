/**
 * set_workout — change WHICH workout an existing gym session is: "Tuesday is
 * chest and back, not legs."
 *
 * This is the label ON a scheduled gym block, distinct from BOTH: edit_workout,
 * which changes the split's lifts and loads; and create_event's workout, which
 * labels a NEW block. There was no way to fix a session that was labelled with
 * the wrong split day — so the model, asked to, would cancel and re-add gym
 * (making duplicates) and never touch the label. This does exactly the one
 * thing: relabel the session. A recurring gym relabels every occurrence.
 *
 * Cosmetic — no time, no pin, nothing derived — so it just writes, and Cmd-Z
 * puts the old label back.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Conflict, MutationToolDef, ToolMode, ToolResult } from '../types';
import { titlesMatch } from '../types';
import { getDb, schema } from '../db/client';
import { getSplit, findDay } from '../workouts';

const argsSchema = z.object({
  event_id: z.string().describe('Id of the gym block to relabel, from the schedule table.'),
  expect_title: z.string().describe("REQUIRED: that block's TITLE, copied exactly. Checked against the real event."),
  workout: z
    .string()
    .describe("Which split day this session is, by name ('Chest and back', 'Legs') or key. Relabels the block."),
});

export type SetWorkoutArgs = z.infer<typeof argsSchema>;

function refuse(summary: string, conflicts: Conflict[]): ToolResult {
  return { diff: { summary, changes: [], unchanged_pinned: [] }, conflicts };
}

async function run(args: SetWorkoutArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();
  const row = db.select().from(schema.event).where(eq(schema.event.id, args.event_id)).get();
  if (!row) {
    return refuse('Nothing to relabel', [
      { type: 'constraint', rule: 'stale', message: `Event ${args.event_id} no longer exists.` },
    ]);
  }
  if (!titlesMatch(args.expect_title, row.title)) {
    return {
      diff: { summary: 'Wrong event — nothing changed', changes: [], unchanged_pinned: [] },
      conflicts: [{ type: 'wrong_event', event_id: row.id, expected: args.expect_title, actual: row.title }],
    };
  }
  if (row.kind !== 'gym') {
    return refuse('Not a gym session', [
      { type: 'constraint', rule: 'not_gym', message: `Only gym sessions have a workout — ${row.title} is a ${row.kind} block.` },
    ]);
  }

  const day = findDay(getSplit(db), args.workout);
  if (!day) {
    return refuse('No such workout', [
      { type: 'constraint', rule: 'no_workout', message: `There's no "${args.workout}" day in your split.` },
    ]);
  }
  if (row.workout === day.key) {
    return refuse('Already that workout', [
      { type: 'constraint', rule: 'already', message: `${row.title} is already ${day.name}.` },
    ]);
  }

  const summary = `${row.title} → ${day.name}`;
  const diff = {
    summary,
    changes: [],
    unchanged_pinned: [],
    workout_changes: [summary],
    workout_relabel: { event_id: row.id, before: row.workout, after: day.key },
  };

  if (mode === 'dry') return { diff, conflicts: [] };

  db.transaction((tx) => {
    tx.update(schema.event).set({ workout: day.key }).where(eq(schema.event.id, row.id)).run();
    // A recurring gym's moved occurrences copied the old workout onto override
    // rows — relabel those too, the same walk drop-class and rename use.
    if (row.rrule !== null) {
      const excs = tx.select().from(schema.eventException).where(eq(schema.eventException.event_id, row.id)).all();
      for (const x of excs) {
        if (x.override_event_id) tx.update(schema.event).set({ workout: day.key }).where(eq(schema.event.id, x.override_event_id)).run();
      }
    }
  });

  return { diff, conflicts: [] };
}

export const setWorkoutTool: MutationToolDef<SetWorkoutArgs> = {
  name: 'set_workout',
  description:
    "Change which workout an existing GYM session is labelled with — \"Tuesday's gym is chest and back, not legs\". " +
    'Pass event_id + expect_title of the gym block and workout = the split day name. It relabels the block (and, for a ' +
    'recurring gym, every occurrence); it does NOT edit the split definition (that is edit_workout) and does NOT move ' +
    'anything. Only for gym blocks.',
  parameters: z.toJSONSchema(argsSchema) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
