/**
 * Daily recurrence — "cook lunches every other day". FREQ=DAILY with an
 * INTERVAL, added alongside the existing weekly class patterns.
 */
import { describe, test, expect } from 'bun:test';
import { parseRRule, expandInstances, type EventRow, type ExceptionRow } from '../src/recurrence';

function ev(over: Partial<EventRow> & Pick<EventRow, 'id' | 'starts_at' | 'ends_at' | 'rrule'>): EventRow {
  return {
    semester_id: 'sem1',
    title: 'Cook lunches',
    kind: 'cook',
    pinned: false,
    source: 'agent',
    location: null,
    notes: null,
    color: null,
    workout: null,
    ...over,
  };
}

// 2026-07-19 is a Sunday.
const days = (rows: EventRow[], start: string, end: string) =>
  expandInstances(rows, [], start, end).map((i) => i.instance_date);

describe('parseRRule handles DAILY', () => {
  test('every other day', () => {
    expect(parseRRule('FREQ=DAILY;INTERVAL=2;UNTIL=20260814')).toEqual({
      freq: 'DAILY',
      byday: [],
      interval: 2,
      until: '2026-08-14',
    });
  });

  test('a daily rule may carry a BYDAY filter', () => {
    expect(parseRRule('FREQ=DAILY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR')).toEqual({
      freq: 'DAILY',
      byday: ['MO', 'TU', 'WE', 'TH', 'FR'],
      interval: 1,
    });
  });

  test('DAILY without BYDAY is fine (unlike WEEKLY, which requires it)', () => {
    expect(() => parseRRule('FREQ=DAILY')).not.toThrow();
    expect(() => parseRRule('FREQ=WEEKLY')).toThrow(/BYDAY/);
  });

  test('MONTHLY is still rejected', () => {
    expect(() => parseRRule('FREQ=MONTHLY;BYDAY=MO')).toThrow(/only WEEKLY and DAILY/);
  });
});

describe('expanding every-other-day', () => {
  test('Sun anchor, interval 2 → Sun, Tue, Thu, Sat, Mon …', () => {
    const rows = [ev({ id: 'e1', starts_at: '2026-07-19T18:00', ends_at: '2026-07-19T19:00', rrule: 'FREQ=DAILY;INTERVAL=2;UNTIL=20260814' })];
    // Two weeks from the Sunday anchor.
    expect(days(rows, '2026-07-19', '2026-08-01')).toEqual([
      '2026-07-19', // Sun
      '2026-07-21', // Tue
      '2026-07-23', // Thu
      '2026-07-25', // Sat
      '2026-07-27', // Mon
      '2026-07-29', // Wed
      '2026-07-31', // Fri
    ]);
  });

  test('the UNTIL is respected — nothing past it', () => {
    const rows = [ev({ id: 'e1', starts_at: '2026-07-19T18:00', ends_at: '2026-07-19T19:00', rrule: 'FREQ=DAILY;INTERVAL=2;UNTIL=20260723' })];
    expect(days(rows, '2026-07-19', '2026-08-31')).toEqual(['2026-07-19', '2026-07-21', '2026-07-23']);
  });

  test('a window starting mid-series keeps the phase (never off-by-one)', () => {
    const rows = [ev({ id: 'e1', starts_at: '2026-07-19T18:00', ends_at: '2026-07-19T19:00', rrule: 'FREQ=DAILY;INTERVAL=2;UNTIL=20260814' })];
    // Query only 07-22..07-26: the series lands on 23 and 25, not 22/24/26.
    expect(days(rows, '2026-07-22', '2026-07-26')).toEqual(['2026-07-23', '2026-07-25']);
  });

  test('interval 1 is genuinely every day', () => {
    const rows = [ev({ id: 'e1', starts_at: '2026-07-19T08:00', ends_at: '2026-07-19T08:30', rrule: 'FREQ=DAILY;INTERVAL=1;UNTIL=20260722' })];
    expect(days(rows, '2026-07-19', '2026-07-31')).toEqual(['2026-07-19', '2026-07-20', '2026-07-21', '2026-07-22']);
  });

  test('a BYDAY filter narrows a daily rule to weekdays', () => {
    const rows = [ev({ id: 'e1', starts_at: '2026-07-19T09:00', ends_at: '2026-07-19T10:00', rrule: 'FREQ=DAILY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;UNTIL=20260731' })];
    // Sun 19 and Sat 25 are dropped.
    expect(days(rows, '2026-07-19', '2026-07-26')).toEqual([
      '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24',
    ]);
  });

  test('an exception drops the DAILY occurrence (regression: cancel/move one instance)', () => {
    // The daily drop-check once used a space separator while the exception set
    // used a null byte, so moving or cancelling one instance of a daily series
    // left the original showing — a double. This locks the two to one helper.
    const rows = [ev({ id: 'e1', starts_at: '2026-07-19T18:00', ends_at: '2026-07-19T19:00', rrule: 'FREQ=DAILY;INTERVAL=2;UNTIL=20260814' })];
    const cancel: ExceptionRow = { id: 'x1', event_id: 'e1', original_date: '2026-07-21', status: 'cancelled', override_event_id: null };
    const moved: ExceptionRow = { id: 'x2', event_id: 'e1', original_date: '2026-07-23', status: 'moved', override_event_id: 'ovr' };
    const got = expandInstances(rows, [cancel, moved], '2026-07-19', '2026-07-25').map((i) => i.instance_date);
    // 07-21 (cancelled) and 07-23 (moved) are both gone; 19 and 25 remain.
    expect(got).toEqual(['2026-07-19', '2026-07-25']);
  });

  test('the expanded instances carry the right time and recurring flag', () => {
    const rows = [ev({ id: 'e1', starts_at: '2026-07-19T18:00', ends_at: '2026-07-19T19:00', rrule: 'FREQ=DAILY;INTERVAL=2;UNTIL=20260723' })];
    const out = expandInstances(rows, [], '2026-07-19', '2026-07-23');
    expect(out[1]).toMatchObject({
      instance_date: '2026-07-21',
      starts_at: '2026-07-21T18:00',
      ends_at: '2026-07-21T19:00',
      recurring: true,
      title: 'Cook lunches',
    });
  });
});
