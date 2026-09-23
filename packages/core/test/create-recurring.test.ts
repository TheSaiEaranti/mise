/**
 * create_event with a repeat — "cook lunches every other day". One call makes
 * the whole series; the bug was that the model had no way to say "repeating" and
 * so only ever added a single event.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { createEventTool } from '../src/tools/create-event';
import { getInstances } from '../src/schedule';
import { isUndoable } from '../src/undo';

process.env.MISE_SETTINGS_PATH = '/nonexistent/settings.json';

let db: DB;

// Semester Jun–Aug 2026. 2026-07-19 is a Sunday.
beforeEach(() => {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'Summer', start_date: '2026-06-04', end_date: '2026-08-14', timezone: 'America/Chicago' })
    .run();
});

describe('a gym session can name its workout', () => {
  test('workout label resolves a split name to its key and stores it', async () => {
    const { conflicts } = await createEventTool.run(
      { title: 'Gym', kind: 'gym', date: '2026-07-20', start_time: '17:00', duration_minutes: 60, workout: 'Legs' } as never,
      'commit',
    );
    expect(conflicts).toEqual([]);
    const gym = db.select().from(schema.event).all().find((e) => e.title === 'Gym')!;
    expect(gym.workout).toBe('legs'); // "Legs" → key 'legs'
  });

  test('a recurring weekly gym on one day carries the workout', async () => {
    await createEventTool.run(
      {
        title: 'Gym', kind: 'gym', date: '2026-07-20', start_time: '17:00', duration_minutes: 60,
        workout: 'Chest and back', repeat: { frequency: 'weekly', days: ['MO'] },
      } as never,
      'commit',
    );
    const row = db.select().from(schema.event).all().find((e) => e.title === 'Gym')!;
    expect(row.workout).toBe('chest-back');
    expect(row.rrule).toContain('BYDAY=MO');
  });

  test('workout is ignored for a non-gym event', async () => {
    await createEventTool.run(
      { title: 'Study', kind: 'personal', date: '2026-07-20', start_time: '12:00', duration_minutes: 60, workout: 'Legs' } as never,
      'commit',
    );
    const s = db.select().from(schema.event).all().find((e) => e.title === 'Study')!;
    expect(s.workout).toBeNull();
  });
});

const create = (over: Record<string, unknown>, mode: 'dry' | 'commit' = 'commit') =>
  createEventTool.run(
    { title: 'Cook lunches', kind: 'cook', date: '2026-07-19', start_time: '18:00', duration_minutes: 60, ...over } as never,
    mode,
  );

const cookDays = (start = '2026-07-19', end = '2026-08-14') =>
  getInstances(db, start, end)
    .filter((i) => i.title === 'Cook lunches')
    .map((i) => i.instance_date);

describe('cook lunches every other day starting Sunday', () => {
  test('one call lays the whole series, not a single lunch', async () => {
    const { diff, conflicts } = await create({ repeat: { frequency: 'daily', interval: 2 } });
    expect(conflicts.filter((c) => c.type === 'double_booked' || c.type === 'pinned_moved')).toEqual([]);
    expect(diff.summary).toContain('every other day');
    expect(diff.detail).toContain('through Aug 14');

    // Sun 19, then every other day to the end of the semester.
    const got = cookDays();
    expect(got.slice(0, 5)).toEqual(['2026-07-19', '2026-07-21', '2026-07-23', '2026-07-25', '2026-07-27']);
    expect(got.length).toBeGreaterThan(10); // a real series, not one event
    expect(got.every((d) => d <= '2026-08-14')).toBe(true);
  });

  test('exactly one event row is written — the series is one recurring row', async () => {
    await create({ repeat: { frequency: 'daily', interval: 2 } });
    const rows = db.select().from(schema.event).all().filter((e) => e.title === 'Cook lunches');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rrule).toBe('FREQ=DAILY;INTERVAL=2;UNTIL=20260814');
  });

  test('an explicit end date is honored', async () => {
    await create({ repeat: { frequency: 'daily', interval: 2, until: '2026-07-25' } });
    expect(cookDays()).toEqual(['2026-07-19', '2026-07-21', '2026-07-23', '2026-07-25']);
  });
});

describe('weekly repeats', () => {
  test('gym Mon/Wed/Fri', async () => {
    await create({
      title: 'Gym',
      kind: 'gym',
      date: '2026-07-20', // Monday
      start_time: '07:00',
      duration_minutes: 90,
      repeat: { frequency: 'weekly', days: ['MO', 'WE', 'FR'] },
    });
    const gym = getInstances(db, '2026-07-20', '2026-07-31')
      .filter((i) => i.title === 'Gym')
      .map((i) => i.instance_date);
    expect(gym).toEqual([
      '2026-07-20', '2026-07-22', '2026-07-24', // Mon Wed Fri
      '2026-07-27', '2026-07-29', '2026-07-31',
    ]);
    const row = db.select().from(schema.event).all().find((e) => e.title === 'Gym')!;
    expect(row.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR;INTERVAL=1;UNTIL=20260814');
  });

  test('weekly with no days named uses the start date’s weekday', async () => {
    await create({
      title: 'Therapy',
      kind: 'personal',
      date: '2026-07-21', // Tuesday
      start_time: '15:00',
      duration_minutes: 60,
      repeat: { frequency: 'weekly' },
    });
    const row = db.select().from(schema.event).all().find((e) => e.title === 'Therapy')!;
    expect(row.rrule).toBe('FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;UNTIL=20260814');
  });
});

describe('a repeating create places itself clear of everything, on every day', () => {
  test('a series whose requested time hits a class is relocated, not dropped on top', async () => {
    db.insert(schema.event)
      .values({
        id: 'cls', semester_id: 's1', title: 'CS 429', kind: 'class',
        starts_at: '2026-07-19T18:00', ends_at: '2026-07-19T19:30',
        pinned: true, rrule: null, source: 'manual', location: 'GDC', notes: null, color: null, workout: null,
      })
      .run();
    const { conflicts } = await create({ repeat: { frequency: 'daily', interval: 2 } });
    expect(conflicts.some((c) => c.type === 'double_booked')).toBe(false);

    // It WAS created — just not on top of the class. The anchor no longer
    // overlaps the 18:00–19:30 class.
    const cook = db.select().from(schema.event).all().find((e) => e.title === 'Cook lunches')!;
    expect(cook).toBeDefined();
    const cookStart = cook.starts_at.slice(11);
    const cookEnd = cook.ends_at.slice(11);
    const overlapsClass = cookStart < '19:30' && '18:00' < cookEnd;
    expect(overlapsClass).toBe(false);
  });

  test('the gym is not overlapped on ANY occurrence day (the real bug)', async () => {
    // Gym 17:00–18:30 every day; a daily cook at the same time would sit on it.
    for (const d of ['2026-07-19', '2026-07-21', '2026-07-23', '2026-07-25', '2026-07-27']) {
      db.insert(schema.event)
        .values({
          id: `gym-${d}`, semester_id: 's1', title: 'Gym', kind: 'gym',
          starts_at: `${d}T17:00`, ends_at: `${d}T18:30`,
          pinned: false, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: null,
        })
        .run();
    }
    // Ask for cook at 18:00 (overlaps gym by 30 min) every other day.
    await create({ title: 'Cook time', repeat: { frequency: 'daily', interval: 2 }, start_time: '18:00' });

    const inst = getInstances(db, '2026-07-19', '2026-07-27');
    const ov = (a: { starts_at: string; ends_at: string }, b: { starts_at: string; ends_at: string }) =>
      a.starts_at < b.ends_at && b.starts_at < a.ends_at;
    for (const day of ['2026-07-19', '2026-07-21', '2026-07-23', '2026-07-25', '2026-07-27']) {
      const cooks = inst.filter((i) => i.title === 'Cook time' && i.instance_date === day);
      const gyms = inst.filter((i) => i.kind === 'gym' && i.instance_date === day);
      for (const c of cooks) for (const g of gyms) expect(ov(c, g)).toBe(false);
    }
    // And it landed right after the gym — 18:30, the nearest clear time to 18:00.
    const cook = db.select().from(schema.event).all().find((e) => e.title === 'Cook time')!;
    expect(cook.starts_at.slice(11)).toBe('18:30');
  });

  test('a repeating create does NOT shove other events aside on day one', async () => {
    // A one-off gym on the anchor Sunday at 6pm. A one-off create would push it;
    // a repeating habit yields instead — it finds a clear time for itself.
    db.insert(schema.event)
      .values({
        id: 'gym1', semester_id: 's1', title: 'Gym', kind: 'gym',
        starts_at: '2026-07-19T18:00', ends_at: '2026-07-19T19:30',
        pinned: false, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: null,
      })
      .run();
    await create({ repeat: { frequency: 'daily', interval: 2 } });
    const gym = db.select().from(schema.event).all().find((e) => e.id === 'gym1')!;
    expect(gym.starts_at).toBe('2026-07-19T18:00'); // untouched
  });

  test('the whole series undoes in one click (create is undoable)', async () => {
    expect(isUndoable({ tool_name: 'create_event', status: 'approved' })).toBe(true);
  });
});

describe('a date before the term start is clamped to it (no invisible pre-term events)', () => {
  test('a too-early date moves to the semester start, with a note', async () => {
    // Semester starts 2026-06-04. A block dated in May would land in the hidden
    // pre-term zone; it should be created on 06-04 instead.
    const { conflicts } = await createEventTool.run(
      { title: 'Breakfast', kind: 'personal', date: '2026-05-01', start_time: '10:00', duration_minutes: 60 } as never,
      'commit',
    );
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'pre_term')).toBe(true);
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'pre_term' && (c as { message: string }).message.length > 0)).toBe(true);
    // created on the term start, not the given May date
    const start = getInstances(db, '2026-06-04', '2026-06-04').find((i) => i.title === 'Breakfast');
    expect(start?.starts_at).toBe('2026-06-04T10:00');
    expect(getInstances(db, '2026-05-01', '2026-05-01').some((i) => i.title === 'Breakfast')).toBe(false);
  });

  test('a recurring pre-term series takes its first occurrence from the term start', async () => {
    // Weekly Mon/Wed, given a May date → first occurrences from the 06-04 week.
    await createEventTool.run(
      { title: 'Breakfast', kind: 'personal', date: '2026-05-01', start_time: '10:00', duration_minutes: 30, repeat: { frequency: 'weekly', days: ['MO', 'WE'] } } as never,
      'commit',
    );
    const days = getInstances(db, '2026-06-01', '2026-06-14')
      .filter((i) => i.title === 'Breakfast')
      .map((i) => i.instance_date);
    // 06-04 is a Thursday; first Mon/Wed on/after it are 06-08 (Mon) and 06-10 (Wed).
    expect(days.every((d) => d >= '2026-06-04')).toBe(true);
    expect(days).toContain('2026-06-08');
    expect(days).toContain('2026-06-10');
  });

  test('a date within the term is untouched — no note', async () => {
    const { conflicts } = await createEventTool.run(
      { title: 'Lunch', kind: 'personal', date: '2026-07-20', start_time: '12:00', duration_minutes: 30 } as never,
      'commit',
    );
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'pre_term')).toBe(false);
    expect(getInstances(db, '2026-07-20', '2026-07-20').some((i) => i.title === 'Lunch')).toBe(true);
  });
});
