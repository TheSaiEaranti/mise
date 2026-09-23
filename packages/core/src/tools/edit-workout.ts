/**
 * edit_workout — change the gym SPLIT itself: add a day, rename one, drop one,
 * or set/remove a lift and its load. This is the thing that used to require a
 * developer editing config/workouts.ts; now Sai can just say "add a legs day"
 * or "bump my bench to 125x8".
 *
 * It writes what he says, VERBATIM. Loads are strings — "400*10*8" goes in
 * exactly as typed; the tool never parses a load into numbers or "fixes" one.
 * The whole split before the edit is snapshotted into the diff so Cmd-Z puts it
 * back in one step (see undo.ts).
 *
 * This is the SPLIT (what a gym session contains), NOT the schedule (when gym
 * happens). Moving/resizing gym blocks is shift_events / set_event_time.
 */
import { z } from 'zod';
import type { Conflict, MutationToolDef, ToolMode, ToolResult } from '../types';
import { getDb } from '../db/client';
import { getSplit, writeSplit, findDay, slugify, type WorkoutSplit } from '../workouts';

const exerciseSchema = z.object({
  name: z.string().min(1).describe('Lift name, in Sai\'s words, e.g. "Leg press".'),
  load: z
    .string()
    .min(1)
    .describe('Load exactly as Sai says it — weight*reps*sets ("400*10*8") or weight*reps ("90*12"). A string; never parse or change it.'),
});

const argsSchema = z
  .object({
    action: z
      .enum(['add_day', 'rename_day', 'remove_day', 'set_exercise', 'remove_exercise'])
      .describe('What to do to the split.'),
    day: z
      .string()
      .min(1)
      .describe('The workout day. For add_day this is the NEW day\'s name ("Legs"); for everything else it names an EXISTING day ("Legs" or "Chest and back").'),
    new_name: z.string().min(1).optional().describe('Required for rename_day: the new name for the day.'),
    exercises: z.array(exerciseSchema).optional().describe('For add_day: the day\'s lifts. Optional — a day can start empty and get lifts added later.'),
    exercise: z.string().min(1).optional().describe('For set_exercise / remove_exercise: the lift name.'),
    load: z.string().min(1).optional().describe('For set_exercise: the load, exactly as Sai says it. Verbatim string.'),
  })
  .superRefine((v, ctx) => {
    if (v.action === 'rename_day' && v.new_name === undefined)
      ctx.addIssue({ code: 'custom', path: ['new_name'], message: 'new_name is required for rename_day' });
    if (v.action === 'set_exercise' && (v.exercise === undefined || v.load === undefined))
      ctx.addIssue({ code: 'custom', path: ['exercise'], message: 'set_exercise needs exercise and load' });
    if (v.action === 'remove_exercise' && v.exercise === undefined)
      ctx.addIssue({ code: 'custom', path: ['exercise'], message: 'remove_exercise needs exercise' });
  });

export type EditWorkoutArgs = z.infer<typeof argsSchema>;

const clone = (s: WorkoutSplit): WorkoutSplit => JSON.parse(JSON.stringify(s)) as WorkoutSplit;

function uniqueKey(split: WorkoutSplit, base: string): string {
  let key = base;
  let n = 2;
  while (split.days.some((d) => d.key === key)) key = `${base}-${n++}`;
  return key;
}

function refuse(rule: string, message: string): ToolResult {
  return { diff: { summary: 'No change to the split', changes: [], unchanged_pinned: [] }, conflicts: [{ type: 'constraint', rule, message }] };
}

