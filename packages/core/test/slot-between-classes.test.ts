/**
 * slot_between_classes — "on the days I have two classes, cook between them."
 * The whole horizon in one call: every two-class cook day gets the cook slotted
 * into the inter-class gap, so nothing far out is missed.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { slotBetweenClassesTool } from '../src/tools/slot-between-classes';
import { getInstances } from '../src/schedule';
import { isUndoable } from '../src/undo';
import { severityOf } from '../src/types';

process.env.MISE_SETTINGS_PATH = '/nonexistent/settings.json';

let db: DB;

// Semester with two two-class days (Mon 09-07 & Wed 09-09: DB DESIGN 11-12:30
// pinned + APPLD ML 15:30-17:00 pinned) and a one-class day (Tue 09-08). Cook
// sits in the evening (6:45) on all three; only the two-class days should move.
beforeEach(() => {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'Fall', start_date: '2026-09-07', end_date: '2026-09-30', timezone: 'America/Chicago' })
    .run();
  const rows: (typeof schema.event.$inferInsert)[] = [];
  const cls = (id: string, title: string, date: string, s: string, e: string) =>
    rows.push({ id, semester_id: 's1', title, kind: 'class', starts_at: `${date}T${s}`, ends_at: `${date}T${e}`, pinned: true, rrule: null, source: 'manual', location: 'CBA', notes: null, color: null, workout: null });
  const cook = (id: string, date: string) =>
    rows.push({ id, semester_id: 's1', title: 'Cook lunches', kind: 'cook', starts_at: `${date}T18:45`, ends_at: `${date}T19:45`, pinned: false, rrule: null, source: 'agent', location: null, notes: null, color: null, workout: null });
  // Mon 09-07: two classes + cook
  cls('m-db', 'DATABASE DESIGN', '2026-09-07', '11:00', '12:30');
  cls('m-ml', 'APPLD ML', '2026-09-07', '15:30', '17:00');
  cook('cook-mon', '2026-09-07');
  // Tue 09-08: ONE class + cook (should NOT move)
  cls('t-el', 'ELEMENTS', '2026-09-08', '14:00', '15:30');
  cook('cook-tue', '2026-09-08');
  // Wed 09-09: two classes + cook
  cls('w-db', 'DATABASE DESIGN', '2026-09-09', '11:00', '12:30');
  cls('w-ml', 'APPLD ML', '2026-09-09', '15:30', '17:00');
  cook('cook-wed', '2026-09-09');
  db.insert(schema.event).values(rows).run();
});

const slot = (over: Record<string, unknown> = {}, mode: 'dry' | 'commit' = 'commit') =>
  slotBetweenClassesTool.run({ event_id: 'cook-mon', expect_title: 'Cook lunches', ...over } as never, mode);

const cookAt = (date: string) => getInstances(db, date, date).find((i) => i.kind === 'cook')!;

describe('slot_between_classes', () => {
  test('moves cook between the classes on EVERY two-class day, in one call', async () => {
    const { diff, conflicts } = await slot();
    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);
    // Both Mon and Wed moved to 13:00 (12:30 + 30-min buffer), 1-hour block.
    expect(cookAt('2026-09-07').starts_at).toBe('2026-09-07T13:00');
    expect(cookAt('2026-09-07').ends_at).toBe('2026-09-07T14:00');
    expect(cookAt('2026-09-09').starts_at).toBe('2026-09-09T13:00');
    expect(diff.summary).toContain('2 days');
  });

  test('leaves the one-class day alone', async () => {
    await slot();
    expect(cookAt('2026-09-08').starts_at).toBe('2026-09-08T18:45'); // untouched
  });

  test('lands between the two classes (after the first, before the second)', async () => {
    await slot();
    const cook = cookAt('2026-09-07');
    expect(cook.starts_at >= '2026-09-07T12:30').toBe(true); // after DB DESIGN ends
    expect(cook.ends_at <= '2026-09-07T15:30').toBe(true); // before APPLD ML starts
  });

  test('gap_minutes 0 puts cook flush against the first class', async () => {
    await slot({ gap_minutes: 0 });
    expect(cookAt('2026-09-07').starts_at).toBe('2026-09-07T12:30');
  });

  test('wrong title is refused', async () => {
    const { conflicts } = await slot({ expect_title: 'Gym' });
    expect(conflicts.some((c) => c.type === 'wrong_event')).toBe(true);
  });

  test('it is undoable', () => {
    expect(isUndoable({ tool_name: 'slot_between_classes', status: 'approved' })).toBe(true);
  });
});
