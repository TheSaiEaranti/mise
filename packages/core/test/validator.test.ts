/**
 * Validator tests. (SPEC §5) The validator is the trust anchor of the app;
 * these tests are the deliverable as much as the code.
 *
 * Fixture week: Mon 2026-07-13 … Sun 2026-07-19 (Tue Jul 14, Wed Jul 15…).
 * Constraints from @mise/config defaults:
 *   commute 15 min · sleep 00:00-07:00 · gym windows 06:30-08:30 / 16:00-19:00
 *   gym.not_after ['cook'] within 30 min · cook window 18:00-21:00
 */
import { describe, test, expect } from 'bun:test';
import { constraints } from '@mise/config';
import { validate } from '../src/validator';
import { severityOf } from '../src/types';
import type { Conflict, ProposedInstance, ValidationInput } from '../src/types';
import { addMinutesWall, dateOf } from '../src/time';

let seq = 0;

function mk(over: Partial<ProposedInstance> = {}): ProposedInstance {
  const starts_at = over.starts_at ?? '2026-07-14T10:00';
  const ends_at = over.ends_at ?? addMinutesWall(starts_at, 60);
  return {
    event_id: `ev${++seq}`,
    instance_date: dateOf(starts_at),
    title: 'Event',
    kind: 'personal',
    pinned: false,
    location: null,
    notes: null,
    source: 'manual',
    recurring: false,
    color: null,
    workout: null,
    ...over,
    starts_at,
    ends_at,
  };
}

/** An instance moved by the proposal: original_* = current times shifted back. */
function moved(over: Partial<ProposedInstance> & { starts_at: string }, deltaMin = 60): ProposedInstance {
  const e = mk(over);
  return {
    ...e,
    original_starts_at: addMinutesWall(e.starts_at, -deltaMin),
    original_ends_at: addMinutesWall(e.ends_at, -deltaMin),
  };
}

function vin(events: ProposedInstance[]): ValidationInput {
  return { events, constraints };
}

const ofType = (cs: Conflict[], type: Conflict['type']) => cs.filter((c) => c.type === type);

// ---------------------------------------------------------------------------
// 1. pinned_moved
// ---------------------------------------------------------------------------

describe('pinned_moved', () => {
  test('pinned event shifted → exactly one blocking pinned_moved', () => {
    const cs = validate(
      vin([
        moved({
          event_id: 'cs429',
          title: 'CS 429',
          kind: 'class',
          pinned: true,
          starts_at: '2026-07-14T15:00',
          ends_at: '2026-07-14T16:00',
        }),
      ]),
    );
    expect(cs).toEqual([{ type: 'pinned_moved', event_id: 'cs429', title: 'CS 429' }]);
    expect(severityOf(cs[0]!)).toBe('blocking');
  });

  test('pinned event cancelled → pinned_moved', () => {
    const cs = validate(
      vin([
        mk({ event_id: 'exam', title: 'Exam', kind: 'class', pinned: true, cancelled: true }),
      ]),
    );
    expect(cs).toEqual([{ type: 'pinned_moved', event_id: 'exam', title: 'Exam' }]);
  });

  test('pinned event created by the proposal → pinned_moved', () => {
    const cs = validate(
      vin([mk({ event_id: 'new', title: 'New class', kind: 'class', pinned: true, created: true })]),
    );
    expect(cs).toEqual([{ type: 'pinned_moved', event_id: 'new', title: 'New class' }]);
  });

  test('pinned with original_* set but identical times → NOT flagged', () => {
    const e = mk({ pinned: true, kind: 'class', starts_at: '2026-07-14T14:00', ends_at: '2026-07-14T15:00' });
    const cs = validate(
      vin([{ ...e, original_starts_at: e.starts_at, original_ends_at: e.ends_at }]),
    );
    expect(cs).toEqual([]);
  });

  test('only start moved (end original matches) still fires', () => {
    const e = mk({ event_id: 'p', title: 'P', pinned: true, starts_at: '2026-07-14T14:30', ends_at: '2026-07-14T15:00' });
    const cs = validate(
      vin([{ ...e, original_starts_at: '2026-07-14T14:00', original_ends_at: '2026-07-14T15:00' }]),
    );
    expect(cs).toEqual([{ type: 'pinned_moved', event_id: 'p', title: 'P' }]);
  });

  test('definition-of-done: shift day +60 around a pinned class → zero conflicts, class untouched', () => {
    const cs = validate(
      vin([
        moved({ event_id: 'gym', title: 'Gym', kind: 'gym', starts_at: '2026-07-14T17:00', ends_at: '2026-07-14T18:30' }),
        moved({ event_id: 'cook', title: 'Cook', kind: 'cook', starts_at: '2026-07-14T19:30', ends_at: '2026-07-14T20:30' }),
        mk({ event_id: 'cs429', title: 'CS 429', kind: 'class', pinned: true, starts_at: '2026-07-14T14:00', ends_at: '2026-07-14T15:00' }),
      ]),
    );
    expect(cs).toEqual([]);
  });

  test('multiple pinned offenders come out ordered by starts_at', () => {
    const cs = validate(
      vin([
        moved({ event_id: 'late', title: 'Late', pinned: true, starts_at: '2026-07-14T16:00' }),
        moved({ event_id: 'early', title: 'Early', pinned: true, starts_at: '2026-07-14T09:00' }),
      ]),
    );
    expect(cs.map((c) => (c.type === 'pinned_moved' ? c.event_id : ''))).toEqual(['early', 'late']);
  });
});

