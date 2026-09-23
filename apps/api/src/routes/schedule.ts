/**
 * GET /api/schedule — expanded event instances for a date window.
 * Defaults to Monday of the current week through +13 days (two visible weeks).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  DATE_RE,
  addDaysWall,
  detailsFor,
  enrichInstances,
  getDb,
  getInstances,
  todayInTz,
  weekMonday,
} from '@mise/core';
import { parseQuery } from '../lib/http';

const QueryZ = z.object({
  start: z.string().regex(DATE_RE, 'must be YYYY-MM-DD').optional(),
  end: z.string().regex(DATE_RE, 'must be YYYY-MM-DD').optional(),
});

export const scheduleRoute = new Hono();

scheduleRoute.get('/', (c) => {
  const q = parseQuery(c, QueryZ);
  if (!q.ok) return q.res;
  const start = q.data.start ?? weekMonday(todayInTz());
  const end = q.data.end ?? addDaysWall(start, 13);
  // enrich: each block learns WHICH gym session it is / WHAT it is cooking.
  return c.json({ instances: enrichInstances(getDb(), getInstances(getDb(), start, end)) });
});

const DetailsQueryZ = z.object({
  date: z.string().regex(DATE_RE, 'must be YYYY-MM-DD'),
});

/** GET /api/schedule/:eventId/details?date= — what "View details" opens. */
scheduleRoute.get('/:eventId/details', (c) => {
  const q = parseQuery(c, DetailsQueryZ);
  if (!q.ok) return q.res;
  const details = detailsFor(getDb(), c.req.param('eventId'), q.data.date);
  if (!details) return c.json({ error: 'No such event' }, 404);
  return c.json({ details });
});
