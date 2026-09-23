/**
 * block_free_time — "friends are over at 10, make everything before that a study
 * hour." The tool finds the free run; the model never does the arithmetic. (I3)
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { blockFreeTimeTool } from '../src/tools/block-free-time';
import { getInstances } from '../src/schedule';

process.env.MISE_SETTINGS_PATH = '/nonexistent/settings.json';

let db: DB;

// Tue 2026-09-08, mirroring the real week: classes, then gym 17:00–18:30.
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
        id: 'evt-gym', semester_id: 's1', title: 'Gym', kind: 'gym',
        starts_at: '2026-09-08T17:00', ends_at: '2026-09-08T18:30',
        pinned: false, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: null,
      },
      {
        id: 'evt-friends', semester_id: 's1', title: 'Friends coming over', kind: 'personal',
        starts_at: '2026-09-08T22:00', ends_at: '2026-09-08T23:00',
        pinned: false, rrule: null, source: 'agent', location: null, notes: null, color: null, workout: null,
      },
    ])
    .run();
});

const block = (over: Record<string, unknown> = {}, mode: 'dry' | 'commit' = 'commit') =>
  blockFreeTimeTool.run(
    { date: '2026-09-08', title: 'Study', kind: 'personal', min_minutes: 30, ...over } as never,
    mode,
  );

describe('max_minutes caps the block to a stated length', () => {
  test('"the 2 hours before my 10pm plans" is the LAST 2 hours, not the whole free run', async () => {
    // Free run is 18:30 (gym ends) → 22:00 = 3.5h. Capped at 120 → 20:00–22:00.
    const { diff } = await block({ until_time: '22:00', max_minutes: 120 });
    expect(diff.changes[0]!.after).toEqual({ starts_at: '2026-09-08T20:00', ends_at: '2026-09-08T22:00' });
  });

  test('a cap larger than the free run leaves it untouched', async () => {
    const { diff } = await block({ until_time: '22:00', max_minutes: 600 });
    // Still the whole 18:30–22:00 run.
    expect(diff.changes[0]!.after).toEqual({ starts_at: '2026-09-08T18:30', ends_at: '2026-09-08T22:00' });
  });
});

describe('the free run before something', () => {
  test('"everything before my 10pm plans" = after the last commitment, up to 10pm', async () => {
    const { diff, conflicts } = await block({ until_time: '22:00' });

    expect(conflicts.some((c) => c.type === 'wrong_event')).toBe(false);
    const ch = diff.changes[0]!;
    // Gym ends 18:30; friends are at 22:00. The free run is 18:30 → 22:00.
    expect(ch.after).toEqual({ starts_at: '2026-09-08T18:30', ends_at: '2026-09-08T22:00' });
    expect(ch.title).toBe('Study');

    // And it is really on the calendar, between the gym and the friends.
    const day = getInstances(db, '2026-09-08', '2026-09-08');
    expect(day.map((i) => `${i.starts_at.slice(11)} ${i.title}`)).toEqual([
      '10:00 CS 429',
      '17:00 Gym',
      '18:30 Study',
      '22:00 Friends coming over',
    ]);
  });

  test('anchored to an EVENT rather than a clock time', async () => {
    const { diff } = await block({ until_event_id: 'evt-friends', expect_title: 'Friends coming over' });
    expect(diff.changes[0]!.after).toEqual({ starts_at: '2026-09-08T18:30', ends_at: '2026-09-08T22:00' });
  });

  test('the anchor id must be the event it says it is — same guard as everywhere else', async () => {
    const before = db.select().from(schema.event).all().length;
    const { conflicts, diff } = await block({ until_event_id: 'evt-gym', expect_title: 'Friends coming over' });

    expect(conflicts.some((c) => c.type === 'wrong_event')).toBe(true);
    expect(diff.changes).toHaveLength(0);
    expect(db.select().from(schema.event).all().length).toBe(before);
  });

  test('after_time wins when Sai names one', async () => {
    const { diff } = await block({ until_time: '22:00', after_time: '20:00' });
    expect(diff.changes[0]!.after!.starts_at).toBe('2026-09-08T20:00');
  });

  test('a gap too small to be worth blocking is refused, not created', async () => {
    const before = db.select().from(schema.event).all().length;
    // Gym ends 18:30 — only 20 minutes before an 18:50 anchor.
    const { conflicts, diff } = await block({ until_time: '18:50' });

    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'no_gap')).toBe(true);
    expect(diff.changes).toHaveLength(0);
    expect(db.select().from(schema.event).all().length).toBe(before);
  });

  test('an anchor INSIDE an event is refused — it must never book over the class', async () => {
    // The class runs 10:00–11:30. Nothing "ends before 11:00", and the naive
    // reading of that is an empty morning: it would book Study 07:00–11:00,
    // straight through CS 429.
    const before = db.select().from(schema.event).all().length;
    const { conflicts, diff } = await block({ until_time: '11:00' });

    const c = conflicts.find((k) => k.type === 'constraint' && k.rule === 'no_gap');
    expect(c).toBeDefined();
    expect(c!.type === 'constraint' && c!.message).toContain('busy right up to it');
    expect(diff.changes).toHaveLength(0);
    expect(db.select().from(schema.event).all().length).toBe(before);
  });

  test('dry run writes nothing', async () => {
    const before = db.select().from(schema.event).all().length;
    const { diff } = await block({ until_time: '22:00' }, 'dry');
    expect(diff.changes).toHaveLength(1);
    expect(db.select().from(schema.event).all().length).toBe(before);
  });

  test('the block never starts inside protected sleep hours', async () => {
    // Nothing on Wednesday at all → the run would otherwise start at midnight.
    const { diff } = await blockFreeTimeTool.run(
      { date: '2026-09-09', title: 'Study', kind: 'personal', until_time: '09:00', min_minutes: 30 } as never,
      'dry',
    );
    // sleep protect is 00:00–07:00, so it starts at 07:00, not 00:00.
    expect(diff.changes[0]!.after!.starts_at).toBe('2026-09-09T07:00');
  });

  test('an anchor with something already butted against it is refused', async () => {
    // Friends run 22:00–23:00. There is no free run that ENDS at 23:00 — he is
    // busy right up to it — so blocking 18:30–23:00 would swallow them.
    const { conflicts, diff } = await block({ until_time: '23:00' }, 'dry');
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'no_gap')).toBe(true);
    expect(diff.changes).toHaveLength(0);
  });
});
