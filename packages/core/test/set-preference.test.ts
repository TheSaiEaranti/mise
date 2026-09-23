/**
 * Standing preferences: set once, they stick AND change how the day reflows.
 * The load-bearing test is the last one — flipping the ordering rule flips the
 * reflow, proving preferences actually drive the engine, not just decorate it.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { setPreferenceTool } from '../src/tools/set-preference';
import { getPreferences } from '../src/preferences';
import { reflowDay } from '../src/reflow';
import { createProposal, type ProposalRow } from '../src/proposals';
import { undoProposal, isUndoable } from '../src/undo';
import type { EventChange } from '../src/types';

let db: DB;
const DATE = '2026-09-09';

beforeEach(() => {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'Fall', start_date: '2026-09-01', end_date: '2026-12-15', timezone: 'America/Chicago' })
    .run();
  db.insert(schema.event)
    .values([
      { id: 'gym', semester_id: 's1', title: 'Gym', kind: 'gym', starts_at: `${DATE}T17:00`, ends_at: `${DATE}T18:30`, pinned: false, rrule: null, source: 'manual', location: 'Gregory', notes: null, color: null, workout: 'legs' },
      { id: 'cook', semester_id: 's1', title: 'Cook lunches', kind: 'cook', starts_at: `${DATE}T18:45`, ends_at: `${DATE}T19:45`, pinned: false, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: null },
    ])
    .run();
});

const anchorAt = (start: string, end: string): EventChange => ({
  event_id: 'friends', instance_date: DATE, title: 'Friends over', kind: 'personal', pinned: false,
  before: null, after: { starts_at: `${DATE}T${start}`, ends_at: `${DATE}T${end}` },
});

describe('set_preference', () => {
  test('defaults are seeded from the config (cook before gym)', () => {
    const p = getPreferences(db);
    expect(p.order).toContainEqual({ before: 'cook', after: 'gym' });
    expect((p.windows.gym ?? []).length).toBeGreaterThan(0);
  });

  test('adds an order rule and drops the contradicting one', async () => {
    const { diff, conflicts } = await setPreferenceTool.run(
      { type: 'order', before: 'gym', after: 'cook' } as never,
      'commit',
    );
    expect(conflicts).toEqual([]);
    expect(diff.pref_changes).toEqual(['gym before cook']);
    const order = getPreferences(db).order;
    expect(order).toContainEqual({ before: 'gym', after: 'cook' });
    expect(order).not.toContainEqual({ before: 'cook', after: 'gym' }); // the opposite was dropped
  });

  test('sets a preferred window and refuses a no-op', async () => {
    await setPreferenceTool.run({ type: 'window', kind: 'gym', windows: ['06:00-09:00'] } as never, 'commit');
    expect(getPreferences(db).windows.gym).toEqual(['06:00-09:00']);
    const again = await setPreferenceTool.run({ type: 'window', kind: 'gym', windows: ['06:00-09:00'] } as never, 'commit');
    expect(again.conflicts.some((c) => c.type === 'constraint' && c.rule === 'already')).toBe(true);
  });

  test('undo restores the previous preferences', async () => {
    const { diff } = await setPreferenceTool.run({ type: 'order', before: 'gym', after: 'cook' } as never, 'commit');
    const p = createProposal(db, { user_message: 'gym before cook', tool_name: 'set_preference', tool_args: {}, diff, conflicts: [] });
    db.update(schema.proposal).set({ status: 'approved' }).where(eq(schema.proposal.id, p.id)).run();
    const row = db.select().from(schema.proposal).where(eq(schema.proposal.id, p.id)).get()! as ProposalRow;

    expect(isUndoable(row)).toBe(true);
    expect(undoProposal(db, row).ok).toBe(true);
    // back to cook-before-gym
    expect(getPreferences(db).order).toContainEqual({ before: 'cook', after: 'gym' });
    expect(getPreferences(db).order).not.toContainEqual({ before: 'gym', after: 'cook' });
  });

  test('a cook-after-class buffer coexists with the default gym buffer (no clobber)', async () => {
    // The bug: "a break between class and cooking" saved as a GYM buffer,
    // wiping "no gym after cook". Now buffers key by kind, so setting a cook
    // buffer leaves the gym buffer intact.
    const gymBefore = getPreferences(db).buffers.find((b) => b.kind === 'gym');
    expect(gymBefore).toBeTruthy(); // default: no gym within 30 after cook

    const { diff, conflicts } = await setPreferenceTool.run(
      { type: 'buffer', kind: 'cook', after_kinds: ['class'], gap_minutes: 30 } as never,
      'commit',
    );
    expect(conflicts).toEqual([]);
    expect(diff.pref_changes).toEqual(['no cook within 30 min after class']);

    const buffers = getPreferences(db).buffers;
    expect(buffers).toContainEqual({ kind: 'cook', after_kinds: ['class'], gap_minutes: 30 });
    expect(buffers.find((b) => b.kind === 'gym')).toEqual(gymBefore); // gym rule survived
  });

  test('a gym-after-class buffer MERGES with the default gym-after-cook one (cook rule survives)', async () => {
    // The bug: "from now on leave 30 min after class before the gym" upserted
    // the ONE gym buffer, replacing after_kinds ['cook'] with ['class'], so
    // "no gym right after cook" silently vanished.
    const gymRows = () => getPreferences(db).buffers.filter((b) => b.kind === 'gym');
    expect(gymRows()).toEqual([{ kind: 'gym', after_kinds: ['cook'], gap_minutes: 30 }]); // the default

    const { diff, conflicts } = await setPreferenceTool.run(
      { type: 'buffer', kind: 'gym', after_kinds: ['class'], gap_minutes: 30 } as never,
      'commit',
    );
    expect(conflicts).toEqual([]);
    expect(diff.pref_changes).toEqual(['no gym within 30 min after class']);
    expect(gymRows()).toEqual([{ kind: 'gym', after_kinds: ['cook', 'class'], gap_minutes: 30 }]);

    // The engine still holds the gym off the cook: friends 6–8 → cook 8–9, gym
    // 9:30 (not 9:00, which is where it lands if the cook rule is gone).
    const cookDay = reflowDay(db, DATE, anchorAt('18:00', '20:00'));
    expect(cookDay.knockOns.find((k) => k.event_id === 'cook')!.after!.starts_at).toBe(`${DATE}T20:00`);
    expect(cookDay.knockOns.find((k) => k.event_id === 'gym')!.after!.starts_at).toBe(`${DATE}T21:30`);

    // ...and the new class rule is live too: a gym flush against a class slides to class end + 30.
    const D = '2026-09-10';
    db.insert(schema.event)
      .values([
        { id: 'clsA', semester_id: 's1', title: 'CLASS A', kind: 'class', starts_at: `${D}T15:30`, ends_at: `${D}T17:00`, pinned: true, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: null },
        { id: 'gymA', semester_id: 's1', title: 'Gym', kind: 'gym', starts_at: `${D}T17:00`, ends_at: `${D}T18:30`, pinned: false, rrule: null, source: 'manual', location: null, notes: null, color: null, workout: 'legs' },
      ])
      .run();
    const classDay = reflowDay(db, D, null, { forceOrder: ['gym'] });
    expect(classDay.knockOns.find((k) => k.event_id === 'gymA')?.after).toEqual({ starts_at: `${D}T17:30`, ends_at: `${D}T19:00` });
  });

  test('a new gap applies only to the after_kinds named; the others keep theirs', async () => {
    const gymRows = () => getPreferences(db).buffers.filter((b) => b.kind === 'gym');
    await setPreferenceTool.run({ type: 'buffer', kind: 'gym', after_kinds: ['class'], gap_minutes: 45 } as never, 'commit');
    expect(gymRows()).toEqual([
      { kind: 'gym', after_kinds: ['cook'], gap_minutes: 30 },
      { kind: 'gym', after_kinds: ['class'], gap_minutes: 45 },
    ]);

    // Bringing class down to 30 folds it back into the cook row.
    await setPreferenceTool.run({ type: 'buffer', kind: 'gym', after_kinds: ['class'], gap_minutes: 30 } as never, 'commit');
    expect(gymRows()).toEqual([{ kind: 'gym', after_kinds: ['cook', 'class'], gap_minutes: 30 }]);

    const again = await setPreferenceTool.run({ type: 'buffer', kind: 'gym', after_kinds: ['class'], gap_minutes: 30 } as never, 'commit');
    expect(again.conflicts.some((c) => c.type === 'constraint' && c.rule === 'already')).toBe(true);
  });

  test('remove: true drops just the named after_kind, or the whole buffer when none is named', async () => {
    const gymRows = () => getPreferences(db).buffers.filter((b) => b.kind === 'gym');
    await setPreferenceTool.run({ type: 'buffer', kind: 'gym', after_kinds: ['class'], gap_minutes: 30 } as never, 'commit');

    const dropCook = await setPreferenceTool.run({ type: 'buffer', kind: 'gym', after_kinds: ['cook'], remove: true } as never, 'commit');
    expect(dropCook.conflicts).toEqual([]);
    expect(dropCook.diff.pref_changes).toEqual(['removed the gym buffer after cook']);
    expect(gymRows()).toEqual([{ kind: 'gym', after_kinds: ['class'], gap_minutes: 30 }]); // class rule kept

    const noCook = await setPreferenceTool.run({ type: 'buffer', kind: 'gym', after_kinds: ['cook'], remove: true } as never, 'commit');
    expect(noCook.conflicts.some((c) => c.type === 'constraint' && c.rule === 'already')).toBe(true);

    const dropAll = await setPreferenceTool.run({ type: 'buffer', kind: 'gym', remove: true } as never, 'commit');
    expect(dropAll.diff.pref_changes).toEqual(['removed the gym buffer']);
    expect(gymRows()).toEqual([]);
  });

  test('gap_minutes 0 still removes, scoped to the named after_kinds', async () => {
    await setPreferenceTool.run({ type: 'buffer', kind: 'gym', after_kinds: ['class'], gap_minutes: 30 } as never, 'commit');
    await setPreferenceTool.run({ type: 'buffer', kind: 'gym', after_kinds: ['class'], gap_minutes: 0 } as never, 'commit');
    expect(getPreferences(db).buffers.filter((b) => b.kind === 'gym')).toEqual([{ kind: 'gym', after_kinds: ['cook'], gap_minutes: 30 }]);
  });

  test('changing the ordering rule FLIPS how the day reflows', () => {
    // Default (cook before gym): friends 6–8 → cook first, gym after.
    const before = reflowDay(db, DATE, anchorAt('18:00', '20:00'));
    const cook0 = before.knockOns.find((k) => k.event_id === 'cook')!.after!.starts_at;
    const gym0 = before.knockOns.find((k) => k.event_id === 'gym')!.after!.starts_at;
    expect(cook0 < gym0).toBe(true); // cook before gym

    // Flip the rule to gym-before-cook, then reflow the same day.
    setPreferenceTool.run({ type: 'order', before: 'gym', after: 'cook' } as never, 'commit');
    const after = reflowDay(db, DATE, anchorAt('18:00', '20:00'));
    const cook1 = after.knockOns.find((k) => k.event_id === 'cook')!.after!.starts_at;
    const gym1 = after.knockOns.find((k) => k.event_id === 'gym')!.after!.starts_at;
    expect(gym1 < cook1).toBe(true); // now gym before cook — the preference drove the engine
  });
});
