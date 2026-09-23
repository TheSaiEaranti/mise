/**
 * set_event_time — put one block at exact start/end times. Changes duration,
 * makes room, refuses pinned classes and the wrong event. The commit path for
 * the popover time fields, the resize-drag, and the model naming times.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { setEventTimeTool } from '../src/tools/set-event-time';
import { getModelTool } from '../src/tools/index';
import { isUndoable } from '../src/undo';
import { getInstances } from '../src/schedule';
import { severityOf } from '../src/types';

process.env.MISE_SETTINGS_PATH = '/nonexistent/settings.json';

let db: DB;

// Tue 2026-09-08: class 10:00–11:30 (pinned), cook 16:00–17:00, gym 17:00–18:30.
beforeEach(() => {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'Fall', start_date: '2026-09-01', end_date: '2026-12-15', timezone: 'America/Chicago' })
    .run();
  db.insert(schema.event)
    .values([
      {
        id: 'cls', semester_id: 's1', title: 'CS 429', kind: 'class',
        starts_at: '2026-09-08T10:00', ends_at: '2026-09-08T11:30',
        pinned: true, rrule: null, source: 'manual', location: 'GDC', notes: null, color: null, workout: null,
      },
      {
        id: 'cook', semester_id: 's1', title: 'Cook lunches', kind: 'cook',
        starts_at: '2026-09-08T16:00', ends_at: '2026-09-08T17:00',
        pinned: false, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: null,
      },
      {
        id: 'gym', semester_id: 's1', title: 'Gym', kind: 'gym',
        starts_at: '2026-09-08T17:00', ends_at: '2026-09-08T18:30',
        pinned: false, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: null,
      },
    ])
    .run();
});

const day = () =>
  getInstances(db, '2026-09-08', '2026-09-08').map((i) => `${i.starts_at.slice(11)}-${i.ends_at.slice(11)} ${i.title}`);

const setTime = (over: Record<string, unknown>, mode: 'dry' | 'commit' = 'commit') =>
  setEventTimeTool.run(
    { event_id: 'gym', expect_title: 'Gym', date: '2026-09-08', start_time: '18:00', end_time: '20:00', ...over } as never,
    mode,
  );

describe('setting an exact time changes when AND how long', () => {
  test('gym → 6:00–8:00 becomes a 2-hour block at the new time', async () => {
    const { diff, conflicts } = await setTime({ start_time: '18:00', end_time: '20:00' });
    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);
    expect(diff.summary).toContain('Gym →');
    expect(diff.detail).toContain('2 hours');
    expect(day()).toContain('18:00-20:00 Gym');
  });

  test('shortening a block only moves its end', async () => {
    await setTime({ event_id: 'cook', expect_title: 'Cook lunches', start_time: '16:00', end_time: '16:30' });
    const cook = getInstances(db, '2026-09-08', '2026-09-08').find((i) => i.event_id === 'cook')!;
    expect(cook.starts_at).toBe('2026-09-08T16:00');
    expect(cook.ends_at).toBe('2026-09-08T16:30');
  });
});

describe('a retime makes room, never overlaps', () => {
  test('growing the cook session onto the gym pushes the gym later', async () => {
    // Cook 16:00–17:00 → 16:00–17:30 now runs into the gym at 17:00.
    const { diff, conflicts } = await setEventTimeTool.run(
      { event_id: 'cook', expect_title: 'Cook lunches', date: '2026-09-08', start_time: '16:00', end_time: '17:30' } as never,
      'commit',
    );
    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);
    expect(diff.detail).toContain('1 moved to make room');
    expect(day()).toEqual([
      '10:00-11:30 CS 429',
      '16:00-17:30 Cook lunches',
      '17:30-19:00 Gym',
    ]);
  });

  test('retiming onto a class is refused', async () => {
    const { conflicts } = await setTime({ start_time: '10:00', end_time: '11:00' });
    expect(conflicts.some((c) => c.type === 'double_booked')).toBe(true);
    expect(day()).toContain('17:00-18:30 Gym'); // untouched
  });
});

describe('the guards', () => {
  test('a pinned class is refused with pinned_moved, nothing written', async () => {
    const { conflicts } = await setEventTimeTool.run(
      { event_id: 'cls', expect_title: 'CS 429', date: '2026-09-08', start_time: '12:00', end_time: '13:00' } as never,
      'commit',
    );
    expect(conflicts.some((c) => c.type === 'pinned_moved')).toBe(true);
    expect(day()).toContain('10:00-11:30 CS 429');
  });

  test('the wrong event id is refused', async () => {
    const { conflicts } = await setTime({ expect_title: 'Cook lunches' });
    expect(conflicts.some((c) => c.type === 'wrong_event')).toBe(true);
  });

  test('end not after start is refused', async () => {
    const { conflicts } = await setTime({ start_time: '18:00', end_time: '18:00' });
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'bad_times')).toBe(true);
  });

  test('setting a block to the time it is already at is a no-op, honestly reported', async () => {
    const { diff, conflicts } = await setTime({ start_time: '17:00', end_time: '18:30' });
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'already_there')).toBe(true);
    expect(diff.changes).toHaveLength(0);
  });
});

describe('recurring instances', () => {
  test('retiming one occurrence leaves the rest of the series alone', async () => {
    db.insert(schema.event)
      .values({
        id: 'lift', semester_id: 's1', title: 'Lift', kind: 'gym',
        starts_at: '2026-09-07T07:00', ends_at: '2026-09-07T08:00',
        pinned: false, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR', source: 'recurring',
        location: null, notes: null, color: 'clay', workout: 'push',
      })
      .run();

    // Wednesday 2026-09-09's Lift → 09:00–10:30.
    await setEventTimeTool.run(
      { event_id: 'lift', expect_title: 'Lift', date: '2026-09-09', start_time: '09:00', end_time: '10:30' } as never,
      'commit',
    );

    const wed = getInstances(db, '2026-09-09', '2026-09-09').find((i) => i.title === 'Lift')!;
    expect(`${wed.starts_at.slice(11)}-${wed.ends_at.slice(11)}`).toBe('09:00-10:30');
    // The override kept the series' look.
    expect(wed.color).toBe('clay');
    // Monday's occurrence is untouched.
    const mon = getInstances(db, '2026-09-07', '2026-09-07').find((i) => i.title === 'Lift')!;
    expect(`${mon.starts_at.slice(11)}-${mon.ends_at.slice(11)}`).toBe('07:00-08:00');
  });
});

describe('set_event_time is a first-class, reversible time change', () => {
  test('the model can call it, and it is undoable', () => {
    expect(getModelTool('set_event_time')).toBeDefined();
    expect(isUndoable({ tool_name: 'set_event_time', status: 'approved' })).toBe(true);
  });
});
