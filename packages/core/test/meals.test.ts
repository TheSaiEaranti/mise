/**
 * Meals v2 CRUD: meals, suites, cook assignments — including the in-code
 * cascades (SQLite FKs are not enforced) and the derived cook-block subtitle.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import {
  assignCook,
  assignmentLabel,
  clearAssignment,
  createMeal,
  createSuite,
  deleteMeal,
  deleteSuite,
  findMealByName,
  listAssignments,
  listMeals,
  listSuites,
} from '../src/meals';
import { enrichInstances, detailsFor } from '../src/details';

let db: DB;
beforeEach(() => {
  db = resetDbForTests();
});

function seedPair() {
  const b = createMeal(db, { name: 'Overnight oats', meal_type: 'breakfast', ingredients: ['2 cups rolled oats', '1 cup milk'] });
  const l = createMeal(db, { name: 'Chipotle bowls', meal_type: 'lunch', ingredients: ['1 lb chicken', '2 cups rice'], details: 'Grill, then bowl.' });
  const s = createSuite(db, { name: 'Oats + Bowls', breakfast_meal_id: b.id, lunch_meal_id: l.id });
  return { b, l, s };
}

describe('meals CRUD', () => {
  test('create trims and drops empty ingredient lines; find matches loosely by name', () => {
    const m = createMeal(db, { name: '  Overnight Oats ', meal_type: 'breakfast', ingredients: [' 2 cups oats ', '', '1 cup milk'] });
    expect(m.name).toBe('Overnight Oats');
    expect(m.ingredients).toEqual(['2 cups oats', '1 cup milk']);
    expect(findMealByName(db, 'overnight  oats', 'breakfast')?.id).toBe(m.id);
    expect(findMealByName(db, 'overnight oats', 'lunch')).toBeUndefined(); // type-scoped
  });

  test('deleting a meal cascades through its suites and their assignments', () => {
    const { b, l } = seedPair();
    const s2 = listSuites(db)[0]!;
    assignCook(db, { event_id: 'evt-1', date: '2026-09-01', suite_id: s2.id });
    assignCook(db, { event_id: 'evt-2', date: '2026-09-02', meal_id: l.id });

    deleteMeal(db, b.id); // breakfast → suite dies → suite assignment dies
    expect(listMeals(db).map((m) => m.id)).toEqual([l.id]);
    expect(listSuites(db)).toEqual([]);
    expect(listAssignments(db).map((a) => a.event_id)).toEqual(['evt-2']); // meal assignment survives

    deleteMeal(db, l.id);
    expect(listAssignments(db)).toEqual([]);
  });

  test('deleting a suite removes its assignments, not its meals', () => {
    const { s } = seedPair();
    assignCook(db, { event_id: 'evt-1', date: '2026-09-01', suite_id: s.id });
    deleteSuite(db, s.id);
    expect(listSuites(db)).toEqual([]);
    expect(listAssignments(db)).toEqual([]);
    expect(listMeals(db)).toHaveLength(2);
  });
});

describe('cook assignments', () => {
  test('assign replaces the previous assignment for that (event, date)', () => {
    const { l, s } = seedPair();
    assignCook(db, { event_id: 'evt-1', date: '2026-09-01', suite_id: s.id });
    assignCook(db, { event_id: 'evt-1', date: '2026-09-01', meal_id: l.id });
    const all = listAssignments(db);
    expect(all).toHaveLength(1);
    expect(all[0]!.meal_id).toBe(l.id);
    expect(all[0]!.suite_id).toBeNull();
    expect(assignmentLabel(db, all[0]!)).toBe('Chipotle bowls');
  });

  test('clearAssignment removes it; range listing filters by date', () => {
    const { s } = seedPair();
    assignCook(db, { event_id: 'evt-1', date: '2026-09-01', suite_id: s.id });
    assignCook(db, { event_id: 'evt-2', date: '2026-09-08', suite_id: s.id });
    expect(listAssignments(db, '2026-09-01', '2026-09-07')).toHaveLength(1);
    expect(clearAssignment(db, 'evt-1', '2026-09-01')).toBe(true);
    expect(clearAssignment(db, 'evt-1', '2026-09-01')).toBe(false);
    expect(listAssignments(db)).toHaveLength(1);
  });
});

describe('cook block subtitle + details derive from the assignment', () => {
  function seedCookEvent() {
    db.insert(schema.semester)
      .values({ id: 'sem-1', name: 'Fall', start_date: '2026-08-24', end_date: '2026-12-31', timezone: 'America/Chicago' })
      .run();
    db.insert(schema.event)
      .values({
        id: 'evt-cook',
        semester_id: 'sem-1',
        title: 'Cook lunches',
        kind: 'cook',
        starts_at: '2026-09-01T12:00',
        ends_at: '2026-09-01T13:00',
        pinned: false,
        rrule: null,
        source: 'agent',
        location: null,
        notes: null,
      })
      .run();
  }

  test('unassigned cook block: no subtitle, no details', () => {
    seedCookEvent();
    const [inst] = enrichInstances(db, [
      {
        event_id: 'evt-cook', instance_date: '2026-09-01', title: 'Cook lunches', kind: 'cook',
        starts_at: '2026-09-01T12:00', ends_at: '2026-09-01T13:00', pinned: false,
        location: null, notes: null, source: 'agent', recurring: false, color: null, workout: null,
      },
    ]);
    expect(inst!.subtitle).toBeNull();
    expect(inst!.has_details).toBe(false);
  });

  test('suite-assigned cook block: suite name as subtitle, both meals in details', () => {
    seedCookEvent();
    const { s } = seedPair();
    assignCook(db, { event_id: 'evt-cook', date: '2026-09-01', suite_id: s.id });

    const [inst] = enrichInstances(db, [
      {
        event_id: 'evt-cook', instance_date: '2026-09-01', title: 'Cook lunches', kind: 'cook',
        starts_at: '2026-09-01T12:00', ends_at: '2026-09-01T13:00', pinned: false,
        location: null, notes: null, source: 'agent', recurring: false, color: null, workout: null,
      },
    ]);
    expect(inst!.subtitle).toBe('Oats + Bowls');
    expect(inst!.has_details).toBe(true);

    const details = detailsFor(db, 'evt-cook', '2026-09-01')!;
    expect(details.subtitle).toBe('Oats + Bowls');
    expect(details.sections.map((x) => x.heading)).toEqual([
      'Breakfast · Overnight oats',
      'Lunch · Chipotle bowls',
    ]);
    expect(details.sections[0]!.lines.map((ln) => ln.label)).toEqual(['2 cups rolled oats', '1 cup milk']);
    expect(details.body).toBe('Grill, then bowl.');
  });

  test('single-meal assignment: meal name as subtitle, one section', () => {
    seedCookEvent();
    const { l } = seedPair();
    assignCook(db, { event_id: 'evt-cook', date: '2026-09-01', meal_id: l.id });
    const details = detailsFor(db, 'evt-cook', '2026-09-01')!;
    expect(details.subtitle).toBe('Chipotle bowls');
    expect(details.sections.map((x) => x.heading)).toEqual(['Lunch · Chipotle bowls']);
  });
});

// ---------------------------------------------------------------------------
// A STANDALONE cook block dragged to another day keeps its assignment: the row
// stays keyed to the old date (nothing migrates it on a shift), so the read
// side falls back to the event's single assignment and the write side replaces
// event-wide — no stale suite can resurface on a drag back.
// ---------------------------------------------------------------------------

describe('assignments follow a moved standalone cook block', () => {
  function seedStandaloneCook() {
    db.insert(schema.semester)
      .values({ id: 'sem-1', name: 'Fall', start_date: '2026-08-24', end_date: '2026-12-31', timezone: 'America/Chicago' })
      .run();
    db.insert(schema.event)
      .values({
        id: 'evt-cook', semester_id: 'sem-1', title: 'Cook lunches', kind: 'cook',
        starts_at: '2026-09-01T12:00', ends_at: '2026-09-01T13:00',
        pinned: false, rrule: null, source: 'agent', location: null, notes: null,
      })
      .run();
  }
  const instOn = (date: string) => ({
    event_id: 'evt-cook', instance_date: date, title: 'Cook lunches', kind: 'cook' as const,
    starts_at: `${date}T12:00`, ends_at: `${date}T13:00`, pinned: false,
    location: null, notes: null, source: 'agent' as const, recurring: false, color: null, workout: null,
  });

  test('subtitle and details survive a cross-day move of the block', () => {
    seedStandaloneCook();
    const { s } = seedPair();
    assignCook(db, { event_id: 'evt-cook', date: '2026-09-01', suite_id: s.id });

    // The block moves to Sep 2 (shift updates the event row in place; the
    // assignment row still says Sep 1).
    db.update(schema.event).set({ starts_at: '2026-09-02T12:00', ends_at: '2026-09-02T13:00' }).where(eq(schema.event.id, 'evt-cook')).run();

    const [inst] = enrichInstances(db, [instOn('2026-09-02')]);
    expect(inst!.subtitle).toBe('Oats + Bowls');
    expect(detailsFor(db, 'evt-cook', '2026-09-02')!.subtitle).toBe('Oats + Bowls');
  });

  test('re-assigning after a move replaces event-wide — the old-date row cannot resurface', () => {
    seedStandaloneCook();
    const { l, s } = seedPair();
    assignCook(db, { event_id: 'evt-cook', date: '2026-09-01', suite_id: s.id });
    // Block moved to Sep 2; Sai assigns the single meal there instead.
    assignCook(db, { event_id: 'evt-cook', date: '2026-09-02', meal_id: l.id });
    expect(listAssignments(db)).toHaveLength(1); // the Sep 1 suite row is GONE
    // Dragged back to Sep 1: what shows is what he last picked, not the stale suite.
    const [inst] = enrichInstances(db, [instOn('2026-09-01')]);
    expect(inst!.subtitle).toBe('Chipotle bowls');
  });

  test('a RECURRING cook block never falls back across dates', () => {
    seedStandaloneCook();
    db.update(schema.event).set({ rrule: 'FREQ=DAILY;INTERVAL=3;UNTIL=20261231' }).where(eq(schema.event.id, 'evt-cook')).run();
    const { s } = seedPair();
    assignCook(db, { event_id: 'evt-cook', date: '2026-09-01', suite_id: s.id });
    const [other] = enrichInstances(db, [{ ...instOn('2026-09-04'), recurring: true }]);
    expect(other!.subtitle).toBeNull(); // Sep 4's occurrence is its own cook — unassigned
  });
});
