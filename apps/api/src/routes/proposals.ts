/**
 * The proposal lifecycle — the heart of I2.
 *
 * POST /            the drag path (and any UI-originated mutation): tool dry
 *                   run → Proposal row. Identical code path to chat.
 * POST /:id/approve re-derives everything from CURRENT DB state: re-run dry,
 *                   compare conflicts to the stored ones, block/re-prompt/commit.
 *                   Never replays a stored diff.
 * POST /:id/reject  pending → rejected.
 *
 * Proposal rows are the audit log — status changes only, never deletes.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { desc, eq, sql } from 'drizzle-orm';
import {
  getDb,
  getTool,
  isActionable,
  nowInTz,
  schema,
  severityOf,
  type Conflict,
  type DB,
  type Diff,
  type ProposalRow,
} from '@mise/core';
import { issuesOf, parseBody, parseQuery } from '../lib/http';
import { runDryAndPropose } from '../lib/propose';
import { applyProposal } from '../lib/apply';
import { undoProposal, isUndoable } from '@mise/core/undo';

// ---------------------------------------------------------------------------
// Conflict identity: type + identifying fields, deliberately EXCLUDING the
// human message/title text (times in messages shift with the diff; identity
// does not). "A new conflict appeared" = a fresh key not in the stored set.
// ---------------------------------------------------------------------------

/** Conflict identity now lives in lib/apply.ts, next to the only code that
 *  compares conflicts — this route just delegates to applyProposal. */
export { conflictKey } from '../lib/apply';

function updateProposal(
  db: DB,
  id: string,
  patch: Partial<typeof schema.proposal.$inferInsert>,
): ProposalRow {
  db.update(schema.proposal).set(patch).where(eq(schema.proposal.id, id)).run();
  return db.select().from(schema.proposal).where(eq(schema.proposal.id, id)).get()!;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const ListQueryZ = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'),
});

const CreateBodyZ = z.object({
  tool_name: z.string().min(1),
  /** Validated below with the tool's OWN argsSchema — same as the agent loop. */
  tool_args: z.unknown(),
  user_message: z.string().max(2000).optional(),
});

export const proposalsRoute = new Hono();

proposalsRoute.get('/', (c) => {
  const q = parseQuery(c, ListQueryZ);
  if (!q.ok) return q.res;
  const db = getDb();
  const base = db.select().from(schema.proposal);
  const filtered = q.data.status === 'all' ? base : base.where(eq(schema.proposal.status, q.data.status));
  const rows = filtered
    .orderBy(desc(schema.proposal.created_at), desc(sql`rowid`))
    .limit(100)
    .all();
  return c.json({ proposals: rows });
});

proposalsRoute.get('/:id', (c) => {
  const id = c.req.param('id');
  const row = getDb().select().from(schema.proposal).where(eq(schema.proposal.id, id)).get();
  if (!row) return c.json({ error: `No proposal ${id}` }, 404);
  return c.json({ proposal: row });
});

/**
 * THE DRAG PATH. A drag in the week view posts here with the same tool name
 * and args the chat agent would emit — identical code path, no shortcut.
 */
proposalsRoute.post('/', async (c) => {
  const body = await parseBody(c, CreateBodyZ);
  if (!body.ok) return body.res;

  const tool = getTool(body.data.tool_name);
  if (!tool) {
    return c.json({ error: `Unknown tool "${body.data.tool_name}"` }, 400);
  }
  if (tool.kind !== 'mutation') {
    return c.json(
      { error: `"${tool.name}" is a read tool — it answers directly and never creates a proposal` },
      400,
    );
  }

  const args = tool.argsSchema.safeParse(body.data.tool_args ?? {});
  if (!args.success) {
    return c.json({ error: `Invalid arguments for ${tool.name}`, issues: issuesOf(args.error) }, 400);
  }

  const proposal = await runDryAndPropose(tool, args.data as Record<string, unknown>, body.data.user_message);
  return c.json({ proposal }, 201);
});

/**
 * The proposal has nothing left to apply: record the empty diff and make sure
 * the card says why, so the user sees "this no longer does anything" rather
 * than a success state for a no-op.
 */
