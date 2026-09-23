/**
 * create_suite — pair an already-imported breakfast with an already-imported
 * lunch ("make a suite of the oats and the chipotle bowls"). Suites are what a
 * cook block on the calendar gets assigned; cooking one makes both meals.
 *
 * Meals are matched by name (loose, like titlesMatch): the model quotes what
 * Sai said, which rarely matches the stored name letter-for-letter. An unknown
 * name is a refusal that LISTS the real names, so the model can retry with one.
 */
import { z } from 'zod';
import { getDb } from '../db/client';
import { createSuite, listMeals, listSuites, mealNameKey } from '../meals';
import type { Conflict, Diff, Meal, MealType, MutationToolDef, ToolResult } from '../types';

const ArgsZ = z.object({
  breakfast: z.string().min(1).max(80).describe('Name of the imported BREAKFAST meal.'),
  lunch: z.string().min(1).max(80).describe('Name of the imported LUNCH meal.'),
  name: z.string().max(80).optional().describe('Optional suite name; defaults to "Breakfast + Lunch".'),
});

export type CreateSuiteArgs = z.infer<typeof ArgsZ>;

/** Loose match: exact key, else one name containing the other. The model
 *  quotes Sai ("the oats", "my chipotle bowls"), so leading articles are
 *  stripped from the query before the containment check. */
function matchMeal(meals: Meal[], name: string, meal_type: MealType): Meal | undefined {
  const typed = meals.filter((m) => m.meal_type === meal_type);
  const key = mealNameKey(name).replace(/^(the|my|a|an) /, '');
  return (
    typed.find((m) => mealNameKey(m.name) === key) ??
    typed.find((m) => mealNameKey(m.name).includes(key) || key.includes(mealNameKey(m.name)))
  );
}

function unknownMeal(name: string, meal_type: MealType, meals: Meal[]): Conflict {
  const have = meals.filter((m) => m.meal_type === meal_type).map((m) => m.name);
  return {
    type: 'constraint',
    rule: 'unknown_meal',
    message:
      `No imported ${meal_type} named "${name}". ` +
      (have.length ? `Imported ${meal_type}s: ${have.join(', ')}.` : `No ${meal_type}s imported yet — paste the recipe first.`),
  };
}

async function run(args: CreateSuiteArgs, mode: 'dry' | 'commit'): Promise<ToolResult> {
  const db = getDb();
  const meals = listMeals(db);
  const empty: Diff = { summary: 'Create suite', changes: [], unchanged_pinned: [] };

  const b = matchMeal(meals, args.breakfast, 'breakfast');
  if (!b) return { diff: empty, conflicts: [unknownMeal(args.breakfast, 'breakfast', meals)] };
  const l = matchMeal(meals, args.lunch, 'lunch');
  if (!l) return { diff: empty, conflicts: [unknownMeal(args.lunch, 'lunch', meals)] };

  const dup = listSuites(db).find((s) => s.breakfast_meal_id === b.id && s.lunch_meal_id === l.id);
  if (dup) {
    return {
      diff: empty,
      conflicts: [
        { type: 'constraint', rule: 'duplicate_suite', message: `"${dup.name}" already pairs ${b.name} + ${l.name}.` },
      ],
    };
  }

  const suiteName = (args.name?.trim() || `${b.name} + ${l.name}`).slice(0, 80);
  const diff: Diff = {
    summary: `Meal suite · ${suiteName}`,
    detail: `${b.name} (breakfast) + ${l.name} (lunch)`,
    changes: [],
    unchanged_pinned: [],
    meal_changes: [`Suite: ${suiteName} = ${b.name} + ${l.name}`],
  };

  if (mode === 'dry') return { diff, conflicts: [] };

  const suite = createSuite(db, { name: suiteName, breakfast_meal_id: b.id, lunch_meal_id: l.id });
  return { diff: { ...diff, suite_ids: [suite.id] }, conflicts: [] };
}

export const createSuiteTool: MutationToolDef<CreateSuiteArgs> = {
  name: 'create_suite',
  description:
    'Pair an already-imported breakfast with an already-imported lunch into a suite (what a cook block gets assigned). Only for meals ALREADY on the Meals tab — when the recipes are in the message itself, use import_meals, which pairs them automatically.',
  parameters: z.toJSONSchema(ArgsZ, { io: 'input' }),
  argsSchema: ArgsZ,
  kind: 'mutation',
  run,
};
