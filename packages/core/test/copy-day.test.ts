/**
 * copy_day — "add the same gym and shower as Tuesday to Thu/Fri/Sat/Sun, name
 * the gym Run." A real clone: exact times and labels from the source day, unlike
 * create_event which guesses a fresh slot.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { copyDayTool } from '../src/tools/copy-day';
import { getInstances } from '../src/schedule';
import { isUndoable } from '../src/undo';
import { severityOf } from '../src/types';

process.env.MISE_SETTINGS_PATH = '/nonexistent/settings.json';

let db: DB;

// Tuesday 2026-09-08: Gym 10-11 (shoulders-arms) + Shower 11-11:30 + Breakfast.
beforeEach(() => {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'Fall', start_date: '2026-09-07', end_date: '2026-12-31', timezone: 'America/Chicago' })
    .run();
  db.insert(schema.event)
    .values([
      { id: 'g', semester_id: 's1', title: 'Gym', kind: 'gym', starts_at: '2026-09-08T10:00', ends_at: '2026-09-08T11:00', pinned: false, rrule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;UNTIL=20261231', source: 'recurring', location: 'Gregory', notes: null, color: null, workout: 'shoulders-arms' },
      { id: 's', semester_id: 's1', title: 'Shower', kind: 'personal', starts_at: '2026-09-08T11:00', ends_at: '2026-09-08T11:30', pinned: false, rrule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;UNTIL=20261231', source: 'recurring', location: null, notes: null, color: null, workout: null },
      { id: 'b', semester_id: 's1', title: 'Breakfast', kind: 'personal', starts_at: '2026-09-08T11:30', ends_at: '2026-09-08T12:00', pinned: false, rrule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;UNTIL=20261231', source: 'recurring', location: null, notes: null, color: null, workout: null },
    ])
    .run();
});

const copy = (over: Record<string, unknown> = {}) =>
  copyDayTool.run(
    { source_date: '2026-09-08', days: ['TH', 'FR', 'SA', 'SU'], only_titles: ['Gym', 'Shower'], rename: [{ from: 'Gym', to: 'Run' }], ...over } as never,
    'commit',
  );

const on = (date: string, title: string) => getInstances(db, date, date).find((i) => i.title === title);

describe('copy_day', () => {
  test('clones the exact times to every target day; the gym is renamed Run', async () => {
    const { conflicts } = await copy();
    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);
    for (const thu of ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13']) {
      // Run at Tuesday's exact 10-11
      const run = on(thu, 'Run')!;
      expect([run.starts_at.slice(11), run.ends_at.slice(11)]).toEqual(['10:00', '11:00']);
      expect(run.kind).toBe('gym');
      // Shower at Tuesday's exact 11-11:30
      const shower = on(thu, 'Shower')!;
      expect([shower.starts_at.slice(11), shower.ends_at.slice(11)]).toEqual(['11:00', '11:30']);
    }
  });

  test('a renamed block drops the split label (a Run is not shoulders-arms)', async () => {
    await copy();
    expect(on('2026-09-10', 'Run')!.workout).toBeNull();
  });

  test('only the named blocks are copied — breakfast (not named) is not', async () => {
    await copy();
    expect(on('2026-09-10', 'Breakfast')).toBeUndefined();
  });

  test('copies EVERY movable block when no only_titles given', async () => {
    await copyDayTool.run({ source_date: '2026-09-08', days: ['TH'] } as never, 'commit');
    expect(on('2026-09-10', 'Gym')).toBeTruthy();
    expect(on('2026-09-10', 'Shower')).toBeTruthy();
    expect(on('2026-09-10', 'Breakfast')).toBeTruthy();
  });

  test('re-copying is a no-op (does not duplicate)', async () => {
    await copy();
    const again = await copy();
    expect(again.conflicts.some((c) => c.type === 'constraint' && c.rule === 'already')).toBe(true);
    expect(getInstances(db, '2026-09-10', '2026-09-10').filter((i) => i.title === 'Run')).toHaveLength(1);
  });

  test('it is undoable', () => {
    expect(isUndoable({ tool_name: 'copy_day', status: 'approved' })).toBe(true);
  });
});
