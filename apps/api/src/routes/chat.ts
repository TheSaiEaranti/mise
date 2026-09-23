/**
 * Chat: one agent turn per POST (SPEC §4 — no token streaming, the output is
 * a tool call). GET /messages returns recent history, newest-last.
 *
 * The assistant APPLIES what it decides, rather than parking it behind an
 * approve click — except a cancel, which always asks first (SPEC §0; see
 * AUTO_APPLY in lib/apply.ts). Sai asked for that in as many words: he doesn't
 * want to approve small, reversible things, he wants to trust it. So for those
 * the safety moved from "a human clicks yes" to properties that hold whether or
 * not anyone is watching:
 *
 *   - applyProposal is the only door to the DB, and it refuses anything with a
 *     blocking conflict — a pinned class cannot move, approved or not (I4)
 *   - every applied change is reversible with Cmd-Z (undo.ts also recreates a
 *     cancelled event / drops a cancelled occurrence once a cancel is confirmed)
 *   - every change, applied or not, is a row in the proposal audit log
 *
 * What never auto-applies from chat: cancel_event (it waits on a confirm card),
 * and the user-initiated semester paths (setup_semester, drop_class), which the
 * chat model can't reach at all. A proposal the model somehow could not apply
 * stays pending and surfaces as a diff card too.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { desc, sql } from 'drizzle-orm';
import { getDb, runAgentTurn, schema } from '@mise/core';
import { parseBody, parseQuery } from '../lib/http';
import { settleForChat } from '../lib/apply';

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

  // settleForChat is the commit policy (lib/apply.ts): auto-apply what policy
  // allows through the one applyProposal gate; anything else stays pending.
  const { reply, proposals } = await runAgentTurn(getDb(), body.data.message, { settle: settleForChat });
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
