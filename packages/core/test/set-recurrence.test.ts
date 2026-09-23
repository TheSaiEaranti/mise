/**
 * set_recurrence — "make cook every third day". Re-cadences the existing
 * same-titled cluster to an every-N-days grid IN PLACE (no duplicate series),
 * dedupes days that had two cooks, and unifies the time. This is the fix for the
 * bug where "every third day" created a second cook on top of the old one.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { setRecurrenceTool } from '../src/tools/set-recurrence';
import { getInstances } from '../src/schedule';
import { isUndoable } from '../src/undo';
import { severityOf } from '../src/types';

process.env.MISE_SETTINGS_PATH = '/nonexistent/settings.json';

let db: DB;

// Semester Mon 2026-09-07 .. Sun 2026-10-04. "Today" (2026-07-16) is before it,
// so nothing is in the past. Cook is a recurring MWF series at 6:45-7:45 PM,
// PLUS a stray every-3-days duplicate at 7:45 PM (the exact bug shape).
beforeEach(() => {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'Fall', start_date: '2026-09-07', end_date: '2026-10-04', timezone: 'America/Chicago' })
    .run();
  db.insert(schema.event)
    .values([
      {
        id: 'cook-mwf', semester_id: 's1', title: 'Cook lunches', kind: 'cook',
        starts_at: '2026-09-07T18:45', ends_at: '2026-09-07T19:45',
        pinned: false, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261004', source: 'recurring',
        location: null, notes: null, color: null, workout: null,
      },
      {
        id: 'cook-dup', semester_id: 's1', title: 'Cook lunches', kind: 'cook',
        starts_at: '2026-09-10T19:45', ends_at: '2026-09-10T20:45',
        pinned: false, rrule: 'FREQ=DAILY;INTERVAL=3;UNTIL=20261004', source: 'agent',
        location: null, notes: null, color: null, workout: null,
      },
    ])
    .run();
});

const cookInstances = () =>
  getInstances(db, '2026-09-07', '2026-10-04')
    .filter((i) => i.title === 'Cook lunches')
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));

const recur = (over: Record<string, unknown> = {}, mode: 'dry' | 'commit' = 'commit') =>
  setRecurrenceTool.run(
    { event_id: 'cook-mwf', expect_title: 'Cook lunches', interval_days: 3, ...over } as never,
    mode,
  );

describe('re-cadencing cook to every 3 days', () => {
  test('lands exactly on the every-3-days grid, one per day, no duplicates', async () => {
    const { conflicts } = await recur();
    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);

    const cooks = cookInstances();
    const dates = cooks.map((i) => i.instance_date);
    // From 09-07 every 3 days through 10-04.
    expect(dates).toEqual([
      '2026-09-07', '2026-09-10', '2026-09-13', '2026-09-16', '2026-09-19',
      '2026-09-22', '2026-09-25', '2026-09-28', '2026-10-01', '2026-10-04',
    ]);
    // Exactly one per date (the 09-10 duplicate was deduped).
    expect(new Set(dates).size).toBe(dates.length);
  });

  test('every occurrence is at one uniform time (the original 6:45 PM)', async () => {
    await recur();
    const times = new Set(cookInstances().map((i) => i.starts_at.slice(11)));
    expect(times).toEqual(new Set(['18:45'])); // the 7:45 duplicate time is gone
  });

  test('honors an explicit time + start_date', async () => {
    await recur({ interval_days: 3, start_date: '2026-09-08', time: '12:00' });
    const cooks = cookInstances();
    expect(cooks[0]!.instance_date).toBe('2026-09-08');
    expect(cooks[0]!.starts_at.slice(11)).toBe('12:00');
    expect(cooks[1]!.instance_date).toBe('2026-09-11'); // +3 days
  });

  test('the diff names the new cadence', async () => {
    const { diff } = await recur({}, 'dry');
    expect(diff.summary).toBe('Cook lunches → every 3 days');
  });
});

describe('guards', () => {
  test('wrong title is refused', async () => {
    const { conflicts } = await recur({ expect_title: 'Gym' });
    expect(conflicts.some((c) => c.type === 'wrong_event')).toBe(true);
  });

  test('a pinned event is refused', async () => {
    db.insert(schema.event)
      .values({
        id: 'cls', semester_id: 's1', title: 'CS 429', kind: 'class',
        starts_at: '2026-09-08T10:00', ends_at: '2026-09-08T11:30',
        pinned: true, rrule: 'FREQ=WEEKLY;BYDAY=TU', source: 'recurring', location: 'GDC', notes: null, color: null, workout: null,
      })
      .run();
    const { conflicts } = await setRecurrenceTool.run(
      { event_id: 'cls', expect_title: 'CS 429', interval_days: 2 } as never,
      'commit',
    );
    expect(conflicts.some((c) => c.type === 'pinned_moved')).toBe(true);
  });

  test('it is undoable', () => {
    expect(isUndoable({ tool_name: 'set_recurrence', status: 'approved' })).toBe(true);
  });
});
