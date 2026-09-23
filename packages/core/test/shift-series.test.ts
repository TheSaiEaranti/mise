/**
 * shift_events scope 'series' — dragging a REPEATING block moves the whole
 * series and STICKS across weeks, instead of leaving a one-week override that
 * reverts (the "my manual move didn't record" bug).
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { shiftEventsTool } from '../src/tools/shift-events';
import { getInstances } from '../src/schedule';
import { severityOf } from '../src/types';

process.env.MISE_SETTINGS_PATH = '/nonexistent/settings.json';

let db: DB;

// A recurring Mon/Wed breakfast at 10:00, from Mon 2026-09-07.
beforeEach(() => {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'Fall', start_date: '2026-09-07', end_date: '2026-12-31', timezone: 'America/Chicago' })
    .run();
  db.insert(schema.event)
    .values({
      id: 'bfast', semester_id: 's1', title: 'Breakfast', kind: 'personal',
      starts_at: '2026-09-07T10:00', ends_at: '2026-09-07T10:30',
      pinned: false, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=1;UNTIL=20261231', source: 'recurring',
      location: null, notes: null, color: null, workout: null,
    })
    .run();
});

const bfastAt = (date: string) => getInstances(db, date, date).find((i) => i.title === 'Breakfast');

describe('scope series', () => {
  test('a series move sticks EVERY week (not just the dragged one)', async () => {
    // Drag the 09-07 breakfast +30 min (10:00 → 10:30).
    const { conflicts } = await shiftEventsTool.run(
      { scope: 'series', event_id: 'bfast', expect_title: 'Breakfast', date: '2026-09-07', delta_minutes: 30 } as never,
      'commit',
    );
    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);
    // this week AND future weeks are at 10:30 — no revert
    expect(bfastAt('2026-09-07')?.starts_at).toBe('2026-09-07T10:30');
    expect(bfastAt('2026-09-09')?.starts_at).toBe('2026-09-09T10:30'); // same week Wed
    expect(bfastAt('2026-09-14')?.starts_at).toBe('2026-09-14T10:30'); // NEXT week Mon
    expect(bfastAt('2026-09-21')?.starts_at).toBe('2026-09-21T10:30'); // week after
    // the base row itself moved (no per-week override left behind)
    const rows = db.select().from(schema.event).all().filter((e) => e.title === 'Breakfast');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.starts_at).toBe('2026-09-07T10:30');
  });

  test('contrast: scope single only moves the one week (the old behavior)', async () => {
    await shiftEventsTool.run(
      { scope: 'single', event_id: 'bfast', expect_title: 'Breakfast', date: '2026-09-07', delta_minutes: 30 } as never,
      'commit',
    );
    expect(bfastAt('2026-09-07')?.starts_at).toBe('2026-09-07T10:30'); // this week moved
    expect(bfastAt('2026-09-14')?.starts_at).toBe('2026-09-14T10:00'); // next week UNCHANGED
  });

  test('a series move clears an existing one-week override so all follow', async () => {
    // First a single-instance drag creates a 10:30 override on 09-07.
    await shiftEventsTool.run(
      { scope: 'single', event_id: 'bfast', expect_title: 'Breakfast', date: '2026-09-07', delta_minutes: 30 } as never,
      'commit',
    );
    const override = getInstances(db, '2026-09-07', '2026-09-07').find((i) => i.title === 'Breakfast')!;
    // Now drag THAT override +30 as a series → whole series to 11:00, override gone.
    await shiftEventsTool.run(
      { scope: 'series', event_id: override.event_id, expect_title: 'Breakfast', date: '2026-09-07', delta_minutes: 30 } as never,
      'commit',
    );
    expect(bfastAt('2026-09-07')?.starts_at).toBe('2026-09-07T11:00');
    expect(bfastAt('2026-09-14')?.starts_at).toBe('2026-09-14T11:00');
    const rows = db.select().from(schema.event).all().filter((e) => e.title === 'Breakfast');
    expect(rows).toHaveLength(1); // the override row was removed
    const excs = db.select().from(schema.eventException).where(eq(schema.eventException.event_id, 'bfast')).all();
    expect(excs).toHaveLength(0);
  });

  test('wrong title is refused', async () => {
    const { conflicts } = await shiftEventsTool.run(
      { scope: 'series', event_id: 'bfast', expect_title: 'Gym', date: '2026-09-07', delta_minutes: 30 } as never,
      'commit',
    );
    expect(conflicts.some((c) => c.type === 'wrong_event')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-day series drags. A drag encodes day moves in delta_minutes (Tue →
// Wed is +1440); for scope 'series' that must move the PATTERN — base anchor
// date AND every BYDAY weekday — not just the time of day. (The bug: only
// timeOf() was kept, so a pure day-drag was a silent no-op that snapped back.)
// ---------------------------------------------------------------------------

describe('scope series, cross-day drag', () => {
  test('dragging Mon +1 day moves the whole series to Tue/Thu, same time', async () => {
    const { conflicts } = await shiftEventsTool.run(
      { scope: 'series', event_id: 'bfast', expect_title: 'Breakfast', date: '2026-09-07', delta_minutes: 1440 } as never,
      'commit',
    );
    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);
    expect(bfastAt('2026-09-07')).toBeUndefined(); // Monday no longer has it
    expect(bfastAt('2026-09-08')?.starts_at).toBe('2026-09-08T10:00'); // Tue
    expect(bfastAt('2026-09-10')?.starts_at).toBe('2026-09-10T10:00'); // Thu (was Wed)
    expect(bfastAt('2026-09-15')?.starts_at).toBe('2026-09-15T10:00'); // next week Tue
    const row = db.select().from(schema.event).where(eq(schema.event.id, 'bfast')).get()!;
    expect(row.rrule).toContain('BYDAY=TU,TH');
    expect(row.starts_at).toBe('2026-09-08T10:00'); // anchor date moved with it
  });

  test('day + time drag combine (+1 day +30 min); backwards drag rotates the other way', async () => {
    await shiftEventsTool.run(
      { scope: 'series', event_id: 'bfast', expect_title: 'Breakfast', date: '2026-09-09', delta_minutes: 1470 } as never,
      'commit',
    );
    expect(bfastAt('2026-09-10')?.starts_at).toBe('2026-09-10T10:30'); // Wed → Thu 10:30
    expect(bfastAt('2026-09-08')?.starts_at).toBe('2026-09-08T10:30'); // Mon → Tue too

    // Now drag the Thursday one back a day: Tue/Thu → Mon/Wed.
    await shiftEventsTool.run(
      { scope: 'series', event_id: 'bfast', expect_title: 'Breakfast', date: '2026-09-10', delta_minutes: -1440 } as never,
      'commit',
    );
    const row = db.select().from(schema.event).where(eq(schema.event.id, 'bfast')).get()!;
    expect(row.rrule).toContain('BYDAY=MO,WE');
    expect(bfastAt('2026-09-14')?.starts_at).toBe('2026-09-14T10:30'); // next Mon, keeps 10:30
  });

  test('a DAILY-interval series (no BYDAY) re-phases by the day drag', async () => {
    db.insert(schema.event)
      .values({
        id: 'cook', semester_id: 's1', title: 'Cook lunches', kind: 'cook',
        starts_at: '2026-09-07T18:00', ends_at: '2026-09-07T19:00',
        pinned: false, rrule: 'FREQ=DAILY;INTERVAL=3;UNTIL=20261231', source: 'recurring',
        location: null, notes: null, color: null, workout: null,
      })
      .run();
    // Occurrences: Sep 7, 10, 13… Drag the Sep 10 one +1 day → Sep 8, 11, 14…
    await shiftEventsTool.run(
      { scope: 'series', event_id: 'cook', expect_title: 'Cook lunches', date: '2026-09-10', delta_minutes: 1440 } as never,
      'commit',
    );
    const cookAt = (d: string) => getInstances(db, d, d).find((i) => i.title === 'Cook lunches');
    expect(cookAt('2026-09-10')).toBeUndefined();
    expect(cookAt('2026-09-08')?.starts_at).toBe('2026-09-08T18:00');
    expect(cookAt('2026-09-11')?.starts_at).toBe('2026-09-11T18:00');
    const row = db.select().from(schema.event).where(eq(schema.event.id, 'cook')).get()!;
    expect(row.rrule).toBe('FREQ=DAILY;INTERVAL=3;UNTIL=20261231'); // rule untouched — the anchor date carries the phase
  });
});
