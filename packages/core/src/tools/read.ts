/**
 * Read-only tools (SPEC §4): no proposals, no validator — straight data back
 * to the chat. get_schedule expands the calendar window; get_meals lists the
 * imported meals and suites (compact — results are truncated at 1500 chars).
 */
import { z } from 'zod';
import { getDb } from '../db/client';
import { getInstances } from '../schedule';
import { listMeals, listSuites } from '../meals';
import { DATE_RE, timeOf } from '../time';
import type { ReadToolDef } from '../types';

const MAX_ROWS = 200;

const ScheduleArgsZ = z.object({
  start_date: z.string().regex(DATE_RE).describe('First date of the window, YYYY-MM-DD (inclusive).'),
  end_date: z.string().regex(DATE_RE).describe('Last date of the window, YYYY-MM-DD (inclusive).'),
});

export type GetScheduleArgs = z.infer<typeof ScheduleArgsZ>;

export const getScheduleTool: ReadToolDef<GetScheduleArgs> = {
  name: 'get_schedule',
  description:
    'Read the calendar: every event instance between two dates (recurring classes expanded). Use this to see what is scheduled before proposing changes. Read-only.',
  parameters: z.toJSONSchema(ScheduleArgsZ, { io: 'input' }),
  argsSchema: ScheduleArgsZ,
  kind: 'read',
  async run(args) {
    const instances = getInstances(getDb(), args.start_date, args.end_date).slice(0, MAX_ROWS);
    return {
      events: instances.map((i) => ({
        id: i.event_id,
        title: i.title,
        kind: i.kind,
        date: i.instance_date,
        start: timeOf(i.starts_at),
        end: timeOf(i.ends_at),
        pinned: i.pinned,
        location: i.location,
      })),
    };
  },
};

const MealsArgsZ = z.object({});

export type GetMealsArgs = z.infer<typeof MealsArgsZ>;

export const getMealsTool: ReadToolDef<GetMealsArgs> = {
  name: 'get_meals',
  description:
    'List the imported meals (name + breakfast/lunch) and the suites pairing them. Use before create_suite to see what exists. Read-only.',
  parameters: z.toJSONSchema(MealsArgsZ, { io: 'input' }),
  argsSchema: MealsArgsZ,
  kind: 'read',
  async run() {
    const db = getDb();
    const meals = listMeals(db);
    const byId = new Map(meals.map((m) => [m.id, m.name]));
    return {
      meals: meals.map((m) => ({ name: m.name, type: m.meal_type, ingredients: m.ingredients.length })),
      suites: listSuites(db).map((s) => ({
        name: s.name,
        breakfast: byId.get(s.breakfast_meal_id) ?? '?',
        lunch: byId.get(s.lunch_meal_id) ?? '?',
      })),
    };
  },
};
