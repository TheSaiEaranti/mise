/**
 * Two things Sai asked for: the assistant should stop asking to approve, so a
 * cancel now UNDOES (Cmd-Z brings it back); and it should stop stacking a second
 * "Cook lunches" when one already exists.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { cancelEventTool } from '../src/tools/cancel-event';
import { createEventTool } from '../src/tools/create-event';
import { createProposal, type ProposalRow } from '../src/proposals';
import { undoProposal, isUndoable } from '../src/undo';
import { getInstances } from '../src/schedule';

process.env.MISE_SETTINGS_PATH = '/nonexistent/settings.json';

let db: DB;

beforeEach(() => {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'Fall', start_date: '2026-09-01', end_date: '2026-12-15', timezone: 'America/Chicago' })
    .run();
  db.insert(schema.event)
    .values([
      {
        id: 'gym1', semester_id: 's1', title: 'Gym', kind: 'gym',
        starts_at: '2026-09-08T17:00', ends_at: '2026-09-08T18:30',
        pinned: false, rrule: null, source: 'manual', location: 'Gregory', notes: null, color: null, workout: null,
      },
      {
        id: 'lift', semester_id: 's1', title: 'Lift', kind: 'gym',
        starts_at: '2026-09-07T07:00', ends_at: '2026-09-07T08:00',
        pinned: false, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR', source: 'recurring', location: null, notes: null, color: null, workout: null,
      },
    ])
    .run();
});

/** Commit a cancel and record it as an approved proposal, the way the app does. */
async function cancelAndLog(args: Record<string, unknown>): Promise<ProposalRow> {
  const { diff, conflicts } = await cancelEventTool.run(args as never, 'commit');
  const p = createProposal(db, { user_message: 'cancel', tool_name: 'cancel_event', tool_args: args, diff, conflicts });
  db.update(schema.proposal).set({ status: 'approved' }).where(eq(schema.proposal.id, p.id)).run();
  return db.select().from(schema.proposal).where(eq(schema.proposal.id, p.id)).get()!;
}

const on = (date: string) => getInstances(db, date, date).map((i) => `${i.starts_at.slice(11)} ${i.title}`);

describe('a cancel is undoable now (so it need not ask first)', () => {
  test('cancel_event is in the undoable set', () => {
    expect(isUndoable({ tool_name: 'cancel_event', status: 'approved' })).toBe(true);
  });

  test('cancelling a one-off and undoing recreates it at the same time', async () => {
    const row = await cancelAndLog({ event_id: 'gym1', expect_title: 'Gym' });
    expect(on('2026-09-08')).not.toContain('17:00 Gym'); // gone

    const res = undoProposal(db, row);
    expect(res.ok).toBe(true);

    const gym = db.select().from(schema.event).where(eq(schema.event.id, 'gym1')).get()!;
    expect(gym.starts_at).toBe('2026-09-08T17:00');
    expect(gym.ends_at).toBe('2026-09-08T18:30');
    expect(gym.kind).toBe('gym');
    expect(gym.location).toBe('Gregory');
    expect(on('2026-09-08')).toContain('17:00 Gym');
  });

  test('cancelling one occurrence of a recurring event and undoing brings that day back', async () => {
    // Cancel Wed 2026-09-09's Lift (a 'cancelled' exception), then undo it.
    expect(on('2026-09-09')).toContain('07:00 Lift');
    const row = await cancelAndLog({ event_id: 'lift', expect_title: 'Lift', date: '2026-09-09' });
    expect(on('2026-09-09')).not.toContain('07:00 Lift'); // hidden

    const res = undoProposal(db, row);
    expect(res.ok).toBe(true);
    expect(on('2026-09-09')).toContain('07:00 Lift'); // back
    // Monday's occurrence was never touched.
    expect(on('2026-09-07')).toContain('07:00 Lift');
    // The exception was actually removed, not just hidden.
    expect(db.select().from(schema.eventException).all()).toHaveLength(0);
  });
});

describe('do not stack a duplicate — but only a real one', () => {
  test('re-adding the SAME block at the SAME time on the SAME day is refused', async () => {
    await createEventTool.run(
      { title: 'Cook lunches', kind: 'cook', date: '2026-09-08', start_time: '18:00', duration_minutes: 60 } as never,
      'commit',
    );
    // The retry: identical title, same day, overlapping time → a true duplicate.
    const { diff, conflicts } = await createEventTool.run(
      { title: 'cook lunches', kind: 'cook', date: '2026-09-08', start_time: '18:00', duration_minutes: 60 } as never,
      'commit',
    );
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'duplicate')).toBe(true);
    expect(diff.changes).toHaveLength(0);
    expect(db.select().from(schema.event).all().filter((e) => e.title.toLowerCase() === 'cook lunches').length).toBe(1);
  });

  test('a same-title block on a DIFFERENT day is NOT a duplicate — three "Gym" days are fine', async () => {
    // "Gym" already exists in the seed (Mon 2026-09-08-ish). Add gym on other
    // days with different workouts — legitimate, must NOT be refused.
    const tue = await createEventTool.run(
      { title: 'Gym', kind: 'gym', date: '2026-09-09', start_time: '17:00', duration_minutes: 60, workout: 'Shoulder and arms' } as never,
      'commit',
    );
    expect(tue.conflicts.some((c) => c.type === 'constraint' && c.rule === 'duplicate')).toBe(false);
    const wed = await createEventTool.run(
      { title: 'Gym', kind: 'gym', date: '2026-09-10', start_time: '17:00', duration_minutes: 60, workout: 'Legs' } as never,
      'commit',
    );
    expect(wed.conflicts.some((c) => c.type === 'constraint' && c.rule === 'duplicate')).toBe(false);
    // Both were created, each with its workout label.
    const gyms = db.select().from(schema.event).all().filter((e) => e.title === 'Gym');
    expect(gyms.find((g) => g.starts_at.startsWith('2026-09-09'))?.workout).toBe('shoulders-arms');
    expect(gyms.find((g) => g.starts_at.startsWith('2026-09-10'))?.workout).toBe('legs');
  });

  test('a genuinely new title is still created', async () => {
    const { conflicts } = await createEventTool.run(
      { title: 'Dentist', kind: 'personal', date: '2026-09-10', start_time: '09:00', duration_minutes: 60 } as never,
      'commit',
    );
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'duplicate')).toBe(false);
    expect(db.select().from(schema.event).all().some((e) => e.title === 'Dentist')).toBe(true);
  });
});
