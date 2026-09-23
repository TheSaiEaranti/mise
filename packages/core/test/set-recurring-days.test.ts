/**
 * set_recurring_days — "gym only Mon/Tue/Wed, no weekends" in one call. The
 * whole reshape at once, across every week: drop the days you don't want, add
 * the ones you do, keep the ones already right.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { setRecurringDaysTool } from '../src/tools/set-recurring-days';
import { getInstances } from '../src/schedule';
import { weekdayCode } from '../src/time';
import { isUndoable } from '../src/undo';
import { severityOf } from '../src/types';

process.env.MISE_SETTINGS_PATH = '/nonexistent/settings.json';

let db: DB;

// A 4-week semester starting Mon 2026-09-07. Gym as one-off rows on Mon, Tue,
// Thu, Sat each week (the way the seed stores it) at 17:00–18:00.
beforeEach(() => {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'Fall', start_date: '2026-09-07', end_date: '2026-10-04', timezone: 'America/Chicago' })
    .run();
  const gymWeekdays = [0, 1, 3, 5]; // Mon Tue Thu Sat
  const mondays = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'];
  let n = 0;
  const rows: (typeof schema.event.$inferInsert)[] = [];
  const addDays = (d: string, k: number) => {
    const dt = new Date(d + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + k);
    return dt.toISOString().slice(0, 10);
  };
  for (const mon of mondays) {
    for (const off of gymWeekdays) {
      const date = addDays(mon, off);
      rows.push({
        id: `gym-${n++}`, semester_id: 's1', title: 'Gym', kind: 'gym',
        starts_at: `${date}T17:00`, ends_at: `${date}T18:00`,
        pinned: false, rrule: null, source: 'manual', location: 'Gregory', notes: null, color: null, workout: 'chest-back',
      });
    }
  }
  db.insert(schema.event).values(rows).run();
});

const reshape = (over: Record<string, unknown> = {}, mode: 'dry' | 'commit' = 'commit') =>
  setRecurringDaysTool.run(
    { event_id: 'gym-0', expect_title: 'Gym', days: ['MO', 'TU', 'WE'], ...over } as never,
    mode,
  );

const gymDays = () =>
  getInstances(db, '2026-09-07', '2026-10-04')
    .filter((i) => i.title === 'Gym')
    .map((i) => weekdayCode(i.instance_date));

describe('reshaping the gym cluster to Mon/Tue/Wed', () => {
  test('every week ends up exactly Mon/Tue/Wed — no weekends, Tuesday not dropped', async () => {
    // Fake "today" is 2026-07-15 (before the semester), so nothing is in the past.
    const { conflicts } = await reshape();
    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);

    const days = gymDays();
    // Only Mon/Tue/Wed remain, and they appear across all 4 weeks.
    expect(new Set(days)).toEqual(new Set(['MO', 'TU', 'WE']));
    expect(days.filter((d) => d === 'TU').length).toBe(4); // Tuesday kept every week
    expect(days.filter((d) => d === 'WE').length).toBe(4); // Wednesday added every week
    expect(days.some((d) => d === 'SA' || d === 'SU')).toBe(false); // weekends gone
    expect(days.length).toBe(12); // 3 days × 4 weeks
  });

  test('kept blocks are untouched, new blocks copy the time/location', async () => {
    await reshape();
    const wed = getInstances(db, '2026-09-09', '2026-09-09').find((i) => i.title === 'Gym')!;
    expect(wed.starts_at.slice(11)).toBe('17:00');
    expect(wed.ends_at.slice(11)).toBe('18:00');
    expect(wed.location).toBe('Gregory');
  });

  test('the diff summarizes the reshape', async () => {
    const { diff } = await reshape({}, 'dry');
    expect(diff.summary).toBe('Gym → Mon/Tue/Wed');
    expect(diff.detail).toContain('dropped');
  });
});

describe('guards and edge cases', () => {
  test('wrong title is refused', async () => {
    const { conflicts } = await reshape({ expect_title: 'Cook' });
    expect(conflicts.some((c) => c.type === 'wrong_event')).toBe(true);
  });

  test('a pinned event (class) is refused', async () => {
    db.insert(schema.event)
      .values({
        id: 'cls', semester_id: 's1', title: 'CS 429', kind: 'class',
        starts_at: '2026-09-08T10:00', ends_at: '2026-09-08T11:30',
        pinned: true, rrule: 'FREQ=WEEKLY;BYDAY=TU', source: 'recurring', location: 'GDC', notes: null, color: null, workout: null,
      })
      .run();
    const { conflicts } = await setRecurringDaysTool.run(
      { event_id: 'cls', expect_title: 'CS 429', days: ['MO', 'WE'] } as never,
      'commit',
    );
    expect(conflicts.some((c) => c.type === 'pinned_moved')).toBe(true);
  });

  test('reshaping to the days it is already on is a no-op', async () => {
    const { conflicts } = await reshape({ days: ['MO', 'TU', 'TH', 'SA'] });
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'already')).toBe(true);
  });

  test('it is undoable', () => {
    expect(isUndoable({ tool_name: 'set_recurring_days', status: 'approved' })).toBe(true);
  });
});
