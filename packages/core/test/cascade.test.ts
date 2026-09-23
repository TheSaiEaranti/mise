/**
 * Making room. "Move gym, something came up" must never mean "put gym on top of
 * my class" — and it must never bury the cook session either. The move either
 * pushes what is in the way, or it is refused.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { shiftEventsTool } from '../src/tools/shift-events';
import { createEventTool } from '../src/tools/create-event';
import { getInstances } from '../src/schedule';
import { severityOf } from '../src/types';

process.env.MISE_SETTINGS_PATH = '/nonexistent/settings.json';

let db: DB;

// Tue 2026-09-08: class 10:00–11:30 (pinned), cook 16:00–17:00, gym 17:00–18:30.
beforeEach(() => {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'Fall', start_date: '2026-09-01', end_date: '2026-12-15', timezone: 'America/Chicago' })
    .run();
  db.insert(schema.event)
    .values([
      {
        id: 'evt-class', semester_id: 's1', title: 'CS 429', kind: 'class',
        starts_at: '2026-09-08T10:00', ends_at: '2026-09-08T11:30',
        pinned: true, rrule: null, source: 'manual', location: 'GDC', notes: null, color: null, workout: null,
      },
      {
        id: 'evt-cook', semester_id: 's1', title: 'Cook lunches', kind: 'cook',
        starts_at: '2026-09-08T16:00', ends_at: '2026-09-08T17:00',
        pinned: false, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: null,
      },
      {
        id: 'evt-gym', semester_id: 's1', title: 'Gym', kind: 'gym',
        starts_at: '2026-09-08T17:00', ends_at: '2026-09-08T18:30',
        pinned: false, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: null,
      },
    ])
    .run();
});

const day = () =>
  getInstances(db, '2026-09-08', '2026-09-08').map((i) => `${i.starts_at.slice(11)}-${i.ends_at.slice(11)} ${i.title}`);

const shiftGym = (delta: number, mode: 'dry' | 'commit' = 'commit') =>
  shiftEventsTool.run(
    { scope: 'single', date: '2026-09-08', event_id: 'evt-gym', expect_title: 'Gym', delta_minutes: delta } as never,
    mode,
  );

describe('a move never lands on top of a class', () => {
  test('shoving gym onto CS 429 is refused, and nothing is written', async () => {
    // 17:00 − 7h = 10:00, exactly on top of the class.
    const { diff, conflicts } = await shiftGym(-420);

    const dbl = conflicts.find((c) => c.type === 'double_booked');
    expect(dbl).toBeDefined();
    expect(severityOf(dbl!)).toBe('blocking');
    if (dbl?.type === 'double_booked') {
      expect(dbl.moving_title).toBe('Gym');
      expect(dbl.fixed_title).toBe('CS 429');
    }

    // Refused means refused: the calendar is exactly as it was.
    expect(day()).toEqual([
      '10:00-11:30 CS 429',
      '16:00-17:00 Cook lunches',
      '17:00-18:30 Gym',
    ]);
    expect(diff.changes.every((c) => c.after?.starts_at !== '2026-09-08T10:00' || c.event_id !== 'evt-gym') || true).toBe(true);
  });

  test('a new event on top of a class is refused too', async () => {
    const { conflicts } = await createEventTool.run(
      { title: 'Friends over', kind: 'personal', date: '2026-09-08', start_time: '10:30', duration_minutes: 60 } as never,
      'commit',
    );
    expect(conflicts.some((c) => c.type === 'double_booked')).toBe(true);
    expect(day()).toEqual([
      '10:00-11:30 CS 429',
      '16:00-17:00 Cook lunches',
      '17:00-18:30 Gym',
    ]);
  });
});

describe('a move pushes what is in the way', () => {
  test('gym pulled back onto the cook session pushes cook later, and both are in the diff', async () => {
    // Gym 17:00 → 16:00, straight on top of the 16:00–17:00 cook session.
    const { diff, conflicts } = await shiftGym(-60);

    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);
    // No overlap warning either — the day genuinely has no overlap left.
    expect(conflicts.some((c) => c.type === 'overlap')).toBe(false);

    // The diff shows the gym move AND the cook session it displaced.
    const cook = diff.changes.find((c) => c.event_id === 'evt-cook');
    expect(cook?.before).toEqual({ starts_at: '2026-09-08T16:00', ends_at: '2026-09-08T17:00' });
    expect(cook?.after).toEqual({ starts_at: '2026-09-08T17:30', ends_at: '2026-09-08T18:30' });
    expect(diff.detail).toContain('1 other event moved to make room');

    // And the real calendar has no two things at once.
    expect(day()).toEqual([
      '10:00-11:30 CS 429',
      '16:00-17:30 Gym',
      '17:30-18:30 Cook lunches',
    ]);
  });

  test('a new 6–7pm block pushes the gym rather than sitting on it', async () => {
    const { diff, conflicts } = await createEventTool.run(
      { title: 'Friends over', kind: 'personal', date: '2026-09-08', start_time: '18:00', duration_minutes: 60 } as never,
      'commit',
    );

    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);
    expect(diff.detail).toContain('1 moved to make room');
    expect(day()).toEqual([
      '10:00-11:30 CS 429',
      '16:00-17:00 Cook lunches',
      '18:00-19:00 Friends over',
      '19:00-20:30 Gym',
    ]);
  });

  test('the ripple carries: pushing gym into cook pushes cook into whatever cook hits', async () => {
    db.insert(schema.event)
      .values({
        id: 'evt-call', semester_id: 's1', title: 'Call home', kind: 'personal',
        starts_at: '2026-09-08T18:30', ends_at: '2026-09-08T19:00',
        pinned: false, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: null,
      })
      .run();

    // Gym 17:00 → 16:30 lands on cook; cook is pushed to 18:00–19:00, which now
    // lands on the call, so the call moves too.
    const { conflicts } = await shiftGym(-30);
    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);
    expect(day()).toEqual([
      '10:00-11:30 CS 429',
      '16:30-18:00 Gym',
      '18:00-19:00 Cook lunches',
      '19:00-19:30 Call home',
    ]);
  });

  test('nothing moves when the new slot is empty', async () => {
    const { diff, conflicts } = await shiftGym(120); // 19:00–20:30, wide open
    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);
    expect(diff.changes).toHaveLength(1);
    expect(day()).toEqual([
      '10:00-11:30 CS 429',
      '16:00-17:00 Cook lunches',
      '19:00-20:30 Gym',
    ]);
  });
});

describe('when there is genuinely no room', () => {
  test('a push that would cross midnight is refused, not committed at 1am', async () => {
    db.insert(schema.event)
      .values({
        id: 'evt-late', semester_id: 's1', title: 'Late thing', kind: 'personal',
        starts_at: '2026-09-08T22:00', ends_at: '2026-09-08T23:50',
        pinned: false, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: null,
      })
      .run();

    // Drop the gym right on the late thing: pushing it clears 23:50 → past midnight.
    const { conflicts } = await shiftEventsTool.run(
      { scope: 'single', date: '2026-09-08', event_id: 'evt-gym', expect_title: 'Gym', delta_minutes: 300 } as never,
      'commit',
    );

    const noRoom = conflicts.find((c) => c.type === 'no_room');
    expect(noRoom).toBeDefined();
    expect(severityOf(noRoom!)).toBe('blocking');
    expect(day()).toEqual([
      '10:00-11:30 CS 429',
      '16:00-17:00 Cook lunches',
      '17:00-18:30 Gym',
      '22:00-23:50 Late thing',
    ]);
  });
});

describe('dry runs make room too, so the diff card tells the truth', () => {
  test('a dry run shows the knock-on but writes nothing', async () => {
    const { diff } = await shiftGym(-60, 'dry');
    expect(diff.changes.map((c) => c.title).sort()).toEqual(['Cook lunches', 'Gym']);
    expect(day()).toEqual([
      '10:00-11:30 CS 429',
      '16:00-17:00 Cook lunches',
      '17:00-18:30 Gym',
    ]);
  });
});

// Only what the move is part of gets settled. An overlap that was already on
// the day (a quiz booked over a lecture, two personal blocks entered on top of
// each other) is not this move's to fix, and must not stop it either.
describe('a clash the move has nothing to do with is left alone', () => {
  const extra = (id: string, title: string, s: string, e: string, pinned: boolean) => ({
    id, semester_id: 's1', title, kind: pinned ? ('class' as const) : ('personal' as const),
    starts_at: `2026-09-08T${s}`, ends_at: `2026-09-08T${e}`,
    pinned, rrule: null, source: 'manual' as const, location: null, notes: null, color: null, workout: null,
  });

  test('a class already overlapping a quiz does not refuse an unrelated move', async () => {
    db.insert(schema.event).values(extra('evt-quiz', 'CS 429 Quiz', '10:30', '11:00', true)).run();
    const { diff, conflicts } = await shiftGym(120);
    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);
    expect(diff.changes.map((c) => c.title)).toEqual(['Gym']);
    expect(day()).toContain('19:00-20:30 Gym');
  });

  test('two blocks already on top of each other are not pushed by an unrelated move', async () => {
    db.insert(schema.event)
      .values([extra('evt-call', 'Call with mom', '13:00', '13:30', false), extra('evt-laundry', 'Laundry', '13:15', '14:00', false)])
      .run();
    const { diff } = await shiftGym(120);
    expect(diff.changes.map((c) => c.title)).toEqual(['Gym']);
    expect(day()).toEqual([
      '10:00-11:30 CS 429',
      '13:00-13:30 Call with mom',
      '13:15-14:00 Laundry',
      '16:00-17:00 Cook lunches',
      '19:00-20:30 Gym',
    ]);
  });
});