function staleReview(db: DB, id: string, result: { diff: Diff; conflicts: Conflict[] }): ProposalRow {
  const conflicts: Conflict[] = [...result.conflicts];
  if (!conflicts.some((k) => k.type === 'constraint' && k.rule === 'stale')) {
    conflicts.push({
      type: 'constraint',
      rule: 'stale',
      message: 'Nothing left to apply — the events this proposal targeted have changed since you saw it.',
    });
  }
  return updateProposal(db, id, { diff: result.diff as unknown, conflicts: conflicts as unknown });
}

/**
 * Approve — the explicit path, still here for anything that is NOT auto-applied
 * (a cancel, a semester replace) and for a proposal the assistant left pending
 * because it was blocked. All the real work lives in applyProposal, which the
 * chat and drag paths call too, so there is one gate and not three.
 */
proposalsRoute.post('/:id/approve', async (c) => {
  const id = c.req.param('id');
  const db = getDb();
  const exists = db.select().from(schema.proposal).where(eq(schema.proposal.id, id)).get();
  if (!exists) return c.json({ error: `No proposal ${id}` }, 404);

  const res = await applyProposal(id);
  if (res.status === 'applied') return c.json({ status: 'applied', proposal: res.proposal });
  if (res.status === 'not_pending') {
    return c.json({ error: `Proposal is ${res.proposal.status}, not pending`, proposal: res.proposal }, 409);
  }
  if (res.status === 'expired') {
    return c.json(
      { status: 'expired', error: 'Stored tool arguments no longer parse — proposal expired', proposal: res.proposal },
      409,
    );
  }
  return c.json({ status: res.status, proposal: res.proposal }, 409);
});

/**
 * Cmd-Z. Undo the most recent change that hasn't already been undone, walking
 * back through history one call at a time. This is what makes auto-apply safe:
 * everything the assistant or a drag does lands as an approved proposal, so one
 * primitive reverses the lot regardless of where the change came from.
 *
 * "Already undone" = an approved 'undo' proposal points at it. That's what stops
 * a second Cmd-Z from re-undoing the same thing instead of stepping further back.
 */
proposalsRoute.post('/undo-last', (c) => {
  const db = getDb();

  const undoneIds = new Set(
    db
      .select()
      .from(schema.proposal)
      .where(eq(schema.proposal.tool_name, 'undo'))
      .all()
      .map((u) => (u.tool_args as { proposal_id?: string })?.proposal_id)
      .filter((id): id is string => typeof id === 'string'),
  );

  const candidates = db
    .select()
    .from(schema.proposal)
    .where(eq(schema.proposal.status, 'approved'))
    .orderBy(desc(schema.proposal.created_at), desc(sql`rowid`))
    .all();

  const target = candidates.find(
    (p) => p.tool_name !== 'undo' && isUndoable(p) && !undoneIds.has(p.id),
  );
  if (!target) return c.json({ ok: false, reason: 'Nothing left to undo.' }, 200);

  const res = undoProposal(db, target);
  if (!res.ok) return c.json({ ok: false, reason: res.reason ?? 'Could not undo that.' }, 200);

  return c.json({
    ok: true,
    undone_id: target.id,
    summary: (target.diff as Diff).summary,
    proposal: res.proposal,
  });
});

/**
 * Undo an applied change. Auto-applying is only fair if taking it back is one
 * click — see packages/core/src/undo.ts for why this reverts from the committed
 * diff rather than replaying an inverse.
 */
proposalsRoute.post('/:id/undo', (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const row = db.select().from(schema.proposal).where(eq(schema.proposal.id, id)).get();
  if (!row) return c.json({ error: `No proposal ${id}` }, 404);

  const res = undoProposal(db, row);
  if (!res.ok) return c.json({ error: res.reason ?? 'Cannot undo that.' }, 409);
  return c.json({ ok: true, proposal: res.proposal });
});

proposalsRoute.post('/:id/reject', (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const row = db.select().from(schema.proposal).where(eq(schema.proposal.id, id)).get();
  if (!row) return c.json({ error: `No proposal ${id}` }, 404);
  if (row.status !== 'pending') {
    return c.json({ error: `Proposal is ${row.status}, not pending`, proposal: row }, 409);
  }
  const rejected = updateProposal(db, id, { status: 'rejected' });
  return c.json({ proposal: rejected });
});
