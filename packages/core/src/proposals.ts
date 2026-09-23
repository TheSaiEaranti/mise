/**
 * The shared dry-run/validate/persist path every mutation tool goes through.
 * Chat and drag hit the identical code (SPEC §9): tool → EventChange[] →
 * buildValidation → Proposal row.
 */
import { eq } from 'drizzle-orm';
import type { DB } from './db/client';
import { schema } from './db/client';
import { getInstances } from './schedule';
import { validate } from './validator';
import { effectiveConstraints } from '@mise/config/settings';
import { addDaysWall, dateOf, nowInTz } from './time';
import type {
  Conflict,
  Diff,
  EventChange,
  ProposedInstance,
  UnchangedPinned,
} from './types';

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 12)}`;
}

/** Smallest date window containing every change, padded a day each side so
 *  commute/overlap checks see the neighbors. */
export function windowFor(changes: EventChange[]): { start: string; end: string } | null {
  const dates: string[] = [];
  for (const c of changes) {
    if (c.before) dates.push(dateOf(c.before.starts_at), dateOf(c.before.ends_at));
    if (c.after) dates.push(dateOf(c.after.starts_at), dateOf(c.after.ends_at));
  }
  if (dates.length === 0) return null;
  dates.sort();
  return { start: addDaysWall(dates[0]!, -1), end: addDaysWall(dates[dates.length - 1]!, 1) };
}

export interface ValidationOutcome {
  conflicts: Conflict[];
  proposed: ProposedInstance[];
  unchanged_pinned: UnchangedPinned[];
}

/**
 * Apply changes to the current expanded window and validate. Pure with
 * respect to the DB (reads only) — used identically by dry and commit modes.
 */
export function buildValidation(db: DB, changes: EventChange[]): ValidationOutcome {
  const win = windowFor(changes);
  if (!win) return { conflicts: [], proposed: [], unchanged_pinned: [] };

  const current = getInstances(db, win.start, win.end);
  const proposed: ProposedInstance[] = current.map((i) => ({ ...i }));
  const touched = new Set<string>();
  const keyOf = (event_id: string, instance_date: string) => `${event_id}|${instance_date}`;

  for (const c of changes) {
    if (c.before) {
      const key = keyOf(c.event_id, dateOf(c.before.starts_at));
      const inst = proposed.find((i) => keyOf(i.event_id, i.instance_date) === key);
      if (!inst) continue; // instance vanished since diff was built; commit re-validates
      touched.add(key);
      if (c.after) {
        inst.original_starts_at = c.before.starts_at;
        inst.original_ends_at = c.before.ends_at;
        inst.starts_at = c.after.starts_at;
        inst.ends_at = c.after.ends_at;
        inst.instance_date = dateOf(c.after.starts_at);
      } else {
        inst.cancelled = true;
      }
    } else if (c.after) {
      const key = keyOf(c.event_id, dateOf(c.after.starts_at));
      touched.add(key);
      proposed.push({
        event_id: c.event_id,
        instance_date: dateOf(c.after.starts_at),
        title: c.title,
        kind: c.kind,
        starts_at: c.after.starts_at,
        ends_at: c.after.ends_at,
        pinned: c.pinned,
        location: c.location ?? null,
        notes: null,
        source: 'agent',
        recurring: false,
        color: null,
        workout: null,
        created: true,
      });
    }
  }

  const conflicts = validate({
    events: proposed,
    constraints: effectiveConstraints(),
  });

  const unchanged_pinned: UnchangedPinned[] = proposed
    .filter((i) => i.pinned && !touched.has(keyOf(i.event_id, i.instance_date)) && !i.cancelled)
    .map((i) => ({
      event_id: i.event_id,
      instance_date: i.instance_date,
      title: i.title,
      starts_at: i.starts_at,
      ends_at: i.ends_at,
    }));

  return { conflicts, proposed, unchanged_pinned };
}

export type ProposalRow = typeof schema.proposal.$inferSelect;

export function createProposal(
  db: DB,
  args: {
    user_message: string;
    tool_name: string;
    tool_args: Record<string, unknown>;
    diff: Diff;
    conflicts: Conflict[];
  },
): ProposalRow {
  const row = {
    id: newId('prop'),
    created_at: nowInTz(),
    user_message: args.user_message,
    tool_name: args.tool_name,
    tool_args: args.tool_args,
    diff: args.diff as unknown,
    conflicts: args.conflicts as unknown,
    status: 'pending' as const,
    applied_at: null,
  };
  db.insert(schema.proposal).values(row).run();
  return db.select().from(schema.proposal).where(eq(schema.proposal.id, row.id)).get()!;
}
