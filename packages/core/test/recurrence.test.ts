import { describe, test, expect, beforeEach } from 'bun:test';
import { parseRRule, expandInstances, type EventRow, type ExceptionRow } from '../src/recurrence';
import { getSemester, getInstances } from '../src/schedule';
import { resetDbForTests, schema, type DB } from '../src/db/client';

// 2026-01-12 is a Monday. Jan: Mo 12, We 14, Fr 16, Mo 19, We 21, Fr 23, Mo 26...

function ev(over: Partial<EventRow> & Pick<EventRow, 'id' | 'starts_at' | 'ends_at'>): EventRow {
  return {
    semester_id: 'sem1',
    title: 'Event',
    kind: 'personal',
    pinned: false,
    rrule: null,
    source: 'manual',
    location: null,
    notes: null,
    color: null,
    workout: null,
    ...over,
  };
}

function exc(
  event_id: string,
  original_date: string,
  status: 'moved' | 'cancelled',
  override_event_id: string | null = null,
): ExceptionRow {
  return { id: `x-${event_id}-${original_date}`, event_id, original_date, status, override_event_id };
}

const mwf = (over: Partial<EventRow> = {}): EventRow =>
  ev({
    id: 'cls1',
    title: 'CS 429',
    kind: 'class',
    pinned: true,
    starts_at: '2026-01-12T10:00',
    ends_at: '2026-01-12T11:00',
    rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    source: 'recurring',
    ...over,
  });

function dates(instances: { instance_date: string }[]): string[] {
  return instances.map((i) => i.instance_date);
}

// ---------------------------------------------------------------------------
// parseRRule
// ---------------------------------------------------------------------------

describe('parseRRule', () => {
  test('parses a plain MWF weekly rule with defaults', () => {
    expect(parseRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR')).toEqual({
      freq: 'WEEKLY',
      byday: ['MO', 'WE', 'FR'],
      interval: 1,
    });
  });

  test('parses INTERVAL', () => {
    expect(parseRRule('FREQ=WEEKLY;BYDAY=TU,TH;INTERVAL=2').interval).toBe(2);
  });

  test('parses UNTIL in all three formats, keeping only the date', () => {
    for (const u of ['20260116', '20260116T235959', '20260116T235959Z']) {
      expect(parseRRule(`FREQ=WEEKLY;BYDAY=MO;UNTIL=${u}`).until).toBe('2026-01-16');
    }
  });

  test('until is absent when UNTIL not given', () => {
    expect(parseRRule('FREQ=WEEKLY;BYDAY=MO').until).toBeUndefined();
  });

  test('key order does not matter and trailing semicolon is tolerated', () => {
    expect(parseRRule('BYDAY=SA,SU;FREQ=WEEKLY;')).toEqual({
      freq: 'WEEKLY',
      byday: ['SA', 'SU'],
      interval: 1,
    });
  });

  test('dedupes repeated BYDAY codes', () => {
    expect(parseRRule('FREQ=WEEKLY;BYDAY=MO,MO,WE').byday).toEqual(['MO', 'WE']);
  });

  test('rejects any FREQ other than WEEKLY or DAILY', () => {
    // DAILY is now supported ("every other day"); MONTHLY/YEARLY are not.
    expect(() => parseRRule('FREQ=MONTHLY;BYDAY=MO')).toThrow(/FREQ/);
    expect(() => parseRRule('FREQ=YEARLY')).toThrow(/FREQ/);
    expect(parseRRule('FREQ=DAILY;INTERVAL=2').freq).toBe('DAILY');
  });

  test('rejects garbage and malformed input', () => {
    expect(() => parseRRule('hello world')).toThrow();
    expect(() => parseRRule('')).toThrow();
    expect(() => parseRRule('BYDAY=MO')).toThrow(/FREQ/);
    expect(() => parseRRule('FREQ=WEEKLY')).toThrow(/BYDAY/);
    expect(() => parseRRule('FREQ=WEEKLY;BYDAY=MO,XX')).toThrow(/BYDAY/);
    expect(() => parseRRule('FREQ=WEEKLY;BYDAY=MO;INTERVAL=0')).toThrow(/INTERVAL/);
    expect(() => parseRRule('FREQ=WEEKLY;BYDAY=MO;INTERVAL=two')).toThrow(/INTERVAL/);
    expect(() => parseRRule('FREQ=WEEKLY;BYDAY=MO;UNTIL=2026-01-16')).toThrow(/UNTIL/);
    expect(() => parseRRule('FREQ=WEEKLY;BYDAY=')).toThrow(/BYDAY/);
  });
});

