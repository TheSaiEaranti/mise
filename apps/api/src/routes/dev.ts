/**
 * GET /api/dev/turns — the latest per-turn traces and request timings, for
 * the web app's dev latency panel. 404 unless devPanelEnabled().
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { recentTurnTraces } from '@mise/core';
import { parseQuery } from '../lib/http';
import { devPanelEnabled, recentRequests } from '../lib/dev-timing';

const QueryZ = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const devRoute = new Hono();

devRoute.use('*', async (c, next) => {
  if (!devPanelEnabled()) return c.json({ error: 'Not found' }, 404);
  return next();
});

devRoute.get('/turns', (c) => {
  const q = parseQuery(c, QueryZ);
  if (!q.ok) return q.res;
  return c.json({ turns: recentTurnTraces(q.data.limit), requests: recentRequests(q.data.limit) });
});
