/**
 * drop_class — the one sanctioned way to remove a pinned class. It takes the
 * whole series with it, refuses the wrong event, refuses non-classes, and is
 * unreachable from the model (I4).
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { dropClassTool } from '../src/tools/drop-class';
import { getModelTool, modelToolNames, getTool } from '../src/tools/index';
import { isUndoable } from '../src/undo';
import { getInstances } from '../src/schedule';

process.env.MISE_SETTINGS_PATH = '/nonexistent/settings.json';

let db: DB;

// A semester with CS 429 (Tue/Thu, pinned) and a movable gym.
beforeEach(() => {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'Fall', start_date: '2026-09-01', end_date: '2026-12-15', timezone: 'America/Chicago' })
    .run();
  db.insert(schema.event)
    .values([
      {
        id: 'cls-429', semester_id: 's1', title: 'CS 429 Computer Organization', kind: 'class',
        starts_at: '2026-09-01T10:00', ends_at: '2026-09-01T11:30',
        pinned: true, rrule: 'FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261215', source: 'recurring',
        location: 'GDC 2.216', notes: null, color: null, workout: null,
      },
      {
        id: 'gym-1', semester_id: 's1', title: 'Gym', kind: 'gym',
        starts_at: '2026-09-08T17:00', ends_at: '2026-09-08T18:30',
        pinned: false, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: null,
      },
    ])
    .run();
});

const drop = (over: Record<string, unknown> = {}, mode: 'dry' | 'commit' = 'commit') =>
  dropClassTool.run({ event_id: 'cls-429', expect_title: 'CS 429 Computer Organization', ...over } as never, mode);

describe('dropping a class takes the whole series', () => {
  test('the class and every one of its meetings are gone', async () => {
    // It really meets before the drop…
    expect(getInstances(db, '2026-09-08', '2026-09-08').some((i) => i.event_id === 'cls-429')).toBe(true);
    expect(getInstances(db, '2026-09-10', '2026-09-10').some((i) => i.event_id === 'cls-429')).toBe(true);

    const { diff, conflicts } = await drop();
    expect(conflicts).toEqual([]);
    expect(diff.summary).toBe('Drop CS 429 Computer Organization');
    expect(diff.detail).toContain('Tue/Thu');
    expect(diff.detail).toContain('Dec 15');
    const ch = diff.changes[0]!;
    expect(ch.before).not.toBeNull();
    expect(ch.after).toBeNull();

    // …and it meets on no day afterward.
    expect(db.select().from(schema.event).where(undefined).all().some((e) => e.id === 'cls-429')).toBe(false);
    expect(getInstances(db, '2026-09-01', '2026-12-15').some((i) => i.event_id === 'cls-429')).toBe(false);
    // The gym is untouched.
    expect(db.select().from(schema.event).all().some((e) => e.id === 'gym-1')).toBe(true);
  });

  test('exceptions and their override rows go too — nothing orphaned', async () => {
    // One lecture was moved (spawning an override row + a 'moved' exception) and
    // another was skipped (a 'cancelled' exception).
    db.insert(schema.event)
      .values({
        id: 'ovr-1', semester_id: 's1', title: 'CS 429 Computer Organization', kind: 'class',
        starts_at: '2026-09-08T13:00', ends_at: '2026-09-08T14:30',
        pinned: true, rrule: null, source: 'agent', location: 'GDC 2.216', notes: null, color: null, workout: null,
      })
      .run();
    db.insert(schema.eventException)
      .values([
        { id: 'exc-mv', event_id: 'cls-429', original_date: '2026-09-08', status: 'moved', override_event_id: 'ovr-1' },
        { id: 'exc-cn', event_id: 'cls-429', original_date: '2026-09-10', status: 'cancelled', override_event_id: null },
      ])
      .run();

    await drop();

    expect(db.select().from(schema.event).all().some((e) => e.id === 'ovr-1')).toBe(false);
    expect(db.select().from(schema.eventException).all()).toHaveLength(0);
  });

  test('a dry run changes nothing but shows what would go', async () => {
    const { diff } = await drop({}, 'dry');
    expect(diff.changes[0]!.after).toBeNull();
    expect(db.select().from(schema.event).all().some((e) => e.id === 'cls-429')).toBe(true);
  });
});

describe('drop_class refuses the wrong target', () => {
  test('a title mismatch is a wrong_event refusal, nothing deleted', async () => {
    const { conflicts } = await drop({ expect_title: 'Gym' });
    expect(conflicts.some((c) => c.type === 'wrong_event')).toBe(true);
    expect(db.select().from(schema.event).all().some((e) => e.id === 'cls-429')).toBe(true);
  });

  test('it will not delete a non-class — that is what cancel_event is for', async () => {
    const { diff, conflicts } = await dropClassTool.run(
      { event_id: 'gym-1', expect_title: 'Gym' } as never,
      'commit',
    );
    expect(diff.changes).toHaveLength(0);
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'not_a_class')).toBe(true);
    expect(db.select().from(schema.event).all().some((e) => e.id === 'gym-1')).toBe(true);
  });

  test('a stale id is refused, not thrown', async () => {
    const { conflicts } = await dropClassTool.run(
      { event_id: 'nope', expect_title: 'CS 429 Computer Organization' } as never,
      'commit',
    );
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'stale')).toBe(true);
  });
});

describe('drop_class is user-initiated only, and permanent', () => {
  test('the model cannot reach it, but the UI (getTool) can', () => {
    expect(getTool('drop_class')).toBeDefined();
    expect(getModelTool('drop_class')).toBeUndefined();
    expect(modelToolNames()).not.toContain('drop_class');
  });

  test('it is not offered as an undo — dropping a course is deliberate', () => {
    expect(isUndoable({ tool_name: 'drop_class', status: 'approved' })).toBe(false);
  });
});
