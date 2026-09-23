/**
 * The one path that commits a proposal. Used by the approve button AND by the
 * auto-apply of chat/drag, so there is exactly one place where a mutation can
 * reach the database and exactly one set of refusals guarding it.
 *
 * Every safety property of the old approve-click survives here: re-validate
 * against current state, never apply a blocking conflict, never report success
 * for a no-op, commit inside the tool's own transaction.
 */
import {
  describeConflict,
  getDb,
  getTool,
  isActionable,
  nowInTz,
  schema,
  severityOf,
  type Conflict,
  type DB,
  type Diff,
  type EventChange,
  type ProposalRow,
} from '@mise/core';
import { eq } from 'drizzle-orm';

export type ApplyStatus = 'applied' | 'blocked' | 'needs_review' | 'expired' | 'not_pending';

export interface ApplyResult {
  status: ApplyStatus;
  proposal: ProposalRow;
}

/**
 * Which tools may be applied WITHOUT a human clicking approve.
 *
 * The line is reversibility. Sai asked the assistant to stop asking him to
 * approve things — to just do them — so moves, additions and edits the agent
 * reaches for in chat auto-apply. The safety there is not a human clicking yes;
 * it's that applyProposal refuses any blocking conflict (a class can't move,
 * approved or not) and every change is one Cmd-Z from reversed.
 *
 * cancel_event is deliberately NOT here: a cancel always asks first (SPEC §0,
 * README). It deletes the event and whatever meal plan it was cooking, and undo
 * can't honestly put all of that back, so from chat it stays pending and shows
 * as a card Sai confirms. (The block popover's own delete files AND approves in
 * one step — its confirm tap already is the yes — so it doesn't go through here.)
 *
 * add_classes is here now: Sai asked that the assistant be able to rebuild his
 * schedule itself, classes included, so a chat "add my classes …" auto-applies
 * like everything else — safe because applyProposal still refuses any blocking
 * conflict and the created classes are one Cmd-Z from gone. Replacing a whole
 * semester (setup_semester) stays UI-only.
 */
const AUTO_APPLY = new Set([
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
  'edit_workout',
  'import_meals',
  'create_suite',
  'track_application',
]);

export function isAutoApplied(tool_name: string): boolean {
  return AUTO_APPLY.has(tool_name);
}

/**
 * Conflict identity, used to answer one question: "did a conflict appear that
 * wasn't there when this was proposed?" If so, the world changed underneath and
 * a human should look.
 *
 * Keyed on the RENDERED SENTENCE, not on event ids. Ids look like the stable
 * choice and are not: create_event mints a new id on every dry run, so an
 * id-keyed overlap conflict looked brand-new each time it was re-checked, and
 * every event created into a busy slot got stuck asking for approval it had
 * already been given. The sentence ("Going out with friends overlaps Gym by 60
 * min") is derived from the same state the check is about — it is identical
 * when nothing changed, and different exactly when something did.
 */
export function conflictKey(c: Conflict): string {
  return `${c.type}:${describeConflict(c)}`;
}

function hasNewConflict(fresh: Conflict[], storedKeys: Set<string>): boolean {
  return fresh.some((c) => !storedKeys.has(conflictKey(c)));
}

/**
 * You approve what you were shown. Since a placement now MAKES ROOM — pushing
 * whatever is in the way — the set of events a proposal touches depends on the
 * state of the day, and that state can move between "here's the diff" and "yes,
 * do it". A gym move that showed one line when it was proposed must not quietly
 * shove a study group that appeared in the meantime. So the diff is re-derived
 * at approve time and compared; if it grew a knock-on, that's needs_review, and
 * the card comes back updated rather than the change going through unseen.
 *
 * Keyed like conflicts are — on what it says, not on ids. create_event mints a
 * fresh id every dry run, so an id-keyed change never matches itself.
 */
function changeKey(c: EventChange): string {
  const w = (t: { starts_at: string; ends_at: string } | null) => (t ? `${t.starts_at}/${t.ends_at}` : '-');
  return `${c.title}|${c.instance_date}|${w(c.before)}|${w(c.after)}`;
}

