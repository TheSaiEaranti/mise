/**
 * set_gym_splits — "Mondays chest and back, Tuesdays shoulders and arms,
 * Wednesdays legs." A gym on several weekdays is ONE event with ONE label; this
 * replaces it with a labelled weekly gym per weekday, in one call.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { setGymSplitsTool } from '../src/tools/set-gym-splits';
import { getInstances } from '../src/schedule';
import { isUndoable } from '../src/undo';
import { severityOf } from '../src/types';

process.env.MISE_SETTINGS_PATH = '/nonexistent/settings.json';

let db: DB;

// Semester from Mon 2026-09-07. One Mon/Tue/Wed gym at 9-10, unlabelled.
beforeEach(() => {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'Fall', start_date: '2026-09-07', end_date: '2026-12-31', timezone: 'America/Chicago' })
    .run();
  db.insert(schema.event)
    .values({
      id: 'gym-mtw', semester_id: 's1', title: 'Gym', kind: 'gym',
      starts_at: '2026-09-07T09:00', ends_at: '2026-09-07T10:00',
      pinned: false, rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE;INTERVAL=1;UNTIL=20261231', source: 'recurring',
      location: 'Gregory', notes: null, color: null, workout: null,
    })
    .run();
});

const split = (over: Record<string, unknown> = {}, mode: 'dry' | 'commit' = 'commit') =>
  setGymSplitsTool.run(
    {
      days: [
        { day: 'MO', workout: 'Chest and back' },
        { day: 'TU', workout: 'Shoulder and arms' },
        { day: 'WE', workout: 'Legs' },
      ],
      ...over,
    } as never,
    mode,
  );

const gymOn = (date: string) => getInstances(db, date, date).find((i) => i.kind === 'gym');

describe('set_gym_splits', () => {
  test('labels each weekday with its own split, keeping the 9 AM time', async () => {
    const { conflicts } = await split();
    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);
    // Mon chest, Tue shoulders, Wed legs — the week of 09-07.
    expect(gymOn('2026-09-07')?.workout).toBe('chest-back');
    expect(gymOn('2026-09-08')?.workout).toBe('shoulders-arms');
    expect(gymOn('2026-09-09')?.workout).toBe('legs');
    expect(gymOn('2026-09-07')?.starts_at).toBe('2026-09-07T09:00');
  });

  test('the labels repeat every week', async () => {
    await split();
    expect(gymOn('2026-09-14')?.workout).toBe('chest-back'); // next Monday
    expect(gymOn('2026-09-16')?.workout).toBe('legs'); // next Wednesday
  });

  test('no duplicate gym on any day (the old MO/TU/WE series is gone)', async () => {
    await split();
    for (const d of ['2026-09-07', '2026-09-08', '2026-09-09']) {
      expect(getInstances(db, d, d).filter((i) => i.kind === 'gym').length).toBe(1);
    }
    // three separate weekly events replaced the one multi-day event
    const rows = db.select().from(schema.event).all().filter((e) => e.kind === 'gym');
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => /BYDAY=(MO|TU|WE);/.test(r.rrule ?? ''))).toBe(true);
  });

  test('an unknown split name is refused before anything is wiped', async () => {
    const { conflicts } = await split({
      days: [{ day: 'MO', workout: 'cardio blast' }],
    });
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'bad_split')).toBe(true);
    // gym untouched
    expect(db.select().from(schema.event).all().filter((e) => e.kind === 'gym')).toHaveLength(1);
  });

  test('it is undoable', () => {
    expect(isUndoable({ tool_name: 'set_gym_splits', status: 'approved' })).toBe(true);
  });
});
