/**
 * Reminders — a direct-UI feature (added from the Reminders tab, deleted from
 * the calendar), NOT the proposal/tool flow. Plain CRUD.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb, createReminder, listReminders, deleteReminder } from '@mise/core';
import { parseBody } from '../lib/http';

const ReminderZ = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:mm (24h)'),
  title: z.string().trim().min(1).max(200),
});

export const remindersRoute = new Hono();

remindersRoute.get('/', (c) => {
  const start = c.req.query('start');
  const end = c.req.query('end');
  return c.json({ reminders: listReminders(getDb(), start, end) });
});

remindersRoute.post('/', async (c) => {
  const body = await parseBody(c, ReminderZ);
  if (!body.ok) return body.res;
  const reminder = createReminder(getDb(), body.data);
  return c.json({ reminder }, 201);
});

remindersRoute.delete('/:id', (c) => {
  const ok = deleteReminder(getDb(), c.req.param('id'));
  if (!ok) return c.json({ error: `No reminder ${c.req.param('id')}` }, 404);
  return c.body(null, 204);
});
