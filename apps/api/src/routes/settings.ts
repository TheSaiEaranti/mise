/**
 * Onboarding answers overlay (SPEC §10 phase 1): the wizard writes a subset of
 * constraint defaults to data/settings.local.json. GET also returns the merged
 * effective constraints the validator/tools actually use.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { effectiveConstraints, readUserSettings, writeUserSettings } from '@mise/core';
import { parseBody } from '../lib/http';

const MealModeZ = z.enum(['batch', 'cook', 'out']);

/** Matches UserSettingsFile in config/settings.ts — every field optional. */
const SettingsZ = z.object({
  cook_cadence_days: z.number().int().min(1).max(14).optional(),
  covers_next_lunches: z.number().int().min(1).max(14).optional(),
  gym_target_per_week: z.number().int().min(0).max(14).optional(),
  gym_duration_minutes: z.number().int().min(5).max(720).optional(),
  meals: z
    .object({
      breakfast: MealModeZ.optional(),
      lunch: MealModeZ.optional(),
      dinner: MealModeZ.optional(),
    })
    .optional(),
  onboarded: z.boolean().optional(),
});

export const settingsRoute = new Hono();

settingsRoute.get('/', (c) => {
  return c.json({ settings: readUserSettings(), effective: effectiveConstraints() });
});

settingsRoute.put('/', async (c) => {
  const body = await parseBody(c, SettingsZ);
  if (!body.ok) return body.res;
  writeUserSettings(body.data);
  return c.json({ settings: readUserSettings() });
});
