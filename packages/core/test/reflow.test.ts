/**
 * The reflow engine: "friends are coming at 8" should reorder the whole day
 * around the new fixed point by the standing rules (cook before gym, windows,
 * minimal disruption), not just shove one block later like makeRoom does.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { reflowDay, derivePrefs } from '../src/reflow';
import { getInstances } from '../src/schedule';
import type { EventChange } from '../src/types';

let db: DB;

// A Wednesday: APPLD MACHINE 3:30–5 (pinned), gym[legs] 5–6:30, cook 6:45–7:45.
const DATE = '2026-09-09';
beforeEach(() => {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'Fall', start_date: '2026-09-01', end_date: '2026-12-15', timezone: 'America/Chicago' })
    .run();
  db.insert(schema.event)
    .values([
      { id: 'cls', semester_id: 's1', title: 'APPLD MACHINE LEARNING', kind: 'class', starts_at: `${DATE}T15:30`, ends_at: `${DATE}T17:00`, pinned: true, rrule: null, source: 'manual', location: 'CBA', notes: null, color: null, workout: null },
      { id: 'gym', semester_id: 's1', title: 'Gym', kind: 'gym', starts_at: `${DATE}T17:00`, ends_at: `${DATE}T18:30`, pinned: false, rrule: null, source: 'manual', location: 'Gregory', notes: null, color: null, workout: 'legs' },
      { id: 'cook', semester_id: 's1', title: 'Cook lunches', kind: 'cook', starts_at: `${DATE}T18:45`, ends_at: `${DATE}T19:45`, pinned: false, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: null },
    ])
    .run();
});

const anchorAt = (start: string, end: string): EventChange => ({
  event_id: 'friends', instance_date: DATE, title: 'Friends over', kind: 'personal', pinned: false,
  before: null, after: { starts_at: `${DATE}T${start}`, ends_at: `${DATE}T${end}` },
});

describe('reflowDay', () => {
  test('a late anchor that conflicts with nothing moves nothing', () => {
    const { knockOns, conflicts } = reflowDay(db, DATE, anchorAt('20:00', '22:00'));
    expect(conflicts).toEqual([]);
    expect(knockOns).toEqual([]); // gym + cook already sit before 8pm
  });

  test('an anchor over gym+cook reflows both AFTER it, keeping cook before gym', () => {
    // Friends 6–8pm swallows both. The only cook-before-gym layout is both after.
    const { knockOns, conflicts } = reflowDay(db, DATE, anchorAt('18:00', '20:00'));
    expect(conflicts).toEqual([]);
    const by = new Map(knockOns.map((k) => [k.event_id, k.after!]));
    expect(by.get('cook')).toEqual({ starts_at: `${DATE}T20:00`, ends_at: `${DATE}T21:00` });
    // gym follows cook with the 30-min post-cook buffer: 21:00 + 30 = 21:30.
    expect(by.get('gym')).toEqual({ starts_at: `${DATE}T21:30`, ends_at: `${DATE}T23:00` });
    // cook starts before gym
    expect(by.get('cook')!.starts_at < by.get('gym')!.starts_at).toBe(true);
  });

  test('an anchor that only hits the gym leaves the cook where it is', () => {
    // Friends 5–6pm overlaps only the gym (5–6:30); cook (6:45) is untouched.
    const { knockOns, conflicts } = reflowDay(db, DATE, anchorAt('17:00', '18:00'));
    expect(conflicts).toEqual([]);
    expect(knockOns.map((k) => k.event_id)).toEqual(['gym']); // only the gym moved
    // gym pushed to after friends; cook stays before it → cook-before-gym holds.
    const gym = knockOns[0]!.after!;
    expect(gym.starts_at >= `${DATE}T18:00`).toBe(true);
  });

  test('swap: forceOrder cook-before-gym flips the current gym-before-cook layout', () => {
    // Current: gym 5–6:30 then cook 6:45–7:45. Force cook-before-gym → gym moves
    // to after the cook.
    const { knockOns, conflicts } = reflowDay(db, DATE, null, { forceOrder: ['cook', 'gym'] });
    expect(conflicts).toEqual([]);
    const gymNow = knockOns.find((k) => k.event_id === 'gym')?.after ?? { starts_at: `${DATE}T17:00` };
    const cookNow = knockOns.find((k) => k.event_id === 'cook')?.after ?? { starts_at: `${DATE}T18:45` };
    expect(cookNow.starts_at < gymNow.starts_at).toBe(true); // cook now first
  });

  test('no room → a no_room conflict, no partial moves', () => {
    // Anchor fills the whole evening to bedtime; nothing can fit cook+gym after.
    const { knockOns, conflicts } = reflowDay(db, DATE, anchorAt('17:00', '23:30'));
    expect(knockOns).toEqual([]);
    expect(conflicts.some((c) => c.type === 'no_room')).toBe(true);
  });

  test('cook leaves a 30-min gap after the class it follows (buffer)', () => {
    // A day where cook butts right up against the class (17:00, 0 gap). With a
    // "cook 30 min after class" buffer, reflowing cook pushes it to class-end +
    // 30 = 17:30 — even though there was no overlap to clear. This is the
    // "add a break between class and cooking lunch" rule.
    const D = '2026-09-10';
    db.insert(schema.event)
      .values([
        { id: 'clsA', semester_id: 's1', title: 'CLASS A', kind: 'class', starts_at: `${D}T15:30`, ends_at: `${D}T17:00`, pinned: true, rrule: null, source: 'manual', location: 'CBA', notes: null, color: null, workout: null },
        { id: 'cookA', semester_id: 's1', title: 'Cook', kind: 'cook', starts_at: `${D}T17:00`, ends_at: `${D}T18:00`, pinned: false, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: null },
      ])
      .run();
    const prefs = derivePrefs({ order: [], windows: {}, buffers: [{ kind: 'cook', after_kinds: ['class'], gap_minutes: 30 }] });
    const { knockOns, conflicts } = reflowDay(db, D, null, { forceOrder: ['cook'], prefs });
    expect(conflicts).toEqual([]);
    const cook = knockOns.find((k) => k.event_id === 'cookA')?.after;
    expect(cook).toEqual({ starts_at: `${D}T17:30`, ends_at: `${D}T18:30` });
  });

  test('with no cook buffer, cook still sits flush against the class', () => {
    // Same day, but no buffer → cook may stay touching the class (17:00). Proves
    // the gap comes from the preference, not from something hard-coded.
    const D = '2026-09-11';
    db.insert(schema.event)
      .values([
        { id: 'clsB', semester_id: 's1', title: 'CLASS B', kind: 'class', starts_at: `${D}T15:30`, ends_at: `${D}T17:00`, pinned: true, rrule: null, source: 'manual', location: 'CBA', notes: null, color: null, workout: null },
        { id: 'cookB', semester_id: 's1', title: 'Cook', kind: 'cook', starts_at: `${D}T17:00`, ends_at: `${D}T18:00`, pinned: false, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: null },
      ])
      .run();
    const prefs = derivePrefs({ order: [], windows: {}, buffers: [] });
    const { knockOns } = reflowDay(db, D, null, { forceOrder: ['cook'], prefs });
    expect(knockOns).toEqual([]); // cook already where it wants to be, no move
  });

  test('reflow never lands a movable block on the pinned class', () => {
    const { knockOns } = reflowDay(db, DATE, anchorAt('19:00', '20:00'));
    // Whatever moved, none of it overlaps the 15:30–17:00 class.
    for (const k of knockOns) {
      const s = k.after!.starts_at, e = k.after!.ends_at;
      expect(s >= `${DATE}T17:00` || e <= `${DATE}T15:30`).toBe(true);
    }
  });
});