async function run(args: EditWorkoutArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();
  const before = getSplit(db);
  const after = clone(before);
  let summary: string;

  switch (args.action) {
    case 'add_day': {
      if (findDay(after, args.day)) return refuse('duplicate_day', `You already have a ${args.day} day.`);
      const exercises = (args.exercises ?? []).map((e) => ({ name: e.name, load: e.load }));
      after.days.push({ key: uniqueKey(after, slugify(args.day)), name: args.day, exercises });
      summary =
        exercises.length > 0
          ? `Add ${args.day} — ${exercises.map((e) => `${e.name} ${e.load}`).join(', ')}`
          : `Add ${args.day}`;
      break;
    }
    case 'rename_day': {
      const d = findDay(after, args.day);
      if (!d) return refuse('no_such_day', `There's no ${args.day} day in your split.`);
      const clash = after.days.find(
        (x) => x !== d && (x.name.toLowerCase() === args.new_name!.toLowerCase() || x.key === slugify(args.new_name!)),
      );
      if (clash) return refuse('duplicate_day', `You already have a ${clash.name} day — pick a different name.`);
      const old = d.name;
      d.name = args.new_name!;
      summary = `Rename ${old} → ${args.new_name}`;
      break;
    }
    case 'remove_day': {
      const idx = after.days.findIndex((d) => findDay({ days: [d] }, args.day));
      if (idx < 0) return refuse('no_such_day', `There's no ${args.day} day in your split.`);
      const [removed] = after.days.splice(idx, 1);
      summary = `Remove ${removed!.name}`;
      break;
    }
    case 'set_exercise': {
      const d = findDay(after, args.day);
      if (!d) return refuse('no_such_day', `There's no ${args.day} day in your split.`);
      const existing = d.exercises.find((e) => e.name.toLowerCase() === args.exercise!.toLowerCase());
      if (existing) {
        const oldLoad = existing.load;
        existing.load = args.load!;
        summary =
          oldLoad === args.load
            ? `${d.name} → ${existing.name} ${args.load}`
            : `${d.name} → ${existing.name} ${oldLoad} → ${args.load}`;
      } else {
        d.exercises.push({ name: args.exercise!, load: args.load! });
        summary = `${d.name} → add ${args.exercise} ${args.load}`;
      }
      break;
    }
    case 'remove_exercise': {
      const d = findDay(after, args.day);
      if (!d) return refuse('no_such_day', `There's no ${args.day} day in your split.`);
      const i = d.exercises.findIndex((e) => e.name.toLowerCase() === args.exercise!.toLowerCase());
      if (i < 0) return refuse('no_such_exercise', `${d.name} doesn't have ${args.exercise}.`);
      const [rem] = d.exercises.splice(i, 1);
      summary = `${d.name} → remove ${rem!.name}`;
      break;
    }
  }

  // A no-op is not a change. "Set bench to 125*8" when it's already 125*8, or a
  // rename to the same name, leaves the split identical — say so rather than
  // logging a change that didn't happen (mirrors isRealChange for events).
  if (JSON.stringify(after) === JSON.stringify(before)) {
    return refuse('already', "That's already how your split is set up — nothing changed.");
  }

  const conflicts: Conflict[] = [];
  const diff = {
    summary,
    changes: [],
    unchanged_pinned: [],
    workout_changes: [summary],
    // before → what Cmd-Z restores; after → the staleness fingerprint undo uses
    // to refuse an out-of-order undo that would clobber a newer edit.
    workout_before: before,
    workout_after: after,
  };

  if (mode === 'dry') return { diff, conflicts };
  writeSplit(db, after);
  return { diff, conflicts };
}

export const editWorkoutTool: MutationToolDef<EditWorkoutArgs> = {
  name: 'edit_workout',
  description:
    "Edit Sai's gym SPLIT (what a gym session contains), not the schedule. Add a workout day (add_day, with " +
    'optional exercises), rename one (rename_day + new_name), remove one (remove_day), or set/remove a lift and its ' +
    'load (set_exercise with exercise+load, remove_exercise). Loads are written EXACTLY as Sai says them — a string ' +
    'like "400*10*8", never parsed or changed. Use this for "add a legs day", "put leg press 400x10x8 on legs", ' +
    '"bump my bench to 125x8", "take rope pushdowns off arms". Not for moving gym blocks — that is shift_events.',
  parameters: z.toJSONSchema(argsSchema) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
