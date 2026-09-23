/**
 * Reverting an applied proposal.
 *
 * Auto-applying changes is only defensible if taking them back is one click, so
 * undo is a first-class operation, not an inverse the UI has to reconstruct.
 *
 * It reverts from the COMMITTED DIFF plus current DB state, so it handles the
 * case a hand-rolled "inverse shift" gets wrong: moving one instance of a
 * recurring event doesn't move a row, it creates an exception plus a brand-new
 * override row. The true inverse is to delete both — not to shift the original
 * id back, which would find nothing.
 *
 * The undo is itself written to the audit log as its own proposal row: the
 * point of the log is that you can see everything that ever happened, and an
 * undo is something that happened.
 */
import { and, eq } from 'drizzle-orm';
import type { DB } from './db/client';
import { schema } from './db/client';
import { createProposal, type ProposalRow } from './proposals';
import { getSplit, writeSplit, type WorkoutSplit } from './workouts';
import { getPreferences, writePreferences, type Preferences } from './preferences';
import { deleteReminder } from './reminders';
import { deleteMeal, deleteSuite } from './meals';
import type { InternshipApplication } from './internships';
import { effectiveConstraints, writeUserSettings } from '@mise/config/settings';
import { dateOf, nowInTz } from './time';
import type { Diff, EventChange } from './types';

/**
 * Which tools produce a change we can put back.
 *
 * cancel_event is here now: Sai wants the assistant to just do things and not
 * ask, so a cancel auto-applies — which is only fair if Cmd-Z brings it back.
 * A cancelled recurring occurrence undoes cleanly (drop the exception row). A
 * cancelled standalone event is recreated from the committed change: it returns
 * at the same time with the same title and kind.
 */
const UNDOABLE_TOOLS = new Set([
  'shift_events',
  'set_event_time',
  'set_recurring_days',
  'set_recurrence',
  'slot_between_classes',
  'fit_around_classes',
  'set_gym_splits',
  'set_duration',
  'copy_day',
  'place_adjacent',
  'set_workout',
  'create_event',
  'fit_in_event',
  'set_preference',
  'set_reminder',
  'add_classes',
  'block_free_time',
  'reschedule_to_free_slot',
  'cancel_event',
  'edit_workout',
  'import_meals',
  'create_suite',
  'track_application',
]);

export function isUndoable(row: Pick<ProposalRow, 'tool_name' | 'status'>): boolean {
  return row.status === 'approved' && UNDOABLE_TOOLS.has(row.tool_name);
}

/** Find the event row that a committed change currently lives in. */
function resolveMoved(
  db: DB,
  ch: EventChange & { before: NonNullable<EventChange['before']>; after: NonNullable<EventChange['after']> },
): { kind: 'standalone'; id: string } | { kind: 'override'; overrideId: string; exceptionId: string } | null {
  const originalDate = dateOf(ch.before.starts_at);

  // A moved instance of a recurring event leaves an exception behind, pointing
  // at the standalone override row that now holds the new time.
  const exc = db
    .select()
    .from(schema.eventException)
    .where(
      and(
        eq(schema.eventException.event_id, ch.event_id),
        eq(schema.eventException.original_date, originalDate),
        eq(schema.eventException.status, 'moved'),
      ),
    )
    .get();

  if (exc?.override_event_id) {
    return { kind: 'override', overrideId: exc.override_event_id, exceptionId: exc.id };
  }

  const row = db.select().from(schema.event).where(eq(schema.event.id, ch.event_id)).get();
  if (!row) return null;
  // Only if it is still where the proposal put it — otherwise something else
  // has moved it since and undoing would clobber that.
  if (row.starts_at !== ch.after.starts_at) return null;
  return { kind: 'standalone', id: ch.event_id };
}

export interface UndoResult {
  ok: boolean;
  reason?: string;
  proposal?: ProposalRow;
}

