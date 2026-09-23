/**
 * Meals v2 — the Meals tab and the cook-block popover, NOT the proposal flow.
 * Meals are CREATED by the AI (import_meals via chat); suites are created by
 * the AI (create_suite) OR by hand from the Meals tab (POST /suites below —
 * a direct-UI action, like deleting a reminder). Either way the individual
 * meals stay: a suite is a pairing that POINTS at its meals, never a merge.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  assignCook,
  clearAssignment,
  createSuite,
  deleteMeal,
  deleteSuite,
  getDb,
  listAssignments,
  listMeals,
  listSuites,
} from '@mise/core';
import { parseBody } from '../lib/http';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const AssignZ = z
  .object({
    event_id: z.string().min(1),
    date: z.string().regex(DATE_RE, 'date must be YYYY-MM-DD'),
    suite_id: z.string().min(1).optional(),
    meal_id: z.string().min(1).optional(),
  })
  .refine((v) => (v.suite_id !== undefined) !== (v.meal_id !== undefined), {
    message: 'exactly one of suite_id / meal_id',
  });

export const mealsRoute = new Hono();

/** Everything the Meals tab needs in one fetch: meals with their ingredient
 *  lines (the shopping list), and suites joined with their meal names. */
mealsRoute.get('/', (c) => {
  const db = getDb();
  const meals = listMeals(db);
  const byId = new Map(meals.map((m) => [m.id, m]));
  const suites = listSuites(db).map((s) => ({
    ...s,
    breakfast_name: byId.get(s.breakfast_meal_id)?.name ?? '?',
    lunch_name: byId.get(s.lunch_meal_id)?.name ?? '?',
  }));
  return c.json({ meals, suites });
});

// Assignments — registered before '/:id' so 'assignments' is never read as an id.
mealsRoute.get('/assignments', (c) => {
  const start = c.req.query('start');
  const end = c.req.query('end');
  return c.json({ assignments: listAssignments(getDb(), start, end) });
});

mealsRoute.put('/assignments', async (c) => {
  const body = await parseBody(c, AssignZ);
  if (!body.ok) return body.res;
  const { event_id, date, suite_id, meal_id } = body.data;
  const assignment = suite_id
    ? assignCook(getDb(), { event_id, date, suite_id })
    : assignCook(getDb(), { event_id, date, meal_id: meal_id! });
  return c.json({ assignment });
});

mealsRoute.delete('/assignments', (c) => {
  const event_id = c.req.query('event_id');
  const date = c.req.query('date');
  if (!event_id || !date) return c.json({ error: 'event_id and date are required' }, 400);
  const ok = clearAssignment(getDb(), event_id, date);
  if (!ok) return c.json({ error: `No assignment for ${event_id} on ${date}` }, 404);
  return c.body(null, 204);
});

const SuiteZ = z.object({
  breakfast_meal_id: z.string().min(1),
  lunch_meal_id: z.string().min(1),
  name: z.string().trim().max(80).optional(),
});

mealsRoute.post('/suites', async (c) => {
  const body = await parseBody(c, SuiteZ);
  if (!body.ok) return body.res;
  const db = getDb();
  const meals = listMeals(db);
  const b = meals.find((m) => m.id === body.data.breakfast_meal_id);
  const l = meals.find((m) => m.id === body.data.lunch_meal_id);
  if (!b || b.meal_type !== 'breakfast') return c.json({ error: 'breakfast_meal_id is not an imported breakfast' }, 400);
  if (!l || l.meal_type !== 'lunch') return c.json({ error: 'lunch_meal_id is not an imported lunch' }, 400);
  const dup = listSuites(db).find((s) => s.breakfast_meal_id === b.id && s.lunch_meal_id === l.id);
  if (dup) return c.json({ error: `"${dup.name}" already pairs ${b.name} + ${l.name}` }, 409);
  const suite = createSuite(db, {
    name: body.data.name || `${b.name} + ${l.name}`,
    breakfast_meal_id: b.id,
    lunch_meal_id: l.id,
  });
  return c.json({ suite: { ...suite, breakfast_name: b.name, lunch_name: l.name } }, 201);
});

mealsRoute.delete('/suites/:id', (c) => {
  const ok = deleteSuite(getDb(), c.req.param('id'));
  if (!ok) return c.json({ error: `No suite ${c.req.param('id')}` }, 404);
  return c.body(null, 204);
});

mealsRoute.delete('/:id', (c) => {
  const ok = deleteMeal(getDb(), c.req.param('id'));
  if (!ok) return c.json({ error: `No meal ${c.req.param('id')}` }, 404);
  return c.body(null, 204);
});
