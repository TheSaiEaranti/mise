/**
 * Semester status + the onboarding wizard's review-and-approve step.
 * POST /proposal runs setup_semester DRY through the same proposal path as
 * everything else (I2) — the wizard has no direct-write shortcut.
 */
import { Hono } from 'hono';
import { getDb, getSemester, getTool, readUserSettings } from '@mise/core';
import { issuesOf } from '../lib/http';
import { runDryAndPropose } from '../lib/propose';

export const semesterRoute = new Hono();

semesterRoute.get('/', (c) => {
  return c.json({
    semester: getSemester(getDb()),
    onboarded: readUserSettings().onboarded ?? false,
  });
});

semesterRoute.post('/proposal', async (c) => {
  const tool = getTool('setup_semester');
  if (!tool || tool.kind !== 'mutation') throw new Error('setup_semester tool is missing from the registry');

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Request body must be valid JSON', issues: [] }, 400);
  }
  const parsed = tool.argsSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid semester setup', issues: issuesOf(parsed.error) }, 400);
  }

  const proposal = await runDryAndPropose(tool, parsed.data as Record<string, unknown>, 'Semester setup');
  return c.json({ proposal }, 201);
});
