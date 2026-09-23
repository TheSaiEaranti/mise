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
