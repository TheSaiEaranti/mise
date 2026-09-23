/**
 * fit_in_event end-to-end: "friends over at 8" pins the block AND reflows the
 * day around it in one commit, refuses when the stated time hits a class, and
 * the whole thing is one Cmd-Z away.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { fitInEventTool } from '../src/tools/fit-in-event';
import { getInstances } from '../src/schedule';
import { createProposal, type ProposalRow } from '../src/proposals';
import { undoProposal, isUndoable } from '../src/undo';
import { severityOf } from '../src/types';

let db: DB;
const DATE = '2026-09-09'; // a Wednesday

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

const day = () =>
  getInstances(db, DATE, DATE)
    .filter((i) => ['class', 'gym', 'cook', 'personal'].includes(i.kind))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .map((i) => `${i.starts_at.slice(11)}-${i.ends_at.slice(11)} ${i.kind} ${i.title}`);

describe('fit_in_event', () => {
  test('friends at 8 (no conflict): block added, nothing else moves', async () => {
    const { conflicts } = await fitInEventTool.run(
      { title: 'Friends over', kind: 'personal', date: DATE, start_time: '20:00', duration_minutes: 120 } as never,
      'commit',
    );
    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);
    expect(day()).toEqual([
      '15:30-17:00 class APPLD MACHINE LEARNING',
      '17:00-18:30 gym Gym',
      '18:45-19:45 cook Cook lunches',
      '20:00-22:00 personal Friends over',
    ]);
  });

  test('friends at 6 (over gym+cook): block pinned, cook+gym reflow after it in order', async () => {
    const { conflicts } = await fitInEventTool.run(
      { title: 'Friends over', kind: 'personal', date: DATE, start_time: '18:00', duration_minutes: 120 } as never,
      'commit',
    );
    expect(conflicts.filter((c) => severityOf(c) === 'blocking')).toEqual([]);
    expect(day()).toEqual([
      '15:30-17:00 class APPLD MACHINE LEARNING',
      '18:00-20:00 personal Friends over',
      '20:00-21:00 cook Cook lunches', // cook first…
      '21:30-23:00 gym Gym', // …then gym, with the 30-min post-cook buffer
    ]);
  });

  test('the reflowed gym keeps its workout label', async () => {
    await fitInEventTool.run(
      { title: 'Friends over', kind: 'personal', date: DATE, start_time: '18:00', duration_minutes: 120 } as never,
      'commit',
    );
    const gym = getInstances(db, DATE, DATE).find((i) => i.kind === 'gym')!;
    expect(gym.workout).toBe('legs');
  });

  test('a time that lands on a class is refused, nothing added', async () => {
    const { conflicts } = await fitInEventTool.run(
      { title: 'Coffee', kind: 'personal', date: DATE, start_time: '16:00', duration_minutes: 60 } as never,
      'commit',
    );
    expect(conflicts.some((c) => c.type === 'double_booked')).toBe(true);
    expect(getInstances(db, DATE, DATE).some((i) => i.title === 'Coffee')).toBe(false);
  });

  test('undo removes the block AND puts the reflowed cook/gym back', async () => {
    const { diff } = await fitInEventTool.run(
      { title: 'Friends over', kind: 'personal', date: DATE, start_time: '18:00', duration_minutes: 120 } as never,
      'commit',
    );
    const p = createProposal(db, { user_message: 'friends over at 6', tool_name: 'fit_in_event', tool_args: {}, diff, conflicts: [] });
    db.update(schema.proposal).set({ status: 'approved' }).where(eq(schema.proposal.id, p.id)).run();
    const row = db.select().from(schema.proposal).where(eq(schema.proposal.id, p.id)).get()! as ProposalRow;

    expect(isUndoable(row)).toBe(true);
    expect(undoProposal(db, row).ok).toBe(true);
    // Back to the original day, no 'Friends over'.
    expect(day()).toEqual([
      '15:30-17:00 class APPLD MACHINE LEARNING',
      '17:00-18:30 gym Gym',
      '18:45-19:45 cook Cook lunches',
    ]);
  });
});
