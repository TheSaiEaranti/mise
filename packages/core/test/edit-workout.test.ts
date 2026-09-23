/**
 * edit_workout — the assistant can now change the gym split from chat: add a
 * day, set/remove lifts and loads, rename, remove. Loads are written verbatim,
 * and every edit undoes to the snapshot taken before it.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { editWorkoutTool } from '../src/tools/edit-workout';
import { getSplit, workoutFor } from '../src/workouts';
import { createProposal, type ProposalRow } from '../src/proposals';
import { undoProposal, isUndoable } from '../src/undo';
import { isActionable } from '../src/types';

process.env.MISE_SETTINGS_PATH = '/nonexistent/settings.json';

let db: DB;
beforeEach(() => {
  db = resetDbForTests();
});

const edit = (args: Record<string, unknown>, mode: 'dry' | 'commit' = 'commit') =>
  editWorkoutTool.run(args as never, mode);

describe('the split seeds from the default and is readable', () => {
  test('getSplit returns the default 3-day split; workoutFor resolves legs', () => {
    const split = getSplit(db);
    expect(split.days.map((d) => d.key)).toEqual(['chest-back', 'shoulders-arms', 'legs']);
    expect(workoutFor(db, 'legs')?.name).toBe('Legs');
    expect(workoutFor(db, 'nope')).toBeNull();
  });
});

describe('adding a day and lifts', () => {
  test('add a Push day with lifts, verbatim loads', async () => {
    const { diff, conflicts } = await edit({
      action: 'add_day',
      day: 'Push',
      exercises: [{ name: 'Ohp', load: '95*8*5' }, { name: 'Dips', load: 'bodyweight*12' }],
    });
    expect(conflicts).toEqual([]);
    expect(isActionable(diff)).toBe(true);
    expect(diff.workout_changes?.[0]).toContain('Add Push');

    const push = workoutFor(db, 'push');
    expect(push?.name).toBe('Push');
    expect(push?.exercises).toEqual([{ name: 'Ohp', load: '95*8*5' }, { name: 'Dips', load: 'bodyweight*12' }]);
  });

  test('adding a day that already exists is refused', async () => {
    const { conflicts } = await edit({ action: 'add_day', day: 'Legs' });
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'duplicate_day')).toBe(true);
    // Still just the 3 default days.
    expect(getSplit(db).days).toHaveLength(3);
  });
});

describe('setting and removing lifts', () => {
  test('set_exercise updates an existing load verbatim', async () => {
    await edit({ action: 'set_exercise', day: 'Chest and back', exercise: 'Bench press', load: '125*8*6' });
    const bench = workoutFor(db, 'chest-back')!.exercises.find((e) => e.name === 'Bench press');
    expect(bench?.load).toBe('125*8*6');
  });

  test('set_exercise adds a new lift when it is not there yet', async () => {
    await edit({ action: 'set_exercise', day: 'Legs', exercise: 'Bulgarian split squat', load: '50*10*8' });
    const legs = workoutFor(db, 'legs')!;
    expect(legs.exercises.find((e) => e.name === 'Bulgarian split squat')?.load).toBe('50*10*8');
  });

  test('remove_exercise drops it; a missing lift is refused', async () => {
    await edit({ action: 'remove_exercise', day: 'Legs', exercise: 'Leg press' });
    expect(workoutFor(db, 'legs')!.exercises.some((e) => e.name === 'Leg press')).toBe(false);

    const { conflicts } = await edit({ action: 'remove_exercise', day: 'Legs', exercise: 'Nonexistent' });
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'no_such_exercise')).toBe(true);
  });
});

describe('rename and remove a day', () => {
  test('rename by current name', async () => {
    await edit({ action: 'rename_day', day: 'Legs', new_name: 'Leg day' });
    expect(workoutFor(db, 'legs')?.name).toBe('Leg day');
  });

  test('remove a day', async () => {
    await edit({ action: 'remove_day', day: 'Legs' });
    expect(getSplit(db).days.map((d) => d.key)).toEqual(['chest-back', 'shoulders-arms']);
  });

  test('editing a day that does not exist is refused', async () => {
    const { conflicts } = await edit({ action: 'rename_day', day: 'Cardio', new_name: 'HIIT' });
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'no_such_day')).toBe(true);
  });
});

describe('a split edit is undoable (Cmd-Z)', () => {
  test('edit_workout is in the undoable set and auto-applies', () => {
    expect(isUndoable({ tool_name: 'edit_workout', status: 'approved' })).toBe(true);
  });

  test('undo restores the whole split as it was before the edit', async () => {
    const { diff } = await edit({ action: 'add_day', day: 'Cardio', exercises: [{ name: 'Row', load: '10*1000m' }] });
    expect(getSplit(db).days.some((d) => d.name === 'Cardio')).toBe(true);

    // Record it as an approved proposal, then undo it.
    const p = createProposal(db, { user_message: 'add cardio', tool_name: 'edit_workout', tool_args: {}, diff, conflicts: [] });
    db.update(schema.proposal).set({ status: 'approved' }).where(eq(schema.proposal.id, p.id)).run();
    const row = db.select().from(schema.proposal).where(eq(schema.proposal.id, p.id)).get()! as ProposalRow;

    const res = undoProposal(db, row);
    expect(res.ok).toBe(true);
    // Back to the default 3 days — Cardio is gone.
    expect(getSplit(db).days.map((d) => d.key)).toEqual(['chest-back', 'shoulders-arms', 'legs']);
  });

  test('undo of a load change puts the old load back', async () => {
    const { diff } = await edit({ action: 'set_exercise', day: 'Chest and back', exercise: 'Bench press', load: '999*1*1' });
    const p = createProposal(db, { user_message: 'bench', tool_name: 'edit_workout', tool_args: {}, diff, conflicts: [] });
    db.update(schema.proposal).set({ status: 'approved' }).where(eq(schema.proposal.id, p.id)).run();
    const row = db.select().from(schema.proposal).where(eq(schema.proposal.id, p.id)).get()! as ProposalRow;

    undoProposal(db, row);
    expect(workoutFor(db, 'chest-back')!.exercises.find((e) => e.name === 'Bench press')?.load).toBe('120*8*6');
  });

  test('undoing an OLDER split edit after a newer one is refused, not a clobber', async () => {
    const log = async (d: unknown) => {
      const p = createProposal(db, { user_message: 'x', tool_name: 'edit_workout', tool_args: {}, diff: d as never, conflicts: [] });
      db.update(schema.proposal).set({ status: 'approved' }).where(eq(schema.proposal.id, p.id)).run();
      return db.select().from(schema.proposal).where(eq(schema.proposal.id, p.id)).get()! as ProposalRow;
    };
    const a = await edit({ action: 'add_day', day: 'Push', exercises: [{ name: 'Ohp', load: '95*8' }] });
    const rowA = await log(a.diff);
    const b = await edit({ action: 'set_exercise', day: 'Chest and back', exercise: 'Bench press', load: '135*8' });
    await log(b.diff);

    // Undo the OLDER edit (add Push) while the newer edit (bench 135) is live.
    const res = undoProposal(db, rowA);
    expect(res.ok).toBe(false); // refused, not applied
    // Neither change was clobbered: Push still there, bench still 135.
    expect(getSplit(db).days.some((d) => d.name === 'Push')).toBe(true);
    expect(workoutFor(db, 'chest-back')!.exercises.find((e) => e.name === 'Bench press')?.load).toBe('135*8');
  });
});

describe('edge cases the review caught', () => {
  test('a no-op edit (same load) is refused, not reported as a change', async () => {
    const { diff, conflicts } = await edit({
      action: 'set_exercise', day: 'Chest and back', exercise: 'Bench press', load: '120*8*6', // already this
    });
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'already')).toBe(true);
    expect(isActionable(diff)).toBe(false);
  });

  test('a renamed day frees its old name — adding it fresh is not a false duplicate', async () => {
    await edit({ action: 'rename_day', day: 'Legs', new_name: 'Leg day' });
    const { conflicts } = await edit({ action: 'add_day', day: 'Legs', exercises: [{ name: 'Squat', load: '225*5' }] });
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'duplicate_day')).toBe(false);
    // Now two distinct days exist with different keys.
    const names = getSplit(db).days.map((d) => d.name);
    expect(names).toContain('Leg day');
    expect(names).toContain('Legs');
  });

  test('renaming a day onto another day’s name is refused', async () => {
    const { conflicts } = await edit({ action: 'rename_day', day: 'Legs', new_name: 'Chest and back' });
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'duplicate_day')).toBe(true);
  });
});
