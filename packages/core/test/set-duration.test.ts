/**
 * set_duration — "make all breakfasts 30 minutes." Sets the length of EVERY
 * same-titled block (each recurring series + any moved one-off) in one call,
 * keeping each start, so the model can't check one and miss the rest.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { setDurationTool } from '../src/tools/set-duration';
import { getInstances } from '../src/schedule';
import { durationMinutes } from '../src/time';
import { isUndoable } from '../src/undo';
import { severityOf } from '../src/types';

process.env.MISE_SETTINGS_PATH = '/nonexistent/settings.json';

let db: DB;

// Breakfast is a mix: Mon/Wed 30 min, Tue/Thu/Fri/Sat/Sun 60 min, plus a moved
// one-off at 60 min — exactly the shape the model mislabelled "already 30".
beforeEach(() => {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'Fall', start_date: '2026-09-07', end_date: '2026-12-31', timezone: 'America/Chicago' })
    .run();
  db.insert(schema.event)
    .values([
      { id: 'bf-mw', semester_id: 's1', title: 'Breakfast', kind: 'personal', starts_at: '2026-09-07T10:30', ends_at: '2026-09-07T11:00', pinned: false, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=1;UNTIL=20261231', source: 'recurring', location: null, notes: null, color: null, workout: null },
      { id: 'bf-rest', semester_id: 's1', title: 'Breakfast', kind: 'personal', starts_at: '2026-09-08T10:30', ends_at: '2026-09-08T11:30', pinned: false, rrule: 'FREQ=WEEKLY;BYDAY=TU,TH,FR,SA,SU;INTERVAL=1;UNTIL=20261231', source: 'recurring', location: null, notes: null, color: null, workout: null },
      { id: 'bf-oneoff', semester_id: 's1', title: 'Breakfast', kind: 'personal', starts_at: '2026-09-10T12:30', ends_at: '2026-09-10T13:30', pinned: false, rrule: null, source: 'agent', location: null, notes: null, color: null, workout: null },
    ])
    .run();
});

const durOf = (date: string) => {
  const i = getInstances(db, date, date).find((x) => x.title === 'Breakfast')!;
  return (new Date('2000-01-01T' + i.ends_at.slice(11)).getTime() - new Date('2000-01-01T' + i.starts_at.slice(11)).getTime()) / 60000;
};

describe('set_duration', () => {
  test('makes EVERY breakfast 30 min, keeping each start', async () => {
    const { conflicts } = await setDurationTool.run(
      { event_id: 'bf-mw', expect_title: 'Breakfast', duration_minutes: 30 } as never,
      'commit',
    );
    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);
    expect(durOf('2026-09-07')).toBe(30); // Mon (already 30)
    expect(durOf('2026-09-08')).toBe(30); // Tue series (was 60)
    expect(durOf('2026-09-11')).toBe(30); // Fri series (was 60)
    // the moved one-off: resized to 30 min, its 12:30 start untouched
    const oneoff = db.select().from(schema.event).where(eq(schema.event.id, 'bf-oneoff')).get()!;
    expect(durationMinutes(oneoff.starts_at, oneoff.ends_at)).toBe(30);
    expect(oneoff.starts_at).toBe('2026-09-10T12:30');
  });

  test('sticks every week (series length changed, not a one-week override)', async () => {
    await setDurationTool.run({ event_id: 'bf-mw', expect_title: 'Breakfast', duration_minutes: 30 } as never, 'commit');
    expect(durOf('2026-09-15')).toBe(30); // next-week Tue
    expect(durOf('2026-09-18')).toBe(30); // next-week Fri
  });

  test('a no-op (all already that length) is reported, not a false success', async () => {
    await setDurationTool.run({ event_id: 'bf-mw', expect_title: 'Breakfast', duration_minutes: 30 } as never, 'commit');
    const again = await setDurationTool.run({ event_id: 'bf-mw', expect_title: 'Breakfast', duration_minutes: 30 } as never, 'commit');
    expect(again.conflicts.some((c) => c.type === 'constraint' && c.rule === 'already')).toBe(true);
  });

  test('wrong title is refused; it is undoable', async () => {
    const { conflicts } = await setDurationTool.run({ event_id: 'bf-mw', expect_title: 'Gym', duration_minutes: 30 } as never, 'commit');
    expect(conflicts.some((c) => c.type === 'wrong_event')).toBe(true);
    expect(isUndoable({ tool_name: 'set_duration', status: 'approved' })).toBe(true);
  });
});