function diffChanged(fresh: Diff, stored: Diff): boolean {
  const before = new Set(stored.changes.map(changeKey));
  const after = fresh.changes.map(changeKey);
  if (after.length !== before.size || after.some((k) => !before.has(k))) return true;
  // track_application keeps changes[] empty and describes its work in
  // application_changes — its rendered line names the resolved listing, so a
  // different winner at approve time (new listing synced in since the card
  // was filed) reads as a changed diff here too.
  const beforeApp = stored.application_changes ?? [];
  const afterApp = fresh.application_changes ?? [];
  return afterApp.length !== beforeApp.length || afterApp.some((l, i) => l !== beforeApp[i]);
}

function update(db: DB, id: string, patch: Partial<typeof schema.proposal.$inferInsert>): ProposalRow {
  db.update(schema.proposal).set(patch).where(eq(schema.proposal.id, id)).run();
  return db.select().from(schema.proposal).where(eq(schema.proposal.id, id)).get()!;
}

/** Record an empty diff with a reason, so a no-op never reads as success. */
function staleReview(db: DB, id: string, result: { diff: Diff; conflicts: Conflict[] }): ProposalRow {
  const conflicts: Conflict[] = [...result.conflicts];
  if (!conflicts.some((k) => k.type === 'constraint' && k.rule === 'stale')) {
    conflicts.push({
      type: 'constraint',
      rule: 'stale',
      message: 'Nothing left to apply — the events this targeted have changed since.',
    });
  }
  return update(db, id, { diff: result.diff as unknown, conflicts: conflicts as unknown });
}

export async function applyProposal(id: string): Promise<ApplyResult> {
  const db = getDb();
  const row = db.select().from(schema.proposal).where(eq(schema.proposal.id, id)).get();
  if (!row) throw new Error(`No proposal ${id}`);
  if (row.status !== 'pending') return { status: 'not_pending', proposal: row };

  // (1) Stored args must still parse — the schema may have moved under the row.
  const tool = getTool(row.tool_name);
  const parsed = tool && tool.kind === 'mutation' ? tool.argsSchema.safeParse(row.tool_args) : null;
  if (!tool || tool.kind !== 'mutation' || !parsed || !parsed.success) {
    return { status: 'expired', proposal: update(db, id, { status: 'expired' }) };
  }

  const storedKeys = new Set((row.conflicts as Conflict[]).map(conflictKey));

  // (1b) Nothing in the diff → nothing to apply. Never stamp approved on a no-op.
  if (!isActionable(row.diff as Diff)) return { status: 'blocked', proposal: row };

  // (2) Re-validate against CURRENT state; a conflict that wasn't there before
  // means the world changed underneath — stop and let a human look.
  const fresh = await tool.run(parsed.data, 'dry');
  if (hasNewConflict(fresh.conflicts, storedKeys)) {
    return {
      status: 'needs_review',
      proposal: update(db, id, { diff: fresh.diff as unknown, conflicts: fresh.conflicts as unknown }),
    };
  }

  // (3) A blocking conflict is never applied, by anyone, ever. (I4)
  if (fresh.conflicts.some((k) => severityOf(k) === 'blocking')) {
    return { status: 'blocked', proposal: row };
  }
  if (!isActionable(fresh.diff)) {
    return { status: 'needs_review', proposal: staleReview(db, id, fresh) };
  }

  // (3c) It still applies, and cleanly — but does it still do what the card
  // SAID? A placement makes room for itself, so an event that appeared in the
  // meantime would be pushed by this change without ever having been shown.
  // Update the card and let it be looked at.
  if (diffChanged(fresh.diff, row.diff as Diff)) {
    return {
      status: 'needs_review',
      proposal: update(db, id, { diff: fresh.diff as unknown, conflicts: fresh.conflicts as unknown }),
    };
  }

  // (4) Commit — the tool re-derives from current state inside a transaction.
  const commit = await tool.run(parsed.data, 'commit');
  if (commit.conflicts.some((k) => severityOf(k) === 'blocking')) {
    return { status: 'blocked', proposal: row };
  }
  if (!isActionable(commit.diff)) {
    return { status: 'needs_review', proposal: staleReview(db, id, commit) };
  }
  if (hasNewConflict(commit.conflicts, storedKeys)) {
    return {
      status: 'needs_review',
      proposal: update(db, id, { diff: commit.diff as unknown, conflicts: commit.conflicts as unknown }),
    };
  }

  return {
    status: 'applied',
    proposal: update(db, id, {
      status: 'approved',
      applied_at: nowInTz(),
      diff: commit.diff as unknown,
      conflicts: commit.conflicts as unknown,
    }),
  };
}
