/**
 * Tests for the scheduling-search / semester-setup / read tools. All dates are far in the future relative to the test clock so
 * the "skip past slots" rule never interferes except where tested.
 *
 * Week under test: Mon 2026-09-07 … Sun 2026-09-13.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

// Force default constraints: no onboarding overlay file.
process.env.MISE_SETTINGS_PATH = '/nonexistent/mise-test-settings.json';

import { resetDbForTests, schema, type DB } from '../src/db/client';
import { getInstances } from '../src/schedule';
import { rescheduleTool } from '../src/tools/reschedule';
import { setupSemesterTool } from '../src/tools/setup-semester';
import { getMealsTool, getScheduleTool } from '../src/tools/read';
import type { Conflict, EventKind } from '../src/types';

let db: DB;
beforeEach(() => {
  db = resetDbForTests();
});

const SEM = { id: 'sem-1', name: 'Fall 2026', start_date: '2026-08-17', end_date: '2026-12-18', timezone: 'America/Chicago' };

function seedSemester() {
  db.insert(schema.semester).values(SEM).run();
}

let evSeq = 0;
function seedEvent(partial: {
  id?: string;
  title?: string;
  kind?: EventKind;
  starts_at: string;
  ends_at: string;
  pinned?: boolean;
  rrule?: string | null;
  location?: string | null;
}): string {
  const id = partial.id ?? `evt-${++evSeq}`;
  db.insert(schema.event)
    .values({
      id,
      semester_id: SEM.id,
      title: partial.title ?? 'Event',
      kind: partial.kind ?? 'personal',
      starts_at: partial.starts_at,
      ends_at: partial.ends_at,
      pinned: partial.pinned ?? false,
      rrule: partial.rrule ?? null,
      source: partial.rrule ? 'recurring' : 'manual',
      location: partial.location ?? null,
      notes: null,
    })
    .run();
  return id;
}

const count = (t: Parameters<DB['select']>[0] extends never ? never : any) =>
  db.select().from(t).all().length;

function constraintRules(conflicts: Conflict[]): string[] {
  return conflicts.filter((c) => c.type === 'constraint').map((c) => (c as any).rule);
}

// ---------------------------------------------------------------------------
// reschedule_to_free_slot
// ---------------------------------------------------------------------------

describe('reschedule_to_free_slot', () => {
  test('finds free morning slots, gym preferred windows rank first, returns 3 candidates', async () => {
    seedSemester();
    const gym = seedEvent({ title: 'Gym', kind: 'gym', starts_at: '2026-09-08T20:00', ends_at: '2026-09-08T21:30' });

    const { diff, conflicts } = await rescheduleTool.run(
      { event_id: gym, search_from: '2026-09-08', search_days: 3, prefer: 'morning' },
      'dry',
    );

    expect(conflicts).toEqual([]);
    // 06:00/06:30 starts intersect protected sleep (00:00-07:00); 07:00-08:30
    // sits inside the 06:30-08:30 gym preferred window on all three days.
    expect(diff.candidates).toEqual([
      { date: '2026-09-08', start_time: '07:00', end_time: '08:30' },
      { date: '2026-09-09', start_time: '07:00', end_time: '08:30' },
      { date: '2026-09-10', start_time: '07:00', end_time: '08:30' },
    ]);
    for (const c of diff.candidates!) {
      expect(c.start_time >= '06:00').toBe(true);
      expect(c.end_time <= '12:00').toBe(true);
    }
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]!.before).toEqual({ starts_at: '2026-09-08T20:00', ends_at: '2026-09-08T21:30' });
    expect(diff.changes[0]!.after).toEqual({ starts_at: '2026-09-08T07:00', ends_at: '2026-09-08T08:30' });
    expect(diff.summary).toContain('Reschedule Gym');
  });

  test('skips occupied slots and prefers the next day preferred window over a same-day non-preferred one', async () => {
    seedSemester();
    const gym = seedEvent({ title: 'Gym', kind: 'gym', starts_at: '2026-09-08T20:00', ends_at: '2026-09-08T21:30' });
    seedEvent({ title: 'Blocker', starts_at: '2026-09-08T07:00', ends_at: '2026-09-08T08:30' });

    const { diff } = await rescheduleTool.run(
      { event_id: gym, search_from: '2026-09-08', search_days: 3, prefer: 'morning' },
      'dry',
    );

    // Tue 07:00-08:30 is taken; preferred-window hits on Wed/Thu outrank the
    // earlier-but-unpreferred Tue 08:30.
    expect(diff.candidates).toEqual([
      { date: '2026-09-09', start_time: '07:00', end_time: '08:30' },
      { date: '2026-09-10', start_time: '07:00', end_time: '08:30' },
      { date: '2026-09-08', start_time: '08:30', end_time: '10:00' },
    ]);
    expect(diff.changes[0]!.after!.starts_at).toBe('2026-09-09T07:00');
  });

  test('dry mode never writes', async () => {
    seedSemester();
    const gym = seedEvent({ title: 'Gym', kind: 'gym', starts_at: '2026-09-08T20:00', ends_at: '2026-09-08T21:30' });
    const eventsBefore = db.select().from(schema.event).all();

    await rescheduleTool.run({ event_id: gym, search_from: '2026-09-08', search_days: 3, prefer: 'morning' }, 'dry');

    expect(db.select().from(schema.event).all()).toEqual(eventsBefore);
    expect(count(schema.eventException)).toBe(0);
  });

  test('packed window → no_slot conflict, empty changes and candidates', async () => {
    seedSemester();
    const gym = seedEvent({ title: 'Gym', kind: 'gym', starts_at: '2026-09-08T20:00', ends_at: '2026-09-08T21:30' });
    seedEvent({ title: 'All evening', starts_at: '2026-09-08T17:00', ends_at: '2026-09-08T22:00' });

    const { diff, conflicts } = await rescheduleTool.run(
      { event_id: gym, search_from: '2026-09-08', search_days: 1, prefer: 'evening' },
      'dry',
    );

    expect(diff.changes).toEqual([]);
    expect(diff.candidates).toEqual([]);
    expect(constraintRules(conflicts)).toContain('no_slot');
  });

  test('commit updates a standalone event in place', async () => {
    seedSemester();
    const gym = seedEvent({ title: 'Gym', kind: 'gym', starts_at: '2026-09-08T20:00', ends_at: '2026-09-08T21:30' });

    await rescheduleTool.run({ event_id: gym, search_from: '2026-09-08', search_days: 3, prefer: 'morning' }, 'commit');

    const row = db.select().from(schema.event).all().find((e) => e.id === gym)!;
    expect(row.starts_at).toBe('2026-09-08T07:00');
    expect(row.ends_at).toBe('2026-09-08T08:30');
    expect(count(schema.event)).toBe(1);
    expect(count(schema.eventException)).toBe(0);
  });

  test('commit moves ONE instance of a recurring event via exception + override row', async () => {
    seedSemester();
    const gym = seedEvent({
      title: 'Gym',
      kind: 'gym',
      starts_at: '2026-08-18T20:00',
      ends_at: '2026-08-18T21:30',
      rrule: 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20261218',
    });

    await rescheduleTool.run({ event_id: gym, search_from: '2026-09-08', search_days: 3, prefer: 'morning' }, 'commit');

    const exceptions = db.select().from(schema.eventException).all();
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.event_id).toBe(gym);
    expect(exceptions[0]!.original_date).toBe('2026-09-08');
    expect(exceptions[0]!.status).toBe('moved');

    const override = db.select().from(schema.event).all().find((e) => e.id === exceptions[0]!.override_event_id)!;
    expect(override).toBeDefined();
    expect(override.rrule).toBeNull();
    expect(override.source).toBe('agent');
    expect(override.starts_at).toBe('2026-09-08T07:00');
    expect(override.kind).toBe('gym');

    // Expansion: that Tuesday's gym is now at 07:00 only; next week untouched.
    const week = getInstances(db, '2026-09-07', '2026-09-13').filter((i) => i.kind === 'gym');
    expect(week).toHaveLength(1);
    expect(week[0]!.starts_at).toBe('2026-09-08T07:00');
    const nextWeek = getInstances(db, '2026-09-14', '2026-09-20').filter((i) => i.kind === 'gym');
    expect(nextWeek).toHaveLength(1);
    expect(nextWeek[0]!.starts_at).toBe('2026-09-15T20:00');
  });

  test('pinned target → blocking pinned_moved; commit writes nothing', async () => {
    seedSemester();
    const exam = seedEvent({
      title: 'CS 429 exam',
      kind: 'class',
      starts_at: '2026-09-08T20:00',
      ends_at: '2026-09-08T21:30',
      pinned: true,
    });
    const before = db.select().from(schema.event).all();

    const { conflicts } = await rescheduleTool.run(
      { event_id: exam, search_from: '2026-09-08', search_days: 3, prefer: 'morning' },
      'commit',
    );

    expect(conflicts.some((c) => c.type === 'pinned_moved')).toBe(true);
    expect(db.select().from(schema.event).all()).toEqual(before);
    expect(count(schema.eventException)).toBe(0);
  });

  test('unknown event id → stale conflict, no writes', async () => {
    seedSemester();
    const { diff, conflicts } = await rescheduleTool.run(
      { event_id: 'evt-gone', search_from: '2026-09-08', search_days: 3, prefer: 'any' },
      'commit',
    );
    expect(diff.changes).toEqual([]);
    expect(constraintRules(conflicts)).toContain('stale');
    expect(count(schema.event)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// setup_semester
// ---------------------------------------------------------------------------

const CLASSES = [
  { title: 'CS 429', days: ['MO', 'WE'] as ('MO' | 'WE')[], start_time: '10:00', end_time: '11:30' },
  { title: 'M 408D', days: ['TU', 'TH'] as ('TU' | 'TH')[], start_time: '09:30', end_time: '11:00' },
];

const SETUP_ARGS = {
  name: 'Fall 2026',
  start_date: '2026-08-19', // a Wednesday
  end_date: '2026-12-18',
  timezone: 'America/Chicago',
  classes: CLASSES,
  replace: false,
};

describe('setup_semester', () => {
  test('dry: one change per class at its first occurrence, pinned, no writes', async () => {
    const { diff, conflicts } = await setupSemesterTool.run(SETUP_ARGS, 'dry');

    expect(conflicts).toEqual([]);
    expect(diff.changes).toHaveLength(2);
    // start_date is a Wednesday: MO/WE first occurs that same Wednesday,
    // TU/TH first occurs the next day (Thursday).
    expect(diff.changes[0]!.after).toEqual({ starts_at: '2026-08-19T10:00', ends_at: '2026-08-19T11:30' });
    expect(diff.changes[1]!.after).toEqual({ starts_at: '2026-08-20T09:30', ends_at: '2026-08-20T11:00' });
    expect(diff.changes.every((c) => c.pinned && c.kind === 'class' && c.before === null)).toBe(true);
    expect(diff.detail).toContain('MO/WE 10:00–11:30 weekly');
    expect(count(schema.semester)).toBe(0);
    expect(count(schema.event)).toBe(0);
  });

  test('dry: detects class-vs-class overlaps (user typos)', async () => {
    const { conflicts } = await setupSemesterTool.run(
      {
        ...SETUP_ARGS,
        classes: [
          { title: 'A', days: ['TU'], start_time: '10:00', end_time: '11:00' },
          { title: 'B', days: ['TU'], start_time: '10:30', end_time: '11:30' },
        ],
      },
      'dry',
    );
    const overlaps = conflicts.filter((c) => c.type === 'overlap');
    expect(overlaps).toHaveLength(1);
    expect((overlaps[0] as any).minutes).toBe(30);
  });

  test('commit: creates recurring pinned events that getInstances expands', async () => {
    await setupSemesterTool.run(SETUP_ARGS, 'commit');

    expect(count(schema.semester)).toBe(1);
    const cs = db.select().from(schema.event).all().find((e) => e.title === 'CS 429')!;
    expect(cs.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261218');
    expect(cs.pinned).toBe(true);
    expect(cs.source).toBe('recurring');
    expect(cs.starts_at).toBe('2026-08-19T10:00');

    // Spot-check MO/WE expansion over the first two weeks.
    const instances = getInstances(db, '2026-08-17', '2026-08-30').filter((i) => i.title === 'CS 429');
    expect(instances.map((i) => i.instance_date)).toEqual(['2026-08-19', '2026-08-24', '2026-08-26']);
    expect(instances.every((i) => i.pinned && i.starts_at.endsWith('T10:00'))).toBe(true);
  });

  test('existing semester without replace → semester_exists, no writes', async () => {
    await setupSemesterTool.run(SETUP_ARGS, 'commit');
    const { conflicts } = await setupSemesterTool.run(SETUP_ARGS, 'commit');

    expect(constraintRules(conflicts)).toContain('semester_exists');
    expect(count(schema.semester)).toBe(1);
    expect(count(schema.event)).toBe(2);
  });

  test('replace: wipes the old semester and its events', async () => {
    await setupSemesterTool.run(SETUP_ARGS, 'commit');
    await setupSemesterTool.run(
      {
        name: 'Spring 2027',
        start_date: '2027-01-19',
        end_date: '2027-05-15',
        timezone: 'America/Chicago',
        classes: [{ title: 'CS 439', days: ['MO' as const], start_time: '13:00', end_time: '14:30' }],
        replace: true,
      },
      'commit',
    );

    const sems = db.select().from(schema.semester).all();
    expect(sems).toHaveLength(1);
    expect(sems[0]!.name).toBe('Spring 2027');
    const events = db.select().from(schema.event).all();
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toBe('CS 439');
  });
});

// ---------------------------------------------------------------------------
// read tools
// ---------------------------------------------------------------------------

describe('read tools', () => {
  test('get_schedule returns compact instance rows', async () => {
    seedSemester();
    seedEvent({
      id: 'evt-a',
      title: 'Office hours',
      kind: 'personal',
      starts_at: '2026-09-08T14:00',
      ends_at: '2026-09-08T15:00',
      location: 'GDC',
    });

    const result = (await getScheduleTool.run({ start_date: '2026-09-07', end_date: '2026-09-13' })) as {
      events: unknown[];
    };
    expect(result.events).toEqual([
      {
        id: 'evt-a',
        title: 'Office hours',
        kind: 'personal',
        date: '2026-09-08',
        start: '14:00',
        end: '15:00',
        pinned: false,
        location: 'GDC',
      },
    ]);
  });

  test('get_meals returns compact meals + suites', async () => {
    const result = (await getMealsTool.run({})) as { meals: unknown[]; suites: unknown[] };
    expect(result.meals).toEqual([]);
    expect(result.suites).toEqual([]);
  });
});
