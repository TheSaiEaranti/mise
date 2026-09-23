/**
 * Internships — the board + application tracker behind the Internships tab.
 * Listing rows are synced from community aggregator feeds (core/internships);
 * tracking a listing is a direct-UI action like reminders, NOT the proposal
 * flow. POST /sync can take ~10–30s on a real download — that's expected.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  getDb,
  getInternshipFacets,
  getInternshipLastSynced,
  getInternshipTracker,
  listInternships,
  setInternshipStatus,
  syncInternships,
} from '@mise/core';
import { parseBody, parseQuery } from '../lib/http';

const StatusZ = z.enum(['interested', 'applied', 'oa', 'interview', 'offer', 'rejected', 'ghosted']);

/** Query flags arrive as strings — only literal "true" turns a toggle on. */
const FlagZ = z.enum(['true', 'false']).transform((v) => v === 'true');

const ListQueryZ = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  term: z.string().optional(),
  status: StatusZ.optional(),
  activeOnly: FlagZ.optional(),
  trackedOnly: FlagZ.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sort: z.enum(['posted', 'updated', 'company']).optional(),
});

const SyncZ = z.object({ force: z.boolean().optional() });

const ApplicationZ = z.object({
  /** null = untrack (deletes the application row). */
  status: StatusZ.nullable(),
  /** Omitted = keep existing notes; string/null sets/clears them. */
  notes: z.string().max(2000).nullable().optional(),
});

export const internshipsRoute = new Hono();

/** The board: one page of listings + total, plus everything the filter bar
 *  needs (facets from active rows, last sync time) in one fetch. */
internshipsRoute.get('/', (c) => {
  const q = parseQuery(c, ListQueryZ);
  if (!q.ok) return q.res;
  const db = getDb();
  const { items, total } = listInternships(db, q.data);
  return c.json({
    items,
    total,
    lastSynced: getInternshipLastSynced(db),
    facets: getInternshipFacets(db),
  });
});

// Registered before '/:id/application' so 'tracker'/'sync' are never read as ids.
internshipsRoute.get('/tracker', (c) => {
  return c.json({ groups: getInternshipTracker(getDb()) });
});

internshipsRoute.post('/sync', async (c) => {
  const body = await parseBody(c, SyncZ);
  if (!body.ok) return body.res;
  const report = await syncInternships(getDb(), { force: body.data.force ?? false });
  return c.json(report);
});

internshipsRoute.put('/:id/application', async (c) => {
  const body = await parseBody(c, ApplicationZ);
  if (!body.ok) return body.res;
  const id = c.req.param('id');
  const item = setInternshipStatus(getDb(), id, body.data.status, body.data.notes);
  if (!item) return c.json({ error: `No internship ${id}` }, 404);
  return c.json({ item });
});
