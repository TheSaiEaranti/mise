/**
 * Event-level endpoints that are NOT schedule mutations.
 *
 * Recoloring changes no time, no pin, and nothing derived — it is cosmetic
 * metadata, so it saves directly rather than filing a proposal (the same
 * carve-out recipes and grocery checkboxes already have). Anything that moves,
 * creates, or cancels an event still goes through POST /api/proposals.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { EVENT_COLORS, EVENT_KINDS, setEventColor, setEventTitle, setKindColor } from '@mise/core';
import { parseBody } from '../lib/http';

export const eventsRoute = new Hono();

const TitleZ = z.object({ title: z.string().min(1).max(80) });

/** Rename an event (a recurring one renames every instance). Direct, like color. */
eventsRoute.patch('/:id/title', async (c) => {
  const body = await parseBody(c, TitleZ);
  if (!body.ok) return body.res;
  const res = setEventTitle(c.req.param('id'), body.data.title);
  if (!res.ok) return c.json({ error: 'Unknown event or invalid title' }, 400);
  return c.json({ ok: true });
});

const ColorZ = z.object({
  /** null clears the override, falling back to the kind's default color. */
  color: z.string().nullable(),
});

/** The palette the UI paints its swatches from — one source of truth. */
eventsRoute.get('/colors', (c) => c.json({ colors: EVENT_COLORS }));

eventsRoute.patch('/:id/color', async (c) => {
  const body = await parseBody(c, ColorZ);
  if (!body.ok) return body.res;

  const res = setEventColor(c.req.param('id'), body.data.color);
  if (!res.ok) return c.json({ error: 'Unknown event or color' }, 400);
  return c.json({ ok: true });
});

const KindColorZ = z.object({
  kind: z.enum(EVENT_KINDS as [string, ...string[]]),
  color: z.string().nullable(),
});

/** Recolor every event of a kind at once ("make all my gym blocks teal"). */
eventsRoute.patch('/color-by-kind', async (c) => {
  const body = await parseBody(c, KindColorZ);
  if (!body.ok) return body.res;

  const res = setKindColor(body.data.kind, body.data.color);
  if (!res.ok) return c.json({ error: 'Unknown color' }, 400);
  return c.json({ ok: true, updated: res.updated });
});
