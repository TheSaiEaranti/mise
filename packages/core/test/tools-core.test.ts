/**
 * Core mutation tools: shift_events, create_event, cancel_event.
 *
 * Fixture week: Mon 2026-07-13 … Sun 2026-07-19 (Tue Jul 14, Wed Jul 15…).
 * Seeded: a pinned recurring class (TU/TH 14:00), a recurring gym (MO/WE/FR
 * 07:00), a standalone gym + cook on Tue Jul 14.
 *
 * The invariants under test: dry mode never writes (I1/I2), tools compute all
 * timestamps from intent (I3), pinned events never move (I4), and a rejected
 * validation is a no-op, never a partial write.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { getInstances } from '../src/schedule';
import { severityOf, type Conflict } from '../src/types';
import { shiftEventsTool } from '../src/tools/shift-events';
import { createEventTool } from '../src/tools/create-event';
import { cancelEventTool } from '../src/tools/cancel-event';

let db: DB;

function seedBase(d: DB): void {
  d.insert(schema.semester)
    .values({
      id: 'sem1',
      name: 'Fall 2026',
      start_date: '2026-07-01',
      end_date: '2026-12-18',
      timezone: 'America/Chicago',
    })
    .run();
  d.insert(schema.event)
    .values([
      {
        id: 'cs429',
        semester_id: 'sem1',
        title: 'CS 429',
        kind: 'class',
        starts_at: '2026-07-14T14:00',
        ends_at: '2026-07-14T15:00',
        pinned: true,
        rrule: 'FREQ=WEEKLY;BYDAY=TU,TH',
        source: 'recurring',
        location: 'GDC',
        notes: null,
      },
      {
        id: 'rgym',
        semester_id: 'sem1',
        title: 'Lift',
        kind: 'gym',
        starts_at: '2026-07-13T07:00',
        ends_at: '2026-07-13T08:30',
        pinned: false,
        rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
        source: 'recurring',
        location: null,
        notes: null,
        workout: 'legs',
      },
      {
        id: 'gym1',
        semester_id: 'sem1',
        title: 'Gym',
        kind: 'gym',
        starts_at: '2026-07-14T16:00',
        ends_at: '2026-07-14T17:30',
        pinned: false,
        rrule: null,
        source: 'manual',
        location: null,
        notes: null,
      },
      {
        id: 'cook1',
        semester_id: 'sem1',
        title: 'Cook lunches',
        kind: 'cook',
        starts_at: '2026-07-14T18:30',
        ends_at: '2026-07-14T19:30',
        pinned: false,
        rrule: null,
        source: 'manual',
        location: null,
        notes: null,
      },
    ])
    .run();
}

function counts(d: DB): { events: number; exceptions: number } {
  return {
    events: d.select().from(schema.event).all().length,
    exceptions: d.select().from(schema.eventException).all().length,
  };
}

const blocking = (cs: Conflict[]) => cs.filter((c) => severityOf(c) === 'blocking');
const ofRule = (cs: Conflict[], rule: string) =>
  cs.filter((c) => c.type === 'constraint' && c.rule === rule);

beforeEach(() => {
  db = resetDbForTests();
  seedBase(db);
});

// ---------------------------------------------------------------------------
// shift_events
// ---------------------------------------------------------------------------

describe('shift_events', () => {
  test('dry mode makes no DB writes', async () => {
    const before = counts(db);
    await shiftEventsTool.run({ scope: 'day', date: '2026-07-14', delta_minutes: 60 }, 'dry');
    await shiftEventsTool.run(
      { scope: 'single', date: '2026-07-15', event_id: 'rgym', delta_minutes: 30 },
      'dry',
    );
    expect(counts(db)).toEqual(before);
  });

  test('day +60 after 15:00: gym+cook move, pinned class untouched (definition of done)', async () => {
    const res = await shiftEventsTool.run(
      { scope: 'day', date: '2026-07-14', delta_minutes: 60, after_time: '15:00' },
      'dry',
    );

    expect(res.diff.summary).toBe('Shift Tuesday · +60 min');
    expect(res.diff.detail).toBe('Everything after 3 PM, +1 hour');

    const byId = new Map(res.diff.changes.map((c) => [c.event_id, c]));
    expect(res.diff.changes).toHaveLength(2);
    expect(byId.get('gym1')?.after).toEqual({ starts_at: '2026-07-14T17:00', ends_at: '2026-07-14T18:30' });
    expect(byId.get('cook1')?.after).toEqual({ starts_at: '2026-07-14T19:30', ends_at: '2026-07-14T20:30' });
    expect(byId.has('cs429')).toBe(false);

    expect(res.diff.unchanged_pinned.map((p) => p.event_id)).toContain('cs429');
    expect(blocking(res.conflicts)).toHaveLength(0);

    // Approve: commit updates the standalone rows in place, CS 429 stays put.
    await shiftEventsTool.run(
      { scope: 'day', date: '2026-07-14', delta_minutes: 60, after_time: '15:00' },
      'commit',
    );
    const day = getInstances(db, '2026-07-14', '2026-07-14');
    const at = (id: string) => day.find((i) => i.event_id === id)!;
    expect(at('gym1').starts_at).toBe('2026-07-14T17:00');
    expect(at('cook1').starts_at).toBe('2026-07-14T19:30');
    expect(at('cs429').starts_at).toBe('2026-07-14T14:00');
    expect(counts(db)).toEqual({ events: 4, exceptions: 0 }); // in-place updates only
  });

  test('single recurring instance commit → exception + override row; other weeks unchanged', async () => {
    const before = counts(db);
    const res = await shiftEventsTool.run(
      { scope: 'single', date: '2026-07-15', event_id: 'rgym', delta_minutes: 30 },
      'commit',
    );
    expect(blocking(res.conflicts)).toHaveLength(0);
    expect(counts(db)).toEqual({ events: before.events + 1, exceptions: before.exceptions + 1 });

    const exc = db.select().from(schema.eventException).all()[0]!;
    expect(exc.event_id).toBe('rgym');
    expect(exc.original_date).toBe('2026-07-15');
    expect(exc.status).toBe('moved');
    expect(exc.override_event_id).not.toBeNull();

    const override = db.select().from(schema.event).all().find((e) => e.id === exc.override_event_id)!;
    expect(override.starts_at).toBe('2026-07-15T07:30');
    expect(override.ends_at).toBe('2026-07-15T09:00');
    expect(override.rrule).toBeNull();
    expect(override.source).toBe('agent');
    expect(override.title).toBe('Lift');
    expect(override.kind).toBe('gym');
    // Regression: a shifted recurring gym must keep its workout label on the
    // override row — set_event_time copied it, shift_events used to drop it.
    expect(override.workout).toBe('legs');

    // This week: Mon + Fri at 07:00, Wed instance now at 07:30 (the override).
    const week = getInstances(db, '2026-07-13', '2026-07-17').filter((i) => i.title === 'Lift');
    expect(week.map((i) => i.starts_at)).toEqual([
      '2026-07-13T07:00',
      '2026-07-15T07:30',
      '2026-07-17T07:00',
    ]);
    // Next week untouched.
    const nextWed = getInstances(db, '2026-07-22', '2026-07-22').filter((i) => i.title === 'Lift');
    expect(nextWed.map((i) => i.starts_at)).toEqual(['2026-07-22T07:00']);
  });

  test('kinds filter only moves those kinds', async () => {
    const res = await shiftEventsTool.run(
      { scope: 'day', date: '2026-07-14', delta_minutes: -30, kinds: ['gym'] },
      'dry',
    );
    expect(res.diff.changes.map((c) => c.event_id)).toEqual(['gym1']);
    expect(res.diff.changes[0]!.after).toEqual({
      starts_at: '2026-07-14T15:30',
      ends_at: '2026-07-14T17:00',
    });
  });

  test('empty selection → "Nothing to shift", no conflicts', async () => {
    const res = await shiftEventsTool.run({ scope: 'day', date: '2026-07-19', delta_minutes: 60 }, 'dry');
    expect(res.diff.summary).toBe('Nothing to shift');
    expect(res.diff.changes).toHaveLength(0);
    expect(res.conflicts).toHaveLength(0);
  });

  test('commit of a vanished single target → stale conflict, no writes', async () => {
    const before = counts(db);
    const res = await shiftEventsTool.run(
      { scope: 'single', date: '2026-07-14', event_id: 'gone', delta_minutes: 60 },
      'commit',
    );
    expect(ofRule(res.conflicts, 'stale')).toHaveLength(1);
    expect(res.diff.changes).toHaveLength(0);
    expect(counts(db)).toEqual(before);
  });

  test('zod schema rejects delta_minutes 0 and |delta| > one week', () => {
    const base = { scope: 'day' as const, date: '2026-07-14' };
    expect(shiftEventsTool.argsSchema.safeParse({ ...base, delta_minutes: 0 }).success).toBe(false);
    expect(shiftEventsTool.argsSchema.safeParse({ ...base, delta_minutes: 10081 }).success).toBe(false);
    expect(shiftEventsTool.argsSchema.safeParse({ ...base, delta_minutes: -10081 }).success).toBe(false);
    expect(shiftEventsTool.argsSchema.safeParse({ ...base, delta_minutes: 90 }).success).toBe(true);
    // Cross-day drags are expressed as deltas too: Tue 17:00 → Thu 18:00.
    expect(shiftEventsTool.argsSchema.safeParse({ ...base, delta_minutes: 2940 }).success).toBe(true);
    // Cross-field requirements.
    expect(
      shiftEventsTool.argsSchema.safeParse({ scope: 'range', date: '2026-07-14', delta_minutes: 60 }).success,
    ).toBe(false);
    expect(
      shiftEventsTool.argsSchema.safeParse({ scope: 'single', date: '2026-07-14', delta_minutes: 60 }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// create_event
// ---------------------------------------------------------------------------

describe('create_event', () => {
  test('dry composes timestamps from date + HH:mm + duration and writes nothing', async () => {
    const before = counts(db);
    const res = await createEventTool.run(
      { title: 'Run', kind: 'gym', date: '2026-07-16', start_time: '06:30', duration_minutes: 60 },
      'dry',
    );
    expect(res.diff.changes).toHaveLength(1);
    expect(res.diff.changes[0]!.before).toBeNull();
    expect(res.diff.changes[0]!.after).toEqual({
      starts_at: '2026-07-16T06:30',
      ends_at: '2026-07-16T07:30',
    });
    expect(blocking(res.conflicts)).toHaveLength(0);
    expect(counts(db)).toEqual(before);
  });

  test('commit inserts the row (source agent, pinned false)', async () => {
    const before = counts(db);
    await createEventTool.run(
      {
        title: 'Run',
        kind: 'gym',
        date: '2026-07-16',
        start_time: '06:30',
        duration_minutes: 60,
        location: 'Gregory',
      },
      'commit',
    );
    expect(counts(db).events).toBe(before.events + 1);
    const row = db.select().from(schema.event).all().find((e) => e.title === 'Run')!;
    expect(row.starts_at).toBe('2026-07-16T06:30');
    expect(row.ends_at).toBe('2026-07-16T07:30');
    expect(row.source).toBe('agent');
    expect(row.pinned).toBe(false);
    expect(row.rrule).toBeNull();
    expect(row.location).toBe('Gregory');
  });

  test('a create on top of something movable pushes it later instead of overlapping', async () => {
    // Call 16:30–17:30 lands on the gym (16:00–17:30). The gym gives way to
    // 17:30–19:00, which now hits the cook session, so that moves too — the
    // whole afternoon shuffles down and nothing ends up double-booked.
    const res = await createEventTool.run(
      { title: 'Call', kind: 'personal', date: '2026-07-14', start_time: '16:30', duration_minutes: 60 },
      'dry',
    );

    expect(res.conflicts.filter((c) => c.type === 'overlap')).toHaveLength(0);
    expect(res.conflicts.every((c) => severityOf(c) === 'warning')).toBe(true);

    const byId = new Map(res.diff.changes.map((c) => [c.event_id, c]));
    expect(byId.get('gym1')?.after).toEqual({ starts_at: '2026-07-14T17:30', ends_at: '2026-07-14T19:00' });
    expect(byId.get('cook1')?.after).toEqual({ starts_at: '2026-07-14T19:00', ends_at: '2026-07-14T20:00' });
    expect(res.diff.detail).toContain('2 moved to make room');
  });

  test('create inside the protected sleep window warns', async () => {
    const res = await createEventTool.run(
      { title: 'Early thing', kind: 'personal', date: '2026-07-16', start_time: '06:00', duration_minutes: 30 },
      'dry',
    );
    expect(ofRule(res.conflicts, 'sleep')).toHaveLength(1);
  });

  test('no semester → no_semester conflict, no changes, no writes', async () => {
    db = resetDbForTests(); // empty DB, no semester
    const res = await createEventTool.run(
      { title: 'Run', kind: 'gym', date: '2026-07-16', start_time: '06:30', duration_minutes: 60 },
      'commit',
    );
    expect(ofRule(res.conflicts, 'no_semester')).toHaveLength(1);
    expect(res.diff.changes).toHaveLength(0);
    expect(counts(db).events).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cancel_event
// ---------------------------------------------------------------------------

describe('cancel_event', () => {
  test('dry writes nothing; standalone commit deletes the row', async () => {
    const before = counts(db);
    const dry = await cancelEventTool.run({ event_id: 'gym1', expect_title: 'Gym' }, 'dry');
    expect(dry.diff.changes).toHaveLength(1);
    expect(dry.diff.changes[0]!.before).toEqual({
      starts_at: '2026-07-14T16:00',
      ends_at: '2026-07-14T17:30',
    });
    expect(dry.diff.changes[0]!.after).toBeNull();
    expect(dry.diff.summary).toBe('Cancel Gym · Tue Jul 14');
    expect(counts(db)).toEqual(before);

    await cancelEventTool.run({ event_id: 'gym1', expect_title: 'Gym' }, 'commit');
    expect(counts(db)).toEqual({ events: before.events - 1, exceptions: 0 });
    expect(db.select().from(schema.event).all().find((e) => e.id === 'gym1')).toBeUndefined();
  });

  test('recurring instance commit adds a cancelled exception', async () => {
    await cancelEventTool.run({ event_id: 'rgym', expect_title: 'Lift', date: '2026-07-17' }, 'commit');
    const exc = db.select().from(schema.eventException).all();
    expect(exc).toHaveLength(1);
    expect(exc[0]).toMatchObject({
      event_id: 'rgym',
      original_date: '2026-07-17',
      status: 'cancelled',
      override_event_id: null,
    });
    const week = getInstances(db, '2026-07-13', '2026-07-19').filter((i) => i.title === 'Lift');
    expect(week.map((i) => i.instance_date)).toEqual(['2026-07-13', '2026-07-15']); // Friday gone
  });

  test('recurring event without a date → missing_date, no changes', async () => {
    const res = await cancelEventTool.run({ event_id: 'rgym', expect_title: 'Lift' }, 'dry');
    expect(ofRule(res.conflicts, 'missing_date')).toHaveLength(1);
    expect(res.diff.changes).toHaveLength(0);
  });

  test('cancel pinned → blocking pinned_moved surfaced, commit refuses to write', async () => {
    const dry = await cancelEventTool.run({ event_id: 'cs429', expect_title: 'CS 429', date: '2026-07-14' }, 'dry');
    // The change is built (not silently skipped) so the refusal is visible.
    expect(dry.diff.changes).toHaveLength(1);
    expect(dry.diff.changes[0]!.after).toBeNull();
    const pinned = dry.conflicts.filter((c) => c.type === 'pinned_moved');
    expect(pinned).toHaveLength(1);
    expect(blocking(dry.conflicts).length).toBeGreaterThan(0);

    const before = counts(db);
    const commit = await cancelEventTool.run({ event_id: 'cs429', expect_title: 'CS 429', date: '2026-07-14' }, 'commit');
    expect(commit.conflicts.filter((c) => c.type === 'pinned_moved')).toHaveLength(1);
    expect(counts(db)).toEqual(before); // no exception row, nothing deleted
    expect(getInstances(db, '2026-07-14', '2026-07-14').find((i) => i.event_id === 'cs429')).toBeDefined();
  });

  test('cancelled event id → stale conflict, no writes', async () => {
    const before = counts(db);
    const res = await cancelEventTool.run({ event_id: 'gone', expect_title: 'Gone' }, 'commit');
    expect(ofRule(res.conflicts, 'stale')).toHaveLength(1);
    expect(res.diff.changes).toHaveLength(0);
    expect(counts(db)).toEqual(before);
  });

  test('cancel a cook session → clean cancel, nothing blocks', async () => {
    const dry = await cancelEventTool.run({ event_id: 'cook1', expect_title: 'Cook lunches', reason: 'busy' }, 'dry');
    expect(blocking(dry.conflicts)).toHaveLength(0);

    const before = counts(db);
    await cancelEventTool.run({ event_id: 'cook1', expect_title: 'Cook lunches', reason: 'busy' }, 'commit');
    expect(counts(db).events).toBe(before.events - 1);
    expect(db.select().from(schema.event).all().find((e) => e.id === 'cook1')).toBeUndefined();
  });
});
