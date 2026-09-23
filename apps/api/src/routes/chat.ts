/**
 * Chat: one agent turn per POST (SPEC §4 — no token streaming, the output is
 * a tool call). GET /messages returns recent history, newest-last.
 *
 * The assistant APPLIES what it decides, rather than parking it behind an
 * approve click. Sai asked for that in as many words: he doesn't want to
 * approve anything, cancels included, he wants to trust it. So the safety moved
 * from "a human clicks yes" to properties that hold whether or not anyone is
 * watching:
 *
 *   - applyProposal is the only door to the DB, and it refuses anything with a
 *     blocking conflict — a pinned class cannot move, approved or not (I4)
 *   - every applied change, cancels now included, is reversible with Cmd-Z
 *     (undo.ts recreates a cancelled event / drops a cancelled occurrence)
 *   - every change, applied or not, is a row in the proposal audit log
 *
 * The only things that still can't auto-apply are the user-initiated pinned
 * paths (setup_semester, add_classes, drop_class) — the chat model can't reach
 * those at all. A proposal the model somehow could not apply stays pending and
 * surfaces as a diff card.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { desc, sql } from 'drizzle-orm';
import { getDb, runAgentTurn, schema, severityOf, type Conflict, type ProposalRow } from '@mise/core';
import { parseBody, parseQuery } from '../lib/http';
import { applyProposal, isAutoApplied } from '../lib/apply';

const MessageZ = z.object({
  message: z.string().min(1).max(2000),
});

const MessagesQueryZ = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const chatRoute = new Hono();

chatRoute.post('/', async (c) => {
  const body = await parseBody(c, MessageZ);
  if (!body.ok) return body.res;

  /**
   * The policy, handed to the agent so each change lands BEFORE the next one is
   * planned. The agent still never writes — it calls this, and this is the same
   * applyProposal gate the approve button uses.
   */
  const settle = async (p: ProposalRow): Promise<ProposalRow> => {
    const blocked = (p.conflicts as Conflict[]).some((k) => severityOf(k) === 'blocking');
    if (!isAutoApplied(p.tool_name) || blocked) return p; // stays pending → a card to approve
    try {
      return (await applyProposal(p.id)).proposal;
    } catch {
      return p;
    }
  };

  const { reply, proposals } = await runAgentTurn(getDb(), body.data.message, { settle });
  return c.json({ reply, proposals });
});

chatRoute.get('/messages', (c) => {
  const q = parseQuery(c, MessagesQueryZ);
  if (!q.ok) return q.res;
  // rowid breaks created_at ties (minute precision) in insertion order.
  const rows = getDb()
    .select()
    .from(schema.chatMessage)
    .orderBy(desc(schema.chatMessage.created_at), desc(sql`rowid`))
    .limit(q.data.limit)
    .all()
    .reverse();
  return c.json({ messages: rows });
});
