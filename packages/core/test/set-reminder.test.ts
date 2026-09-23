/**
 * set_reminder — the AI sets a reminder ("remind me to call the bank Thursday
 * at 2pm"); it's a marker, not a block, so no conflicts. Undo deletes it.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { setReminderTool } from '../src/tools/set-reminder';
import { listReminders } from '../src/reminders';
import { createProposal, type ProposalRow } from '../src/proposals';
import { undoProposal, isUndoable } from '../src/undo';
import { isActionable } from '../src/types';

let db: DB;
beforeEach(() => {
  db = resetDbForTests();
});

describe('set_reminder', () => {
  test('dry describes it and writes nothing; commit creates the reminder', async () => {
    const dry = await setReminderTool.run({ date: '2026-09-10', time: '14:00', title: 'Call the bank' } as never, 'dry');
    expect(dry.conflicts).toEqual([]);
    expect(dry.diff.reminder_changes?.[0]).toContain('Call the bank');
    expect(isActionable(dry.diff)).toBe(true);
    expect(listReminders(db)).toEqual([]); // dry wrote nothing

    const { diff } = await setReminderTool.run({ date: '2026-09-10', time: '14:00', title: 'Call the bank' } as never, 'commit');
    const all = listReminders(db);
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe('Call the bank');
    expect(all[0]!.date).toBe('2026-09-10');
    expect(all[0]!.time).toBe('14:00');
    expect(diff.reminder_id).toBe(all[0]!.id);
  });

  test('undo deletes the reminder it set', async () => {
    const { diff } = await setReminderTool.run({ date: '2026-09-10', time: '14:00', title: 'Dentist' } as never, 'commit');
    expect(listReminders(db)).toHaveLength(1);
    const p = createProposal(db, { user_message: 'remind me', tool_name: 'set_reminder', tool_args: {}, diff, conflicts: [] });
    db.update(schema.proposal).set({ status: 'approved' }).where(eq(schema.proposal.id, p.id)).run();
    const row = db.select().from(schema.proposal).where(eq(schema.proposal.id, p.id)).get()! as ProposalRow;
    expect(isUndoable(row)).toBe(true);
    expect(undoProposal(db, row).ok).toBe(true);
    expect(listReminders(db)).toEqual([]); // gone
  });
});
