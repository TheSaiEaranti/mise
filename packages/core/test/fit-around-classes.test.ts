/**
 * fit_around_classes — "fit cook between my classes or before a class." On each
 * day the block occurs it fits around that day's classes: between two, before
 * one, midday if none.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { fitAroundClassesTool } from '../src/tools/fit-around-classes';
import { getInstances } from '../src/schedule';
import { isUndoable } from '../src/undo';
import { severityOf } from '../src/types';

process.env.MISE_SETTINGS_PATH = '/nonexistent/settings.json';

let db: DB;

// Mon 09-07: two classes (11-12:30, 15:30-17). Tue 09-08: one class (14-15:30).
// Fri 09-11: no classes. A cook at 6 PM on each of those days.
beforeEach(() => {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'Fall', start_date: '2026-09-07', end_date: '2026-12-31', timezone: 'America/Chicago' })
    .run();
  const cls = (id: string, t: string, d: string, s: string, e: string) =>
    ({ id, semester_id: 's1', title: t, kind: 'class' as const, starts_at: `${d}T${s}`, ends_at: `${d}T${e}`, pinned: true, rrule: null, source: 'manual' as const, location: null, notes: null, color: null, workout: null });
  const cook = (id: string, d: string) =>
    ({ id, semester_id: 's1', title: 'Cook lunches', kind: 'cook' as const, starts_at: `${d}T18:00`, ends_at: `${d}T19:00`, pinned: false, rrule: null, source: 'agent' as const, location: null, notes: null, color: null, workout: null });
  db.insert(schema.event)
    .values([
      cls('c1', 'DATABASE DESIGN', '2026-09-07', '11:00', '12:30'),
      cls('c2', 'APPLD ML', '2026-09-07', '15:30', '17:00'),
      cls('c3', 'ELEMENTS', '2026-09-08', '14:00', '15:30'),
      cook('ck-mon', '2026-09-07'),
      cook('ck-tue', '2026-09-08'),
      cook('ck-fri', '2026-09-11'),
    ])
    .run();
});

const cookAt = (date: string) => getInstances(db, date, date).find((i) => i.kind === 'cook')!;

describe('fit_around_classes', () => {
  test('two-class day → between the classes (buffer after the earlier)', async () => {
    const { conflicts } = await fitAroundClassesTool.run({ event_id: 'ck-mon', expect_title: 'Cook lunches' } as never, 'commit');
    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);
    // after DATABASE ends 12:30 + 30-min buffer → 13:00, before APPLD 15:30
    expect(cookAt('2026-09-07').starts_at).toBe('2026-09-07T13:00');
    expect(cookAt('2026-09-07').ends_at).toBe('2026-09-07T14:00');
  });

  test('one-class day → before the class (buffered)', async () => {
    await fitAroundClassesTool.run({ event_id: 'ck-mon', expect_title: 'Cook lunches' } as never, 'commit');
    // ELEMENTS at 14:00; cook (60) + 30 buffer → starts 12:30, ends 13:30 (before 14:00)
    expect(cookAt('2026-09-08').starts_at).toBe('2026-09-08T12:30');
    expect(cookAt('2026-09-08').ends_at).toBe('2026-09-08T13:30');
    expect(cookAt('2026-09-08').ends_at <= '2026-09-08T14:00').toBe(true);
  });

  test('no-class day → a midday default (not the 6 PM it started at)', async () => {
    await fitAroundClassesTool.run({ event_id: 'ck-mon', expect_title: 'Cook lunches' } as never, 'commit');
    expect(cookAt('2026-09-11').starts_at).toBe('2026-09-11T12:00');
  });

  test('all three days fit in one call', async () => {
    const { diff } = await fitAroundClassesTool.run({ event_id: 'ck-mon', expect_title: 'Cook lunches' } as never, 'dry');
    expect(diff.summary).toContain('3 days');
  });

  test('it is undoable', () => {
    expect(isUndoable({ tool_name: 'fit_around_classes', status: 'approved' })).toBe(true);
  });
});