// ---------------------------------------------------------------------------
// expandInstances — recurring
// ---------------------------------------------------------------------------

describe('expandInstances: weekly expansion', () => {
  test('MWF expands to 6 instances across a 2-week window', () => {
    const out = expandInstances([mwf()], [], '2026-01-12', '2026-01-25');
    expect(dates(out)).toEqual([
      '2026-01-12', '2026-01-14', '2026-01-16',
      '2026-01-19', '2026-01-21', '2026-01-23',
    ]);
    for (const i of out) {
      expect(i.recurring).toBe(true);
      expect(i.starts_at).toBe(`${i.instance_date}T10:00`);
      expect(i.ends_at).toBe(`${i.instance_date}T11:00`);
      expect(i.instance_date).toBe(i.starts_at.slice(0, 10));
      expect(i.event_id).toBe('cls1');
      expect(i.pinned).toBe(true);
      expect(i.title).toBe('CS 429');
      expect(i.kind).toBe('class');
    }
  });

  test('INTERVAL=2 skips alternate weeks, anchored on the event week', () => {
    const e = mwf({ rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;INTERVAL=2' });
    const out = expandInstances([e], [], '2026-01-12', '2026-02-08');
    expect(dates(out)).toEqual([
      '2026-01-12', '2026-01-14', '2026-01-16', // week 0
      '2026-01-26', '2026-01-28', '2026-01-30', // week 2
    ]);
  });

  test('INTERVAL=2 stays anchored to the event week even when the window starts later', () => {
    const e = mwf({ rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;INTERVAL=2' });
    // Window covers weeks 1 and 2 of the pattern; only week 2 fires.
    const out = expandInstances([e], [], '2026-01-19', '2026-02-01');
    expect(dates(out)).toEqual(['2026-01-26', '2026-01-28', '2026-01-30']);
  });

  test('UNTIL is respected (inclusive) for all three formats', () => {
    for (const u of ['20260116', '20260116T235959', '20260116T235959Z']) {
      const e = mwf({ rrule: `FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=${u}` });
      const out = expandInstances([e], [], '2026-01-12', '2026-01-31');
      expect(dates(out)).toEqual(['2026-01-12', '2026-01-14', '2026-01-16']);
    }
  });

  test('UNTIL before the window start yields nothing', () => {
    const e = mwf({ rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260110' });
    expect(expandInstances([e], [], '2026-01-12', '2026-01-25')).toEqual([]);
  });

  test('anchor mid-week: no occurrences before the anchor date', () => {
    // Anchored on Wednesday Jan 14; Monday Jan 12 of the same week must NOT appear.
    const e = mwf({ starts_at: '2026-01-14T10:00', ends_at: '2026-01-14T11:00' });
    const out = expandInstances([e], [], '2026-01-12', '2026-01-25');
    expect(dates(out)).toEqual([
      '2026-01-14', '2026-01-16',
      '2026-01-19', '2026-01-21', '2026-01-23',
    ]);
  });

  test('window entirely before the anchor yields nothing', () => {
    expect(expandInstances([mwf()], [], '2026-01-01', '2026-01-11')).toEqual([]);
  });

  test('occurrences keep the base HH:mm times', () => {
    const e = mwf({ starts_at: '2026-01-12T14:30', ends_at: '2026-01-12T15:45' });
    const out = expandInstances([e], [], '2026-01-19', '2026-01-19');
    expect(out).toHaveLength(1);
    expect(out[0]!.starts_at).toBe('2026-01-19T14:30');
    expect(out[0]!.ends_at).toBe('2026-01-19T15:45');
  });
});

// ---------------------------------------------------------------------------
// expandInstances — exceptions
// ---------------------------------------------------------------------------

describe('expandInstances: exceptions', () => {
  test('cancelled exception drops exactly that occurrence', () => {
    const out = expandInstances(
      [mwf()],
      [exc('cls1', '2026-01-14', 'cancelled')],
      '2026-01-12', '2026-01-25',
    );
    expect(dates(out)).toEqual([
      '2026-01-12', '2026-01-16',
      '2026-01-19', '2026-01-21', '2026-01-23',
    ]);
  });

  test('moved exception drops the original; the override row shows up as its own standalone event', () => {
    const override = ev({
      id: 'ovr1',
      title: 'CS 429 (moved)',
      kind: 'class',
      pinned: true,
      starts_at: '2026-01-17T09:00',
      ends_at: '2026-01-17T10:00',
    });
    const out = expandInstances(
      [mwf(), override],
      [exc('cls1', '2026-01-16', 'moved', 'ovr1')],
      '2026-01-12', '2026-01-25',
    );
    expect(dates(out)).toEqual([
      '2026-01-12', '2026-01-14', '2026-01-17',
      '2026-01-19', '2026-01-21', '2026-01-23',
    ]);
    const moved = out.find((i) => i.event_id === 'ovr1')!;
    expect(moved.recurring).toBe(false);
    expect(moved.starts_at).toBe('2026-01-17T09:00');
  });

  test('an exception for another event id does not drop anything', () => {
    const out = expandInstances(
      [mwf()],
      [exc('other-event', '2026-01-14', 'cancelled')],
      '2026-01-12', '2026-01-18',
    );
    expect(dates(out)).toEqual(['2026-01-12', '2026-01-14', '2026-01-16']);
  });
});

// ---------------------------------------------------------------------------
// expandInstances — non-recurring + windowing + sorting
// ---------------------------------------------------------------------------

describe('expandInstances: non-recurring and window edges', () => {
  test('non-recurring event inside the window is included once, recurring=false', () => {
    const e = ev({ id: 'gym1', title: 'Gym', kind: 'gym', starts_at: '2026-01-15T17:00', ends_at: '2026-01-15T18:30' });
    const out = expandInstances([e], [], '2026-01-12', '2026-01-18');
    expect(out).toHaveLength(1);
    expect(out[0]!).toMatchObject({
      event_id: 'gym1',
      instance_date: '2026-01-15',
      recurring: false,
      starts_at: '2026-01-15T17:00',
      ends_at: '2026-01-15T18:30',
    });
  });

  test('non-recurring event outside the window is excluded', () => {
    const e = ev({ id: 'gym1', starts_at: '2026-01-19T17:00', ends_at: '2026-01-19T18:30' });
    expect(expandInstances([e], [], '2026-01-12', '2026-01-18')).toEqual([]);
  });

  test('window edges are inclusive on both ends', () => {
    const onStart = ev({ id: 'a', starts_at: '2026-01-12T08:00', ends_at: '2026-01-12T09:00' });
    const onEnd = ev({ id: 'b', starts_at: '2026-01-18T08:00', ends_at: '2026-01-18T09:00' });
    const before = ev({ id: 'c', starts_at: '2026-01-11T08:00', ends_at: '2026-01-11T09:00' });
    const after = ev({ id: 'd', starts_at: '2026-01-19T08:00', ends_at: '2026-01-19T09:00' });
    const out = expandInstances([onStart, onEnd, before, after], [], '2026-01-12', '2026-01-18');
    expect(out.map((i) => i.event_id)).toEqual(['a', 'b']);
  });

  test('output is sorted by starts_at then title', () => {
    const late = ev({ id: 'p1', title: 'Zeta', starts_at: '2026-01-13T09:00', ends_at: '2026-01-13T10:00' });
    const tieB = ev({ id: 'p2', title: 'Bravo', starts_at: '2026-01-12T10:00', ends_at: '2026-01-12T11:00' });
    const tieA = ev({ id: 'p3', title: 'Alpha', starts_at: '2026-01-12T10:00', ends_at: '2026-01-12T11:00' });
    // Feed them in shuffled order alongside the recurring event.
    const out = expandInstances([late, tieB, mwf(), tieA], [], '2026-01-12', '2026-01-14');
    expect(out.map((i) => `${i.starts_at} ${i.title}`)).toEqual([
      '2026-01-12T10:00 Alpha',
      '2026-01-12T10:00 Bravo',
      '2026-01-12T10:00 CS 429',
      '2026-01-13T09:00 Zeta',
      '2026-01-14T10:00 CS 429',
    ]);
  });

  test('instance_date always equals dateOf(starts_at)', () => {
    const out = expandInstances(
      [mwf(), ev({ id: 'x', starts_at: '2026-01-13T09:00', ends_at: '2026-01-13T10:00' })],
      [],
      '2026-01-12', '2026-01-25',
    );
    expect(out.length).toBeGreaterThan(0);
    for (const i of out) expect(i.instance_date).toBe(i.starts_at.slice(0, 10));
  });

  test('a malformed rrule on an event throws loudly instead of silently skipping', () => {
    const bad = mwf({ rrule: 'FREQ=MONTHLY;BYDAY=MO' });
    expect(() => expandInstances([bad], [], '2026-01-12', '2026-01-18')).toThrow(/FREQ/);
  });
});

// ---------------------------------------------------------------------------
// schedule.ts — getSemester / getInstances against an in-memory DB
// ---------------------------------------------------------------------------

describe('schedule: getSemester / getInstances', () => {
  let db: DB;

  beforeEach(() => {
    db = resetDbForTests();
  });

  function seedSemester(start = '2026-01-12', end = '2026-02-28'): void {
    db.insert(schema.semester)
      .values({ id: 'sem1', name: 'Spring 2026', start_date: start, end_date: end })
      .run();
  }

  function seedMwfClass(): void {
    db.insert(schema.event)
      .values({
        id: 'cls1',
        semester_id: 'sem1',
        title: 'CS 429',
        kind: 'class',
        starts_at: '2026-01-12T10:00',
        ends_at: '2026-01-12T11:00',
        pinned: true,
        rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
        source: 'recurring',
      })
      .run();
  }

  test('getSemester returns null on an empty DB, then the seeded row', () => {
    expect(getSemester(db)).toBeNull();
    seedSemester();
    expect(getSemester(db)?.id).toBe('sem1');
    expect(getSemester(db)?.timezone).toBe('America/Chicago');
  });

  test('getInstances returns [] when no semester exists', () => {
    expect(getInstances(db, '2026-01-12', '2026-01-25')).toEqual([]);
  });

  test('expands seeded recurring events and applies exceptions', () => {
    seedSemester();
    seedMwfClass();
    db.insert(schema.eventException)
      .values({ id: 'x1', event_id: 'cls1', original_date: '2026-01-21', status: 'cancelled' })
      .run();

    const out = getInstances(db, '2026-01-12', '2026-01-25');
    expect(dates(out)).toEqual([
      '2026-01-12', '2026-01-14', '2026-01-16',
      '2026-01-19', '2026-01-23',
    ]);
  });

  test('clamps the requested window to the semester on both ends', () => {
    seedSemester('2026-01-12', '2026-02-28');
    seedMwfClass();
    db.insert(schema.event)
      .values({
        id: 'gym1',
        semester_id: 'sem1',
        title: 'Gym',
        kind: 'gym',
        starts_at: '2026-02-10T17:00',
        ends_at: '2026-02-10T18:30',
        source: 'manual',
      })
      .run();

    // Ask for far more than the semester covers.
    const out = getInstances(db, '2026-01-05', '2026-03-31');
    // MWF Jan 12 .. Feb 27 = 7 weeks x 3 = 21 recurring, plus the gym one-off.
    expect(out).toHaveLength(22);
    expect(out[0]!.instance_date).toBe('2026-01-12');
    expect(out[out.length - 1]!.instance_date).toBe('2026-02-27');
    expect(out.some((i) => i.event_id === 'gym1' && i.instance_date === '2026-02-10')).toBe(true);
    // Nothing leaked outside the semester.
    for (const i of out) {
      expect(i.instance_date >= '2026-01-12').toBe(true);
      expect(i.instance_date <= '2026-02-28').toBe(true);
    }
  });

  test('window entirely outside the semester yields []', () => {
    seedSemester();
    seedMwfClass();
    expect(getInstances(db, '2026-06-01', '2026-06-30')).toEqual([]);
    expect(getInstances(db, '2025-11-01', '2025-12-31')).toEqual([]);
  });
});
