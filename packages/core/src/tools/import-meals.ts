/**
 * import_meals — Sai pastes a recipe into chat and the AI projects it into the
 * Meals tab: name, breakfast/lunch, and the ingredient lines verbatim.
 *
 * The suite decision is DELIBERATELY inside the tool, not left to the model:
 * one call may carry several meals, and if it contains both a breakfast and a
 * lunch they are paired into a suite automatically ("if i give both lunch and
 * breakfast make it a suite"). The 30B reliably makes ONE extraction call; it
 * does not reliably follow up with a second create-the-suite call, so the tool
 * does the compound step itself (same lesson as slot_between_classes).
 *
 * Re-importing a meal with the same name updates it in place (Sai iterates on
 * recipes); only meals/suites CREATED here are listed for undo.
 */
import { z } from 'zod';
import { getDb } from '../db/client';
import { createMeal, createSuite, findMealByName, listSuites, mealNameKey, updateMeal } from '../meals';
import type { Diff, MutationToolDef, ToolResult } from '../types';

const MealZ = z.object({
  name: z.string().min(1).max(80).describe('The dish name, e.g. "Overnight oats".'),
  meal_type: z.enum(['breakfast', 'lunch']).describe('Which meal this is.'),
  ingredients: z
    .array(z.string().min(1).max(160))
    .min(1)
    .max(40)
    .describe('EVERY ingredient line from the recipe, verbatim ("2 cups rolled oats").'),
  details: z.string().max(4000).optional().describe('The method / instructions text, if given.'),
});

const ArgsZ = z.object({
  meals: z.array(MealZ).min(1).max(4).describe('All meals in the message — one entry per dish.'),
  suite_name: z
    .string()
    .max(80)
    .optional()
    .describe('Optional name for the suite when both a breakfast and a lunch are given.'),
});

export type ImportMealsArgs = z.infer<typeof ArgsZ>;

async function run(args: ImportMealsArgs, mode: 'dry' | 'commit'): Promise<ToolResult> {
  const db = getDb();

  // The model sometimes lists one dish twice; last entry wins, so a repeat can
  // never produce two rows of the same meal in one call.
  const byKey = new Map<string, (typeof args.meals)[number]>();
  for (const m of args.meals) byKey.set(`${m.meal_type}|${mealNameKey(m.name)}`, m);
  const meals = [...byKey.values()];

  const existing = meals.map((m) => findMealByName(db, m.name, m.meal_type));
  const breakfast = meals.find((m) => m.meal_type === 'breakfast');
  const lunch = meals.find((m) => m.meal_type === 'lunch');
  const pair = breakfast && lunch ? { breakfast, lunch } : null;
  const suiteName = pair
    ? (args.suite_name?.trim() || `${pair.breakfast.name.trim()} + ${pair.lunch.name.trim()}`).slice(0, 80)
    : null;

  // Would the suite actually be created? Both meals already imported AND
  // already paired → no. Decided here so the dry diff never promises a suite
  // the commit will skip.
  const willCreateSuite =
    pair !== null &&
    !(existing[meals.indexOf(pair.breakfast)] &&
      existing[meals.indexOf(pair.lunch)] &&
      listSuites(db).some(
        (s) =>
          s.breakfast_meal_id === existing[meals.indexOf(pair.breakfast)]!.id &&
          s.lunch_meal_id === existing[meals.indexOf(pair.lunch)]!.id,
      ));

  const lines = meals.map((m, i) => {
    const verb = existing[i] ? 'Updated' : 'Imported';
    return `${verb} ${m.name.trim()} (${m.meal_type}) · ${m.ingredients.length} ingredients`;
  });
  if (pair && willCreateSuite) lines.push(`Suite: ${suiteName} = ${pair.breakfast.name.trim()} + ${pair.lunch.name.trim()}`);

  const diff: Diff = {
    summary: pair
      ? `Meal suite · ${suiteName}`
      : `Import ${meals.map((m) => m.name.trim()).join(', ')}`,
    detail: 'On the Meals tab, ingredients included',
    changes: [],
    unchanged_pinned: [],
    meal_changes: lines,
  };

  if (mode === 'dry') return { diff, conflicts: [] };

  const meal_ids: string[] = [];
  const suite_ids: string[] = [];
  db.transaction(() => {
    const rows = meals.map((m, i) => {
      const found = existing[i];
      if (found) {
        updateMeal(db, found.id, m);
        return { ...found, ...m };
      }
      const created = createMeal(db, m);
      meal_ids.push(created.id);
      return created;
    });
    if (pair && suiteName) {
      const b = rows[meals.indexOf(pair.breakfast)]!;
      const l = rows[meals.indexOf(pair.lunch)]!;
      const dup = listSuites(db).some(
        (s) => s.breakfast_meal_id === b.id && s.lunch_meal_id === l.id,
      );
      if (!dup) suite_ids.push(createSuite(db, { name: suiteName, breakfast_meal_id: b.id, lunch_meal_id: l.id }).id);
    }
  });

  return { diff: { ...diff, meal_ids, suite_ids }, conflicts: [] };
}

export const importMealsTool: MutationToolDef<ImportMealsArgs> = {
  name: 'import_meals',
  description:
    'Import pasted recipes onto the Meals tab: each dish becomes a meal (breakfast or lunch) with its ingredient lines kept verbatim for the shopping list. If the SAME message contains both a breakfast and a lunch, pass BOTH in one call — the tool pairs them into a suite automatically. Never use create_event for a recipe.',
  parameters: z.toJSONSchema(ArgsZ, { io: 'input' }),
  argsSchema: ArgsZ,
  kind: 'mutation',
  run,
};
