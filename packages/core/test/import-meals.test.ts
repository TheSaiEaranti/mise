/**
 * import_meals — a pasted recipe becomes a meal on the Meals tab; a paste with
 * both a breakfast and a lunch pairs them into a suite INSIDE the tool (the
 * model makes one extraction call; the compound step is deterministic).
 * create_suite — pairing already-imported meals by loose name.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { importMealsTool } from '../src/tools/import-meals';
import { createSuiteTool } from '../src/tools/create-suite';
import { createMeal, listMeals, listSuites } from '../src/meals';
import { createProposal, type ProposalRow } from '../src/proposals';
import { undoProposal, isUndoable } from '../src/undo';
import { isActionable } from '../src/types';

let db: DB;
beforeEach(() => {
  db = resetDbForTests();
});

const OATS = { name: 'Overnight oats', meal_type: 'breakfast' as const, ingredients: ['2 cups rolled oats', '1 cup milk'], details: 'Mix, refrigerate.' };
const BOWLS = { name: 'Chipotle bowls', meal_type: 'lunch' as const, ingredients: ['1 lb chicken', '2 cups rice'] };

function approve(diff: unknown, tool_name: string): ProposalRow {
  const p = createProposal(db, { user_message: 'recipe', tool_name, tool_args: {}, diff: diff as never, conflicts: [] });
  db.update(schema.proposal).set({ status: 'approved' }).where(eq(schema.proposal.id, p.id)).run();
  return db.select().from(schema.proposal).where(eq(schema.proposal.id, p.id)).get()! as ProposalRow;
}

describe('import_meals', () => {
  test('one dish → an individual meal, no suite; dry writes nothing', async () => {
    const dry = await importMealsTool.run({ meals: [OATS] } as never, 'dry');
    expect(dry.conflicts).toEqual([]);
    expect(isActionable(dry.diff)).toBe(true);
    expect(dry.diff.meal_changes).toEqual(['Imported Overnight oats (breakfast) · 2 ingredients']);
    expect(listMeals(db)).toEqual([]);

    const { diff } = await importMealsTool.run({ meals: [OATS] } as never, 'commit');
    const all = listMeals(db);
    expect(all).toHaveLength(1);
    expect(all[0]!.ingredients).toEqual(['2 cups rolled oats', '1 cup milk']);
    expect(all[0]!.details).toBe('Mix, refrigerate.');
    expect(diff.meal_ids).toEqual([all[0]!.id]);
    expect(listSuites(db)).toEqual([]); // one dish alone never makes a suite
  });

  test('a breakfast AND a lunch in one call → suite created automatically', async () => {
    const { diff } = await importMealsTool.run({ meals: [OATS, BOWLS] } as never, 'commit');
    expect(listMeals(db)).toHaveLength(2);
    const suites = listSuites(db);
    expect(suites).toHaveLength(1);
    expect(suites[0]!.name).toBe('Overnight oats + Chipotle bowls');
    expect(diff.suite_ids).toEqual([suites[0]!.id]);
    expect(diff.meal_changes!.at(-1)).toContain('Suite:');
  });

  test('suite_name names the pair; re-import updates in place, no duplicate meal or suite', async () => {
    await importMealsTool.run({ meals: [OATS, BOWLS], suite_name: 'Prep day' } as never, 'commit');
    expect(listSuites(db)[0]!.name).toBe('Prep day');

    // Same names again with new ingredients → update, and no second suite.
    const again = await importMealsTool.run(
      { meals: [{ ...OATS, ingredients: ['3 cups oats'] }, BOWLS] } as never,
      'commit',
    );
    expect(listMeals(db)).toHaveLength(2);
    expect(listSuites(db)).toHaveLength(1);
    expect(listMeals(db).find((m) => m.meal_type === 'breakfast')!.ingredients).toEqual(['3 cups oats']);
    expect(again.diff.meal_changes![0]).toContain('Updated');
    expect(again.diff.meal_ids).toEqual([]); // nothing created → nothing for undo to delete
  });

  test('undo deletes the meals AND the suite it created', async () => {
    const { diff } = await importMealsTool.run({ meals: [OATS, BOWLS] } as never, 'commit');
    const row = approve(diff, 'import_meals');
    expect(isUndoable(row)).toBe(true);
    expect(undoProposal(db, row).ok).toBe(true);
    expect(listMeals(db)).toEqual([]);
    expect(listSuites(db)).toEqual([]);
  });
});

describe('create_suite', () => {
  test('pairs imported meals by loose name; undo removes just the suite', async () => {
    createMeal(db, OATS);
    createMeal(db, BOWLS);
    const { diff, conflicts } = await createSuiteTool.run({ breakfast: 'the oats', lunch: 'chipotle' } as never, 'commit');
    expect(conflicts).toEqual([]);
    const suites = listSuites(db);
    expect(suites).toHaveLength(1);
    expect(diff.suite_ids).toEqual([suites[0]!.id]);

    const row = approve(diff, 'create_suite');
    expect(undoProposal(db, row).ok).toBe(true);
    expect(listSuites(db)).toEqual([]);
    expect(listMeals(db)).toHaveLength(2); // meals untouched
  });

  test('unknown meal → refusal that lists what IS imported; nothing written', async () => {
    createMeal(db, OATS);
    const res = await createSuiteTool.run({ breakfast: 'pancakes', lunch: 'chipotle' } as never, 'dry');
    const c = res.conflicts[0]!;
    expect(c.type === 'constraint' && c.rule).toBe('unknown_meal');
    expect(c.type === 'constraint' && c.message).toContain('Overnight oats');
    expect(isActionable(res.diff)).toBe(false);
  });

  test('duplicate pair → refusal naming the existing suite', async () => {
    createMeal(db, OATS);
    createMeal(db, BOWLS);
    await createSuiteTool.run({ breakfast: 'Overnight oats', lunch: 'Chipotle bowls' } as never, 'commit');
    const res = await createSuiteTool.run({ breakfast: 'Overnight oats', lunch: 'Chipotle bowls' } as never, 'dry');
    expect(res.conflicts[0]!.type === 'constraint' && (res.conflicts[0] as { rule: string }).rule).toBe('duplicate_suite');
    expect(listSuites(db)).toHaveLength(1);
  });
});

describe('import_meals hardening', () => {
  test('the same dish listed twice in one call imports once (last entry wins)', async () => {
    await importMealsTool.run(
      { meals: [{ ...OATS, ingredients: ['1 cup oats'] }, OATS] } as never,
      'commit',
    );
    const all = listMeals(db);
    expect(all).toHaveLength(1);
    expect(all[0]!.ingredients).toEqual(['2 cups rolled oats', '1 cup milk']); // the later entry
  });

  test('dry never promises a suite that commit will dup-skip', async () => {
    await importMealsTool.run({ meals: [OATS, BOWLS] } as never, 'commit'); // suite exists now
    const dry = await importMealsTool.run({ meals: [OATS, BOWLS] } as never, 'dry');
    expect(dry.diff.meal_changes!.some((c) => c.startsWith('Suite:'))).toBe(false);
    const { diff } = await importMealsTool.run({ meals: [OATS, BOWLS] } as never, 'commit');
    expect(diff.suite_ids).toEqual([]);
    expect(listSuites(db)).toHaveLength(1);
  });
});