// ---------------------------------------------------------------------------
// 2. overlap
// ---------------------------------------------------------------------------

describe('overlap', () => {
  test('partial overlap, minutes exact, a = earlier starts_at', () => {
    const cs = validate(
      vin([
        mk({ event_id: 'b2', title: 'B', starts_at: '2026-07-14T10:30', ends_at: '2026-07-14T11:30' }),
        mk({ event_id: 'a1', title: 'A', starts_at: '2026-07-14T10:00', ends_at: '2026-07-14T11:00' }),
      ]),
    );
    expect(cs).toEqual([
      { type: 'overlap', a: 'a1', b: 'b2', a_title: 'A', b_title: 'B', minutes: 30 },
    ]);
  });

  test('full containment → contained duration', () => {
    const cs = validate(
      vin([
        mk({ event_id: 'outer', title: 'Outer', starts_at: '2026-07-14T09:00', ends_at: '2026-07-14T12:00' }),
        mk({ event_id: 'inner', title: 'Inner', starts_at: '2026-07-14T10:00', ends_at: '2026-07-14T11:00' }),
      ]),
    );
    expect(cs).toEqual([
      { type: 'overlap', a: 'outer', b: 'inner', a_title: 'Outer', b_title: 'Inner', minutes: 60 },
    ]);
  });

  test('identical times → full-duration overlap, deterministic pair order by event_id', () => {
    const cs = validate(
      vin([
        mk({ event_id: 'x2', title: 'X2', starts_at: '2026-07-14T10:00', ends_at: '2026-07-14T11:00' }),
        mk({ event_id: 'x1', title: 'X1', starts_at: '2026-07-14T10:00', ends_at: '2026-07-14T11:00' }),
      ]),
    );
    expect(cs).toEqual([
      { type: 'overlap', a: 'x1', b: 'x2', a_title: 'X1', b_title: 'X2', minutes: 60 },
    ]);
  });

  test('zero-gap adjacency is NOT an overlap', () => {
    const cs = validate(
      vin([
        mk({ starts_at: '2026-07-14T10:00', ends_at: '2026-07-14T11:00' }),
        mk({ starts_at: '2026-07-14T11:00', ends_at: '2026-07-14T12:00' }),
      ]),
    );
    expect(cs).toEqual([]);
  });

  test('cancelled instances do not overlap anything', () => {
    const cs = validate(
      vin([
        mk({ starts_at: '2026-07-14T10:00', ends_at: '2026-07-14T11:00', cancelled: true }),
        mk({ starts_at: '2026-07-14T10:30', ends_at: '2026-07-14T11:30' }),
      ]),
    );
    expect(cs).toEqual([]);
  });

  test('three mutually overlapping events → three pairs, each reported once, ordered', () => {
    const cs = validate(
      vin([
        mk({ event_id: 'C', title: 'C', starts_at: '2026-07-14T11:30', ends_at: '2026-07-14T12:30' }),
        mk({ event_id: 'A', title: 'A', starts_at: '2026-07-14T10:00', ends_at: '2026-07-14T12:00' }),
        mk({ event_id: 'B', title: 'B', starts_at: '2026-07-14T11:00', ends_at: '2026-07-14T13:00' }),
      ]),
    );
    expect(cs).toEqual([
      { type: 'overlap', a: 'A', b: 'B', a_title: 'A', b_title: 'B', minutes: 60 },
      { type: 'overlap', a: 'A', b: 'C', a_title: 'A', b_title: 'C', minutes: 30 },
      { type: 'overlap', a: 'B', b: 'C', a_title: 'B', b_title: 'C', minutes: 60 },
    ]);
  });

  test('same event_id on two dates: distinct instances get their own conflicts', () => {
    const cs = validate(
      vin([
        mk({ event_id: 'rec', title: 'Rec Tue', starts_at: '2026-07-14T10:00', ends_at: '2026-07-14T11:00' }),
        mk({ event_id: 'o1', title: 'Other Tue', starts_at: '2026-07-14T10:30', ends_at: '2026-07-14T11:30' }),
        mk({ event_id: 'rec', title: 'Rec Wed', starts_at: '2026-07-15T10:00', ends_at: '2026-07-15T11:00' }),
        mk({ event_id: 'o2', title: 'Other Wed', starts_at: '2026-07-15T10:15', ends_at: '2026-07-15T11:00' }),
      ]),
    );
    expect(cs).toEqual([
      { type: 'overlap', a: 'rec', b: 'o1', a_title: 'Rec Tue', b_title: 'Other Tue', minutes: 30 },
      { type: 'overlap', a: 'rec', b: 'o2', a_title: 'Rec Wed', b_title: 'Other Wed', minutes: 45 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. no_commute
// ---------------------------------------------------------------------------

describe('no_commute', () => {
  const gdc = (over: Partial<ProposedInstance>) => mk({ location: 'GDC', ...over });

  test('10 min gap between different locations fires (default commute = 15)', () => {
    const cs = validate(
      vin([
        gdc({ event_id: 'f', title: 'From', starts_at: '2026-07-14T10:00', ends_at: '2026-07-14T11:00' }),
        mk({ event_id: 't', title: 'To', location: 'RLM', starts_at: '2026-07-14T11:10', ends_at: '2026-07-14T12:00' }),
      ]),
    );
    expect(cs).toEqual([
      { type: 'no_commute', from: 'f', to: 't', from_title: 'From', to_title: 'To', gap_minutes: 10 },
    ]);
  });

  test('exactly 15 min gap does not fire', () => {
    const cs = validate(
      vin([
        gdc({ starts_at: '2026-07-14T10:00', ends_at: '2026-07-14T11:00' }),
        mk({ location: 'RLM', starts_at: '2026-07-14T11:15', ends_at: '2026-07-14T12:00' }),
      ]),
    );
    expect(cs).toEqual([]);
  });

  test('zero gap at different locations fires with gap 0', () => {
    const cs = validate(
      vin([
        gdc({ starts_at: '2026-07-14T10:00', ends_at: '2026-07-14T11:00' }),
        mk({ location: 'RLM', starts_at: '2026-07-14T11:00', ends_at: '2026-07-14T12:00' }),
      ]),
    );
    expect(ofType(cs, 'no_commute')).toHaveLength(1);
    expect(cs[0]).toMatchObject({ type: 'no_commute', gap_minutes: 0 });
  });

  test('same location (case-insensitive, trimmed) does not fire', () => {
    const cs = validate(
      vin([
        mk({ location: ' GDC ', starts_at: '2026-07-14T10:00', ends_at: '2026-07-14T11:00' }),
        mk({ location: 'gdc', starts_at: '2026-07-14T11:05', ends_at: '2026-07-14T12:00' }),
      ]),
    );
    expect(cs).toEqual([]);
  });

  test('null location on either side does not fire', () => {
    const cs = validate(
      vin([
        gdc({ starts_at: '2026-07-14T10:00', ends_at: '2026-07-14T11:00' }),
        mk({ location: null, starts_at: '2026-07-14T11:05', ends_at: '2026-07-14T12:00' }),
      ]),
    );
    expect(cs).toEqual([]);
  });

  test('overlapping pair (negative gap) reports overlap, not no_commute', () => {
    const cs = validate(
      vin([
        gdc({ starts_at: '2026-07-14T10:00', ends_at: '2026-07-14T11:00' }),
        mk({ location: 'RLM', starts_at: '2026-07-14T10:50', ends_at: '2026-07-14T11:30' }),
      ]),
    );
    expect(cs.map((c) => c.type)).toEqual(['overlap']);
  });

  test('different dates do not fire', () => {
    const cs = validate(
      vin([
        gdc({ starts_at: '2026-07-14T23:00', ends_at: '2026-07-14T23:50' }),
        mk({ location: 'RLM', starts_at: '2026-07-15T00:00', ends_at: '2026-07-15T01:00', // changed=false: no sleep check
        }),
      ]),
    );
    expect(ofType(cs, 'no_commute')).toEqual([]);
  });

  test('cancelled neighbor is skipped when finding consecutive pairs', () => {
    const cs = validate(
      vin([
        gdc({ event_id: 'f', title: 'From', starts_at: '2026-07-14T10:00', ends_at: '2026-07-14T11:00' }),
        mk({ location: 'JES', cancelled: true, starts_at: '2026-07-14T11:02', ends_at: '2026-07-14T11:08' }),
        mk({ event_id: 't', title: 'To', location: 'RLM', starts_at: '2026-07-14T11:10', ends_at: '2026-07-14T12:00' }),
      ]),
    );
    expect(cs).toEqual([
      { type: 'no_commute', from: 'f', to: 't', from_title: 'From', to_title: 'To', gap_minutes: 10 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4a. constraint: sleep
// ---------------------------------------------------------------------------

describe('constraint: sleep', () => {
  test('changed event crossing midnight (23:30–00:30) fires', () => {
    const cs = validate(
      vin([
        moved({ event_id: 'late', title: 'Late thing', starts_at: '2026-07-14T23:30', ends_at: '2026-07-15T00:30' }),
      ]),
    );
    expect(cs).toEqual([
      {
        type: 'constraint',
        rule: 'sleep',
        message: 'Late thing runs 11:30 PM–12:30 AM, inside protected sleep hours (12 AM–7 AM)',
        event_id: 'late',
      },
    ]);
  });

  test('unchanged pre-existing violation does NOT fire', () => {
    const cs = validate(vin([mk({ starts_at: '2026-07-14T06:00', ends_at: '2026-07-14T07:30' })]));
    expect(cs).toEqual([]);
  });

  test('the same instance, changed by the proposal, DOES fire', () => {
    const cs = validate(
      vin([moved({ event_id: 'e', title: 'Gym', kind: 'gym', starts_at: '2026-07-14T06:30', ends_at: '2026-07-14T08:00' })]),
    );
    // Gym 06:30–08:00 fits the 06:30–08:30 window, so sleep is the only conflict.
    expect(cs).toEqual([
      {
        type: 'constraint',
        rule: 'sleep',
        message: 'Gym runs 6:30 AM–8 AM, inside protected sleep hours (12 AM–7 AM)',
        event_id: 'e',
      },
    ]);
  });

  test('created event inside the window fires', () => {
    const cs = validate(
      vin([mk({ event_id: 'run', title: 'Night run', created: true, starts_at: '2026-07-14T02:00', ends_at: '2026-07-14T03:00' })]),
    );
    expect(ofType(cs, 'constraint')).toHaveLength(1);
    expect(cs[0]).toMatchObject({ rule: 'sleep', event_id: 'run' });
  });

  test('changed event starting exactly at 07:00 does not fire (half-open boundary)', () => {
    const cs = validate(vin([moved({ starts_at: '2026-07-14T07:00', ends_at: '2026-07-14T08:00' })]));
    expect(cs).toEqual([]);
  });

  test('cancelled instance inside the window does not fire', () => {
    const cs = validate(
      vin([moved({ cancelled: true, starts_at: '2026-07-14T02:00', ends_at: '2026-07-14T03:00' })]),
    );
    expect(cs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4b. constraint: gym_after_cook
// ---------------------------------------------------------------------------

describe('constraint: gym_after_cook', () => {
  // Cook unchanged at 15:30–16:30; gym times chosen to stay inside the
  // 16:00–19:00 gym window so only the gym_after_cook rule is exercised.
  const cook = () =>
    mk({ event_id: 'cook', title: 'Cook', kind: 'cook', starts_at: '2026-07-14T15:30', ends_at: '2026-07-14T16:30' });

  test('changed gym starting 15 min after cook ends fires', () => {
    const cs = validate(
      vin([
        cook(),
        moved({ event_id: 'gym', title: 'Gym', kind: 'gym', starts_at: '2026-07-14T16:45', ends_at: '2026-07-14T18:15' }),
      ]),
    );
    expect(cs).toEqual([
      {
        type: 'constraint',
        rule: 'gym_after_cook',
        message: 'Gym starts 15 min after Cook ends — no gym within 30 min of a cook session',
        event_id: 'gym',
      },
    ]);
  });

  test('gap of exactly 30 min still fires ("within 30" is inclusive)', () => {
    const cs = validate(
      vin([
        cook(),
        moved({ event_id: 'gym', title: 'Gym', kind: 'gym', starts_at: '2026-07-14T17:00', ends_at: '2026-07-14T18:30' }),
      ]),
    );
    expect(cs).toMatchObject([{ type: 'constraint', rule: 'gym_after_cook' }]);
  });

  test('gap of 45 min (> 30) does not fire', () => {
    const cs = validate(
      vin([
        cook(),
        moved({ event_id: 'gym', title: 'Gym', kind: 'gym', starts_at: '2026-07-14T17:15', ends_at: '2026-07-14T18:45' }),
      ]),
    );
    expect(cs).toEqual([]);
  });

  test('unchanged pair does not fire (pre-existing state)', () => {
    const cs = validate(
      vin([
        cook(),
        mk({ event_id: 'gym', title: 'Gym', kind: 'gym', starts_at: '2026-07-14T16:45', ends_at: '2026-07-14T18:15' }),
      ]),
    );
    expect(cs).toEqual([]);
  });

  test('fires when only the COOK was changed', () => {
    const cs = validate(
      vin([
        moved({ event_id: 'cook', title: 'Cook', kind: 'cook', starts_at: '2026-07-14T18:00', ends_at: '2026-07-14T19:00' }),
        mk({ event_id: 'gym', title: 'Gym', kind: 'gym', starts_at: '2026-07-14T19:15', ends_at: '2026-07-14T20:45' }),
      ]),
    );
    // Gym is unchanged, so no gym_window despite being outside 16:00–19:00.
    expect(cs).toEqual([
      {
        type: 'constraint',
        rule: 'gym_after_cook',
        message: 'Gym starts 15 min after Cook ends — no gym within 30 min of a cook session',
        event_id: 'gym',
      },
    ]);
  });

  test('gym BEFORE cook does not fire', () => {
    const cs = validate(
      vin([
        moved({ event_id: 'gym', title: 'Gym', kind: 'gym', starts_at: '2026-07-14T16:00', ends_at: '2026-07-14T17:30' }),
        mk({ event_id: 'cook', title: 'Cook', kind: 'cook', starts_at: '2026-07-14T18:00', ends_at: '2026-07-14T19:00' }),
      ]),
    );
    expect(cs).toEqual([]);
  });

  test('cook ending on a different date does not fire', () => {
    const cs = validate(
      vin([
        mk({ event_id: 'cook', title: 'Cook', kind: 'cook', starts_at: '2026-07-13T18:00', ends_at: '2026-07-13T19:00' }),
        moved({ event_id: 'gym', title: 'Gym', kind: 'gym', starts_at: '2026-07-14T07:15', ends_at: '2026-07-14T08:30' }),
      ]),
    );
    expect(cs).toEqual([]);
  });

  test('cancelled cook does not fire', () => {
    const cs = validate(
      vin([
        mk({ event_id: 'cook', title: 'Cook', kind: 'cook', cancelled: true, starts_at: '2026-07-14T15:30', ends_at: '2026-07-14T16:30' }),
        moved({ event_id: 'gym', title: 'Gym', kind: 'gym', starts_at: '2026-07-14T16:45', ends_at: '2026-07-14T18:15' }),
      ]),
    );
    expect(cs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4c. constraint: gym_window / cook_window
// ---------------------------------------------------------------------------

describe('constraint: preferred windows', () => {
  test('cook moved to end 20:30, inside 18:00–21:00 → no conflict', () => {
    const cs = validate(
      vin([moved({ event_id: 'cook', title: 'Cook', kind: 'cook', starts_at: '2026-07-14T19:30', ends_at: '2026-07-14T20:30' })]),
    );
    expect(cs).toEqual([]);
  });

  test('cook moved to 20:00–21:30 → fires with SPEC §9 "30 min past" phrasing', () => {
    const cs = validate(
      vin([moved({ event_id: 'cook', title: 'Cook', kind: 'cook', starts_at: '2026-07-14T20:00', ends_at: '2026-07-14T21:30' })]),
    );
    expect(cs).toEqual([
      {
        type: 'constraint',
        rule: 'cook_window',
        message: 'Cook ends 9:30 PM, 30 min past your preferred window (6 PM–9 PM)',
        event_id: 'cook',
      },
    ]);
  });

  test('gym moved to 12:00–13:30, outside both windows → fires against nearest window', () => {
    const cs = validate(
      vin([moved({ event_id: 'gym', title: 'Gym', kind: 'gym', starts_at: '2026-07-14T12:00', ends_at: '2026-07-14T13:30' })]),
    );
    // Nearest window is 16:00–19:00 (240 min before it) vs 06:30–08:30 (300 past).
    expect(cs).toEqual([
      {
        type: 'constraint',
        rule: 'gym_window',
        message: 'Gym starts 12 PM, 240 min before your preferred window (4 PM–7 PM)',
        event_id: 'gym',
      },
    ]);
  });

  test('unchanged cook outside its window does not fire', () => {
    const cs = validate(
      vin([mk({ event_id: 'cook', title: 'Cook', kind: 'cook', starts_at: '2026-07-14T15:00', ends_at: '2026-07-14T16:00' })]),
    );
    expect(cs).toEqual([]);
  });

  test('changed gym fitting the morning window exactly does not fire', () => {
    const cs = validate(
      vin([moved({ event_id: 'gym', title: 'Gym', kind: 'gym', starts_at: '2026-07-14T07:00', ends_at: '2026-07-14T08:30' })]),
    );
    expect(cs).toEqual([]);
  });

  test('created cook outside the window fires too', () => {
    const cs = validate(
      vin([
        mk({ event_id: 'cook', title: 'Cook', kind: 'cook', created: true, starts_at: '2026-07-14T21:30', ends_at: '2026-07-14T22:30' }),
      ]),
    );
    expect(cs).toEqual([
      {
        type: 'constraint',
        rule: 'cook_window',
        message: 'Cook ends 10:30 PM, 90 min past your preferred window (6 PM–9 PM)',
        event_id: 'cook',
      },
    ]);
  });

  test('non-gym/cook kinds have no window rule', () => {
    const cs = validate(
      vin([moved({ event_id: 'p', title: 'Errand', kind: 'personal', starts_at: '2026-07-14T12:00', ends_at: '2026-07-14T13:00' })]),
    );
    expect(cs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Empty input + determinism
// ---------------------------------------------------------------------------

describe('empty input', () => {
  test('no events → []', () => {
    expect(validate(vin([]))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration: several conflict types in one call, full ordered output
// ---------------------------------------------------------------------------

describe('integration', () => {
  function bigInput(): ValidationInput {
    const events: ProposedInstance[] = [
      // Mon: pinned exam moved +60.
      moved({ event_id: 'exam', title: 'Exam', kind: 'class', pinned: true, starts_at: '2026-07-13T10:00', ends_at: '2026-07-13T11:00' }),
      // Tue: overlap pair, then a commute squeeze.
      mk({ event_id: 'a', title: 'A', starts_at: '2026-07-14T09:00', ends_at: '2026-07-14T10:00' }),
      mk({ event_id: 'b', title: 'B', starts_at: '2026-07-14T09:30', ends_at: '2026-07-14T10:30' }),
      mk({ event_id: 'c', title: 'C', location: 'GDC', starts_at: '2026-07-14T10:30', ends_at: '2026-07-14T11:00' }),
      mk({ event_id: 'd', title: 'D', location: 'JES', starts_at: '2026-07-14T11:10', ends_at: '2026-07-14T11:40' }),
      // Wed: created run inside protected sleep.
      mk({ event_id: 'run', title: 'Early run', created: true, starts_at: '2026-07-15T05:30', ends_at: '2026-07-15T06:30' }),
      // Thu: cook moved to overshoot its window by 30 min.
      {
        ...mk({ event_id: 'cook-thu', title: 'Cook', kind: 'cook', starts_at: '2026-07-16T20:00', ends_at: '2026-07-16T21:30' }),
        original_starts_at: '2026-07-16T18:00',
        original_ends_at: '2026-07-16T19:30',
      },
    ];
    return vin(events);
  }

  test('all conflict types, full deterministic ordered output', () => {
    const cs = validate(bigInput());
    expect(cs).toEqual([
      { type: 'pinned_moved', event_id: 'exam', title: 'Exam' },
      { type: 'overlap', a: 'a', b: 'b', a_title: 'A', b_title: 'B', minutes: 30 },
      { type: 'no_commute', from: 'c', to: 'd', from_title: 'C', to_title: 'D', gap_minutes: 10 },
      {
        type: 'constraint',
        rule: 'sleep',
        message: 'Early run runs 5:30 AM–6:30 AM, inside protected sleep hours (12 AM–7 AM)',
        event_id: 'run',
      },
      {
        type: 'constraint',
        rule: 'cook_window',
        message: 'Cook ends 9:30 PM, 30 min past your preferred window (6 PM–9 PM)',
        event_id: 'cook-thu',
      },
    ]);
    // Exactly one blocking conflict — the pinned exam.
    expect(cs.filter((c) => severityOf(c) === 'blocking')).toHaveLength(1);
  });

  test('deterministic: input order does not affect output', () => {
    const input = bigInput();
    const first = validate(input);
    const shuffled: ValidationInput = {
      ...input,
      events: [...input.events].reverse(),
    };
    expect(validate(shuffled)).toEqual(first);
    expect(validate(input)).toEqual(first);
  });

  test('SPEC §12: cancel Tuesday cook while gym shifts — warnings only, approvable', () => {
    // Shift Tuesday +60 (gym+cook move, class pinned untouched), and cancel
    // the Tuesday cook session. Nothing blocks, nothing warns.
    const cs = validate(
      vin([
        mk({ event_id: 'cs429', title: 'CS 429', kind: 'class', pinned: true, starts_at: '2026-07-14T14:00', ends_at: '2026-07-14T15:00' }),
        moved({ event_id: 'gym', title: 'Gym', kind: 'gym', starts_at: '2026-07-14T17:00', ends_at: '2026-07-14T18:30' }),
        mk({ event_id: 'cook1', title: 'Meal prep', kind: 'cook', cancelled: true, starts_at: '2026-07-14T18:30', ends_at: '2026-07-14T19:30' }),
      ]),
    );
    expect(cs).toEqual([]);
  });
});