export function undoProposal(db: DB, row: ProposalRow): UndoResult {
  if (!isUndoable(row)) {
    return { ok: false, reason: `A ${row.tool_name.replaceAll('_', ' ')} can't be undone automatically.` };
  }

  // A gym-split edit isn't an event change — its undo is to put the whole split
  // back to the snapshot taken before the edit (edit-workout.ts stores it).
  if (row.tool_name === 'edit_workout') {
    const d = row.diff as Diff;
    const before = d.workout_before as WorkoutSplit | undefined;
    if (!before) return { ok: false, reason: "That split change can't be undone." };
    // The whole-split undo overwrites, so it's only safe when the split is still
    // where THIS edit left it. If a newer split edit landed since, restoring the
    // old snapshot would silently wipe it — refuse and let the newer one be
    // undone first (Cmd-Z / undo-last already does newest-first). The event path
    // guards the same way via resolveMoved.
    const after = d.workout_after as WorkoutSplit | undefined;
    if (after && JSON.stringify(getSplit(db)) !== JSON.stringify(after)) {
      return { ok: false, reason: "Your split changed after this — undo the newer change first." };
    }
    writeSplit(db, before);
    const audit = createProposal(db, {
      user_message: `Undo: ${row.user_message}`,
      tool_name: 'undo',
      tool_args: { proposal_id: row.id },
      diff: {
        summary: `Undo · ${d.summary}`,
        changes: [],
        unchanged_pinned: [],
        workout_changes: (d.workout_changes ?? []).map((c) => `Undid: ${c}`),
      },
      conflicts: [],
    });
    db.update(schema.proposal).set({ status: 'approved', applied_at: nowInTz() }).where(eq(schema.proposal.id, audit.id)).run();
    return { ok: true, proposal: audit };
  }

  // A standing-preferences edit: same snapshot-restore as the split, with the
  // same "refuse if a newer edit landed" guard.
  if (row.tool_name === 'set_preference') {
    const d = row.diff as Diff;
    // Sleep-hours edits live in the settings overlay, not the DB prefs — restore
    // the old window there. (Same "refuse if a newer edit landed" guard.)
    if (d.sleep_before !== undefined) {
      if (d.sleep_after !== undefined && effectiveConstraints().sleep.protect !== d.sleep_after) {
        return { ok: false, reason: 'Your sleep hours changed after this — undo the newer change first.' };
      }
      writeUserSettings({ sleep_protect: d.sleep_before });
      const audit = createProposal(db, {
        user_message: `Undo: ${row.user_message}`,
        tool_name: 'undo',
        tool_args: { proposal_id: row.id },
        diff: { summary: `Undo · ${d.summary}`, changes: [], unchanged_pinned: [], pref_changes: (d.pref_changes ?? []).map((c) => `Undid: ${c}`) },
        conflicts: [],
      });
      db.update(schema.proposal).set({ status: 'approved', applied_at: nowInTz() }).where(eq(schema.proposal.id, audit.id)).run();
      return { ok: true, proposal: audit };
    }
    const before = d.pref_before as Preferences | undefined;
    if (!before) return { ok: false, reason: "That preference change can't be undone." };
    const after = d.pref_after as Preferences | undefined;
    if (after && JSON.stringify(getPreferences(db)) !== JSON.stringify(after)) {
      return { ok: false, reason: 'Your preferences changed after this — undo the newer change first.' };
    }
    writePreferences(db, before);
    const audit = createProposal(db, {
      user_message: `Undo: ${row.user_message}`,
      tool_name: 'undo',
      tool_args: { proposal_id: row.id },
      diff: {
        summary: `Undo · ${d.summary}`,
        changes: [],
        unchanged_pinned: [],
        pref_changes: (d.pref_changes ?? []).map((c) => `Undid: ${c}`),
      },
      conflicts: [],
    });
    db.update(schema.proposal).set({ status: 'approved', applied_at: nowInTz() }).where(eq(schema.proposal.id, audit.id)).run();
    return { ok: true, proposal: audit };
  }

  // A reminder the AI set: delete it. (If Sai already removed it by hovering
  // the marker, deleteReminder is a harmless no-op.)
  if (row.tool_name === 'set_reminder') {
    const d = row.diff as Diff;
    if (d.reminder_id) deleteReminder(db, d.reminder_id);
    const audit = createProposal(db, {
      user_message: `Undo: ${row.user_message}`,
      tool_name: 'undo',
      tool_args: { proposal_id: row.id },
      diff: { summary: `Undo · ${d.summary}`, changes: [], unchanged_pinned: [], reminder_changes: (d.reminder_changes ?? []).map((c) => `Removed: ${c}`) },
      conflicts: [],
    });
    db.update(schema.proposal).set({ status: 'approved', applied_at: nowInTz() }).where(eq(schema.proposal.id, audit.id)).run();
    return { ok: true, proposal: audit };
  }

  // Imported meals / created suites: remove what the proposal ADDED (deleteMeal
  // cascades through suites built on the meal and any cook assignments). A meal
  // the import merely UPDATED is left as-is — undo removes, it doesn't rewind.
  if (row.tool_name === 'import_meals' || row.tool_name === 'create_suite') {
    const d = row.diff as Diff;
    for (const id of d.suite_ids ?? []) deleteSuite(db, id);
    for (const id of d.meal_ids ?? []) deleteMeal(db, id);
    const audit = createProposal(db, {
      user_message: `Undo: ${row.user_message}`,
      tool_name: 'undo',
      tool_args: { proposal_id: row.id },
      diff: { summary: `Undo · ${d.summary}`, changes: [], unchanged_pinned: [], meal_changes: (d.meal_changes ?? []).map((c) => `Removed: ${c}`) },
      conflicts: [],
    });
    db.update(schema.proposal).set({ status: 'approved', applied_at: nowInTz() }).where(eq(schema.proposal.id, audit.id)).run();
    return { ok: true, proposal: audit };
  }

  // An internship-application change: put the application row back the way it
  // was (null = it wasn't tracked), from the snapshot track-application.ts
  // stored in the diff. Same "refuse if a newer edit landed" guard as the
  // split/preference undos.
  if (row.tool_name === 'track_application') {
    const d = row.diff as Diff;
    const id = d.application_internship_id;
    if (!id) return { ok: false, reason: "That application change can't be undone." };
    const before = (d.application_before ?? null) as InternshipApplication | null;
    const after = (d.application_after ?? null) as InternshipApplication | null;
    const current =
      db
        .select()
        .from(schema.internshipApplication)
        .where(eq(schema.internshipApplication.internship_id, id))
        .get() ?? null;
    if (JSON.stringify(current) !== JSON.stringify(after)) {
      return { ok: false, reason: 'That application changed after this — undo the newer change first.' };
    }
    if (before === null) {
      db.delete(schema.internshipApplication).where(eq(schema.internshipApplication.internship_id, id)).run();
    } else {
      db.insert(schema.internshipApplication)
        .values(before)
        .onConflictDoUpdate({
          target: schema.internshipApplication.internship_id,
          set: { status: before.status, notes: before.notes, applied_at: before.applied_at, updated_at: before.updated_at },
        })
        .run();
    }
    const audit = createProposal(db, {
      user_message: `Undo: ${row.user_message}`,
      tool_name: 'undo',
      tool_args: { proposal_id: row.id },
      diff: {
        summary: `Undo · ${d.summary}`,
        changes: [],
        unchanged_pinned: [],
        application_changes: (d.application_changes ?? []).map((c) => `Undid: ${c}`),
      },
      conflicts: [],
    });
    db.update(schema.proposal).set({ status: 'approved', applied_at: nowInTz() }).where(eq(schema.proposal.id, audit.id)).run();
    return { ok: true, proposal: audit };
  }

  // A gym-session relabel: put the old workout key back on the event (and any
  // override rows), the mirror of what set_workout wrote.
  if (row.tool_name === 'set_workout') {
    const rel = (row.diff as Diff).workout_relabel;
    if (!rel) return { ok: false, reason: "That label change can't be undone." };
    db.transaction((tx) => {
      tx.update(schema.event).set({ workout: rel.before }).where(eq(schema.event.id, rel.event_id)).run();
      const excs = tx.select().from(schema.eventException).where(eq(schema.eventException.event_id, rel.event_id)).all();
      for (const x of excs) {
        if (x.override_event_id) tx.update(schema.event).set({ workout: rel.before }).where(eq(schema.event.id, x.override_event_id)).run();
      }
    });
    const audit = createProposal(db, {
      user_message: `Undo: ${row.user_message}`,
      tool_name: 'undo',
      tool_args: { proposal_id: row.id },
      diff: { summary: `Undo · ${(row.diff as Diff).summary}`, changes: [], unchanged_pinned: [] },
      conflicts: [],
    });
    db.update(schema.proposal).set({ status: 'approved', applied_at: nowInTz() }).where(eq(schema.proposal.id, audit.id)).run();
    return { ok: true, proposal: audit };
  }

  const diff = row.diff as Diff;
  const changes = diff.changes ?? [];
  if (changes.length === 0) return { ok: false, reason: 'That change did nothing to undo.' };

  const semester = db.select().from(schema.semester).limit(1).get();

  // Plan every write first: if any part of it can't be reverted cleanly, revert
  // nothing. A half-undone rearrange is worse than a refused one.
  type Plan =
    | { op: 'restore'; id: string; starts_at: string; ends_at: string }
    | { op: 'drop_override'; overrideId: string; exceptionId: string }
    | { op: 'delete'; id: string }
    | { op: 'uncancel_recurring'; exceptionId: string }
    | { op: 'recreate'; ch: EventChange };
  const plan: Plan[] = [];

  for (const ch of changes) {
    if (ch.before && ch.after) {
      const target = resolveMoved(db, ch as never);
      if (!target) {
        return { ok: false, reason: `${ch.title} has changed since — undo it by hand.` };
      }
      plan.push(
        target.kind === 'standalone'
          ? { op: 'restore', id: target.id, starts_at: ch.before.starts_at, ends_at: ch.before.ends_at }
          : { op: 'drop_override', overrideId: target.overrideId, exceptionId: target.exceptionId },
      );
    } else if (!ch.before && ch.after) {
      // Created by the proposal → undo is to remove it.
      const row2 = db.select().from(schema.event).where(eq(schema.event.id, ch.event_id)).get();
      if (!row2) continue; // already gone; nothing to do
      plan.push({ op: 'delete', id: ch.event_id });
    } else if (ch.before && !ch.after) {
      // Cancelled by the proposal → undo is to bring it back. Two shapes:
      // a recurring occurrence was hidden by a 'cancelled' exception (the base
      // event still exists) → drop that exception; or a standalone row was
      // deleted outright → recreate it at the same time.
      const base = db.select().from(schema.event).where(eq(schema.event.id, ch.event_id)).get();
      if (base) {
        const exc = db
          .select()
          .from(schema.eventException)
          .where(
            and(
              eq(schema.eventException.event_id, ch.event_id),
              eq(schema.eventException.original_date, ch.instance_date),
              eq(schema.eventException.status, 'cancelled'),
            ),
          )
          .get();
        if (!exc) continue; // already un-cancelled; nothing to do
        plan.push({ op: 'uncancel_recurring', exceptionId: exc.id });
      } else {
        if (!semester) return { ok: false, reason: `${ch.title} can't be restored — no semester.` };
        plan.push({ op: 'recreate', ch });
      }
    } else {
      return { ok: false, reason: "That change can't be undone automatically." };
    }
  }

  db.transaction((tx) => {
    for (const p of plan) {
      if (p.op === 'restore') {
        tx.update(schema.event)
          .set({ starts_at: p.starts_at, ends_at: p.ends_at })
          .where(eq(schema.event.id, p.id))
          .run();
      } else if (p.op === 'drop_override') {
        // Deleting the exception un-hides the original occurrence; deleting the
        // override removes the copy. The recurring event is whole again.
        tx.delete(schema.event).where(eq(schema.event.id, p.overrideId)).run();
        tx.delete(schema.eventException).where(eq(schema.eventException.id, p.exceptionId)).run();
      } else if (p.op === 'uncancel_recurring') {
        tx.delete(schema.eventException).where(eq(schema.eventException.id, p.exceptionId)).run();
      } else if (p.op === 'recreate') {
        tx.insert(schema.event)
          .values({
            id: p.ch.event_id,
            semester_id: semester!.id,
            title: p.ch.title,
            kind: p.ch.kind,
            starts_at: p.ch.before!.starts_at,
            ends_at: p.ch.before!.ends_at,
            pinned: p.ch.pinned,
            rrule: null,
            source: 'agent',
            location: p.ch.location ?? null,
            notes: null,
          })
          .run();
      } else {
        tx.delete(schema.event).where(eq(schema.event.id, p.id)).run();
      }
    }
  });

  // The undo goes in the log too — the point of the log is that nothing is invisible.
  const undoDiff: Diff = {
    summary: `Undo · ${diff.summary}`,
    changes: changes.map((ch) => ({
      ...ch,
      before: ch.after,
      after: ch.before,
    })),
    unchanged_pinned: [],
  };
  const audit = createProposal(db, {
    user_message: `Undo: ${row.user_message}`,
    tool_name: 'undo',
    tool_args: { proposal_id: row.id },
    diff: undoDiff,
    conflicts: [],
  });
  db.update(schema.proposal)
    .set({ status: 'approved', applied_at: nowInTz() })
    .where(eq(schema.proposal.id, audit.id))
    .run();

  return { ok: true, proposal: audit };
}
