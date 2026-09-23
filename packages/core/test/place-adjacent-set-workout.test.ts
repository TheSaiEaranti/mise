/**
 * The two fixes for the "totally wrong" gym turn: place_adjacent ("gym right
 * after cooking, no break") and set_workout ("Tuesday is chest and back, not
 * legs") — neither of which the model could do before, so it cancelled,
 * duplicated, and ignored the label.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { placeAdjacentTool } from '../src/tools/place-adjacent';
import { setWorkoutTool } from '../src/tools/set-workout';
import { createProposal, type ProposalRow } from '../src/proposals';
import { undoProposal, isUndoable } from '../src/undo';
import { getInstances } from '../src/schedule';
import { severityOf } from '../src/types';

process.env.MISE_SETTINGS_PATH = '/nonexistent/settings.json';

let db: DB;

// Mon 2026-09-07: cook 5:30–6:30, gym 8–9:30 (a big gap between them).
beforeEach(() => {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'Fall', start_date: '2026-09-01', end_date: '2026-12-15', timezone: 'America/Chicago' })
    .run();
  db.insert(schema.event)
    .values([
      {
        id: 'cook', semester_id: 's1', title: 'Cook lunches', kind: 'cook',
        starts_at: '2026-09-07T17:30', ends_at: '2026-09-07T18:30',
        pinned: false, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: null,
      },
      {
        id: 'gym', semester_id: 's1', title: 'Gym', kind: 'gym',
        starts_at: '2026-09-07T20:00', ends_at: '2026-09-07T21:30',
        pinned: false, rrule: null, source: 'manual', location: 'Gregory', notes: null, color: null, workout: 'legs',
      },
    ])
    .run();
});

const on = () =>
  getInstances(db, '2026-09-07', '2026-09-07').map((i) => `${i.starts_at.slice(11)}-${i.ends_at.slice(11)} ${i.title}`);

describe('place_adjacent — gym immediately after cooking', () => {
  test('gym moves to touch the end of cook, keeping its 90-min length', async () => {
    const { conflicts } = await placeAdjacentTool.run(
      { event_id: 'gym', expect_title: 'Gym', date: '2026-09-07', anchor_title: 'Cook lunches', position: 'after', gap_minutes: 0 } as never,
      'commit',
    );
    expect(conflicts.filter((c) => c.type === 'double_booked' || c.type === 'pinned_moved')).toEqual([]);
    // Cook ends 18:30 → gym is now 18:30–20:00 (still 90 min), right after it.
    expect(on()).toEqual(['17:30-18:30 Cook lunches', '18:30-20:00 Gym']);
  });

  test("'before' against a movable block REORDERS the pair, keeping the window", async () => {
    // Wrong order: gym 5–6:30 THEN cook 6:45–7:45. "cook before gym" should not
    // drag cook to a lone earlier slot — it swaps them inside the same window:
    // cook slides to where the pair starts (5:00) and gym is pushed to follow.
    db.update(schema.event).set({ starts_at: '2026-09-07T17:00', ends_at: '2026-09-07T18:30' }).where(eq(schema.event.id, 'gym')).run();
    db.update(schema.event).set({ starts_at: '2026-09-07T18:45', ends_at: '2026-09-07T19:45' }).where(eq(schema.event.id, 'cook')).run();

    const { conflicts } = await placeAdjacentTool.run(
      { event_id: 'cook', expect_title: 'Cook lunches', date: '2026-09-07', anchor_title: 'Gym', position: 'before', gap_minutes: 0 } as never,
      'commit',
    );
    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);
    // Cook took the 5:00 slot (60 min); gym was pushed to right after it. Both
    // stayed in the 5:00–7:00 window — not stretched later, not dragged to 4 PM.
    expect(on()).toEqual(['17:00-18:00 Cook lunches', '18:00-19:30 Gym']);
  });

  test("'before' is a no-op when the pair is already in order", async () => {
    // cook 17:30–18:30 already precedes gym 20:00–21:30 (the beforeEach layout).
    await placeAdjacentTool.run(
      { event_id: 'cook', expect_title: 'Cook lunches', date: '2026-09-07', anchor_title: 'Gym', position: 'before', gap_minutes: 0 } as never,
      'commit',
    );
    expect(on()).toEqual(['17:30-18:30 Cook lunches', '20:00-21:30 Gym']);
  });

  test('a gap can be left', async () => {
    await placeAdjacentTool.run(
      { event_id: 'gym', expect_title: 'Gym', date: '2026-09-07', anchor_title: 'Cook lunches', position: 'after', gap_minutes: 15 } as never,
      'commit',
    );
    const gym = getInstances(db, '2026-09-07', '2026-09-07').find((i) => i.title === 'Gym')!;
    expect(gym.starts_at.slice(11)).toBe('18:45'); // 18:30 + 15
  });

  test('no anchor on the day is refused, not guessed', async () => {
    const { conflicts } = await placeAdjacentTool.run(
      { event_id: 'gym', expect_title: 'Gym', date: '2026-09-07', anchor_title: 'Nap', position: 'after' } as never,
      'commit',
    );
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'no_anchor')).toBe(true);
  });

  // The real-world case: APPLD MACHINE LEARNING 3:30–5 sits right before the gym.
  // "cook before gym" must NOT put cook at 4–5 (on the class). The reorder slides
  // cook to 5:00 (right after the class) and pushes gym to follow — school
  // timings respected without the model having to plan around them.
  test('reorder lands the pair right after the class, never on it', async () => {
    db.update(schema.event).set({ starts_at: '2026-09-07T17:00', ends_at: '2026-09-07T18:30' }).where(eq(schema.event.id, 'gym')).run();
    db.update(schema.event).set({ starts_at: '2026-09-07T18:45', ends_at: '2026-09-07T19:45' }).where(eq(schema.event.id, 'cook')).run();
    db.insert(schema.event)
      .values({
        id: 'cls', semester_id: 's1', title: 'APPLD MACHINE LEARNING', kind: 'class',
        starts_at: '2026-09-07T15:30', ends_at: '2026-09-07T17:00',
        pinned: true, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: null,
      })
      .run();

    const { conflicts } = await placeAdjacentTool.run(
      { event_id: 'cook', expect_title: 'Cook lunches', date: '2026-09-07', anchor_title: 'Gym', position: 'before', gap_minutes: 0 } as never,
      'commit',
    );
    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);
    // Class untouched; cook 5–6 right after it; gym 6–7:30 after cook. Cook before
    // gym, both in the same 5–7:30 evening window, nothing at 4 PM.
    expect(on()).toEqual(['15:30-17:00 APPLD MACHINE LEARNING', '17:00-18:00 Cook lunches', '18:00-19:30 Gym']);
  });

  // A PINNED anchor can't be reordered around, so 'before' still tucks the mover
  // right up against it — "put my study block just before my 2 PM exam".
  test("'before' against a pinned block tucks the mover up to its start", async () => {
    db.insert(schema.event)
      .values({
        id: 'exam', semester_id: 's1', title: 'EXAM', kind: 'class',
        starts_at: '2026-09-07T14:00', ends_at: '2026-09-07T16:00',
        pinned: true, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: null,
      })
      .run();

    await placeAdjacentTool.run(
      { event_id: 'cook', expect_title: 'Cook lunches', date: '2026-09-07', anchor_title: 'EXAM', position: 'before', gap_minutes: 0 } as never,
      'commit',
    );
    const cook = getInstances(db, '2026-09-07', '2026-09-07').find((i) => i.title === 'Cook lunches')!;
    expect(cook.ends_at.slice(11)).toBe('14:00'); // ends exactly when the exam starts
    expect(cook.starts_at.slice(11)).toBe('13:00'); // 60-min cook
  });
});

describe('set_workout — relabel a session, do not cancel/re-add', () => {
  test('changes the workout key; nothing is added or moved', async () => {
    const before = getInstances(db, '2026-09-07', '2026-09-07').filter((i) => i.kind === 'gym').length;
    const { diff, conflicts } = await setWorkoutTool.run(
      { event_id: 'gym', expect_title: 'Gym', workout: 'Chest and back' } as never,
      'commit',
    );
    expect(conflicts).toEqual([]);
    expect(diff.workout_relabel).toEqual({ event_id: 'gym', before: 'legs', after: 'chest-back' });
    expect(db.select().from(schema.event).where(eq(schema.event.id, 'gym')).get()!.workout).toBe('chest-back');
    // Still exactly one gym block, at the same time — no cancel, no duplicate.
    expect(getInstances(db, '2026-09-07', '2026-09-07').filter((i) => i.kind === 'gym').length).toBe(before);
  });

  test('refuses a non-gym block, an unknown workout, and a no-op', async () => {
    const notGym = await setWorkoutTool.run({ event_id: 'cook', expect_title: 'Cook lunches', workout: 'Legs' } as never, 'commit');
    expect(notGym.conflicts.some((c) => c.type === 'constraint' && c.rule === 'not_gym')).toBe(true);

    const noSuch = await setWorkoutTool.run({ event_id: 'gym', expect_title: 'Gym', workout: 'Cardio' } as never, 'commit');
    expect(noSuch.conflicts.some((c) => c.type === 'constraint' && c.rule === 'no_workout')).toBe(true);

    const noop = await setWorkoutTool.run({ event_id: 'gym', expect_title: 'Gym', workout: 'Legs' } as never, 'commit');
    expect(noop.conflicts.some((c) => c.type === 'constraint' && c.rule === 'already')).toBe(true);
  });

  test('undo restores the old label', async () => {
    const { diff } = await setWorkoutTool.run({ event_id: 'gym', expect_title: 'Gym', workout: 'Chest and back' } as never, 'commit');
    const p = createProposal(db, { user_message: 'relabel', tool_name: 'set_workout', tool_args: {}, diff, conflicts: [] });
    db.update(schema.proposal).set({ status: 'approved' }).where(eq(schema.proposal.id, p.id)).run();
    const row = db.select().from(schema.proposal).where(eq(schema.proposal.id, p.id)).get()! as ProposalRow;

    expect(isUndoable(row)).toBe(true);
    expect(undoProposal(db, row).ok).toBe(true);
    expect(db.select().from(schema.event).where(eq(schema.event.id, 'gym')).get()!.workout).toBe('legs');
  });
});
