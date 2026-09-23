/**
 * Meals v2 — the CRUD spine under import_meals / create_suite and the Meals tab.
 *
 * A meal is a breakfast or a lunch with its ingredient lines kept verbatim (the
 * Meals tab lists them as the shopping list). A suite pairs one breakfast with
 * one lunch. A cook block on the calendar carries at most one assignment per
 * (event_id, date): a suite (cooking both meals) or a single meal.
 *
 * SQLite doesn't enforce our FKs (PRAGMA foreign_keys is off), so the deletes
 * cascade in code: removing a meal removes the suites built on it, and removing
 * a suite removes the cook assignments pointing at it.
 */
import { and, eq, gte, inArray, lte, or } from 'drizzle-orm';
import type { DB } from './db/client';
import { schema } from './db/client';
import { newId } from './proposals';
import { DEFAULT_TZ, nowInTz } from './time';
import type { CookAssignment, Meal, MealSuite, MealType } from './types';

export type { CookAssignment, Meal, MealSuite, MealType };

/** "Overnight Oats " and "overnight oats" are the same meal. */
export function mealNameKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function listMeals(db: DB): Meal[] {
  return db.select().from(schema.meal).all().sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function findMealByName(db: DB, name: string, meal_type?: MealType): Meal | undefined {
  const key = mealNameKey(name);
  return listMeals(db).find((m) => (!meal_type || m.meal_type === meal_type) && mealNameKey(m.name) === key);
}

export function createMeal(
  db: DB,
  input: { name: string; meal_type: MealType; ingredients: string[]; details?: string },
): Meal {
  const row: Meal = {
    id: newId('meal'),
    name: input.name.trim(),
    meal_type: input.meal_type,
    ingredients: input.ingredients.map((i) => i.trim()).filter(Boolean),
    details: (input.details ?? '').trim(),
    created_at: nowInTz(DEFAULT_TZ),
  };
  db.insert(schema.meal).values(row).run();
  return row;
}

/** Re-importing an existing meal updates it in place (same id). */
export function updateMeal(
  db: DB,
  id: string,
  input: { name: string; meal_type: MealType; ingredients: string[]; details?: string },
): void {
  db.update(schema.meal)
    .set({
      name: input.name.trim(),
      meal_type: input.meal_type,
      ingredients: input.ingredients.map((i) => i.trim()).filter(Boolean),
      details: (input.details ?? '').trim(),
    })
    .where(eq(schema.meal.id, id))
    .run();
}

/** Removes the meal, every suite built on it, and every assignment of those. */
export function deleteMeal(db: DB, id: string): boolean {
  const existing = db.select().from(schema.meal).where(eq(schema.meal.id, id)).get();
  if (!existing) return false;
  db.transaction((tx) => {
    const suites = tx
      .select()
      .from(schema.mealSuite)
      .where(or(eq(schema.mealSuite.breakfast_meal_id, id), eq(schema.mealSuite.lunch_meal_id, id)))
      .all();
    if (suites.length > 0) {
      const suiteIds = suites.map((s) => s.id);
      tx.delete(schema.cookAssignment).where(inArray(schema.cookAssignment.suite_id, suiteIds)).run();
      tx.delete(schema.mealSuite).where(inArray(schema.mealSuite.id, suiteIds)).run();
    }
    tx.delete(schema.cookAssignment).where(eq(schema.cookAssignment.meal_id, id)).run();
    tx.delete(schema.meal).where(eq(schema.meal.id, id)).run();
  });
  return true;
}

export function listSuites(db: DB): MealSuite[] {
  return db.select().from(schema.mealSuite).all().sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function createSuite(
  db: DB,
  input: { name: string; breakfast_meal_id: string; lunch_meal_id: string },
): MealSuite {
  const row: MealSuite = {
    id: newId('suite'),
    name: input.name.trim(),
    breakfast_meal_id: input.breakfast_meal_id,
    lunch_meal_id: input.lunch_meal_id,
    created_at: nowInTz(DEFAULT_TZ),
  };
  db.insert(schema.mealSuite).values(row).run();
  return row;
}

export function deleteSuite(db: DB, id: string): boolean {
  const existing = db.select().from(schema.mealSuite).where(eq(schema.mealSuite.id, id)).get();
  if (!existing) return false;
  db.transaction((tx) => {
    tx.delete(schema.cookAssignment).where(eq(schema.cookAssignment.suite_id, id)).run();
    tx.delete(schema.mealSuite).where(eq(schema.mealSuite.id, id)).run();
  });
  return true;
}

/** Assign what a cook block is cooking. Replaces any existing assignment for
 *  that (event_id, date) — a cook session makes one suite (or one meal). For a
 *  STANDALONE event (no rrule) every assignment on that event_id is replaced,
 *  not just the same-date one: a standalone block that was dragged to another
 *  day keeps exactly one assignment, so the old-date row can never resurface
 *  if the block is dragged back. */
export function assignCook(
  db: DB,
  input: { event_id: string; date: string } & ({ suite_id: string; meal_id?: null } | { meal_id: string; suite_id?: null }),
): CookAssignment {
  const row: CookAssignment = {
    id: newId('asg'),
    event_id: input.event_id,
    date: input.date,
    suite_id: input.suite_id ?? null,
    meal_id: input.meal_id ?? null,
    created_at: nowInTz(DEFAULT_TZ),
  };
  const event = db.select().from(schema.event).where(eq(schema.event.id, input.event_id)).get();
  const standalone = event !== undefined && event.rrule === null;
  db.transaction((tx) => {
    const gone = standalone
      ? eq(schema.cookAssignment.event_id, input.event_id)
      : and(eq(schema.cookAssignment.event_id, input.event_id), eq(schema.cookAssignment.date, input.date));
    tx.delete(schema.cookAssignment).where(gone).run();
    tx.insert(schema.cookAssignment).values(row).run();
  });
  return row;
}

/** All assignments, or those with date within [start, end] inclusive. */
export function listAssignments(db: DB, start?: string, end?: string): CookAssignment[] {
  const rows =
    start && end
      ? db
          .select()
          .from(schema.cookAssignment)
          .where(and(gte(schema.cookAssignment.date, start), lte(schema.cookAssignment.date, end)))
          .all()
      : db.select().from(schema.cookAssignment).all();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/** Returns false if the cook block had no assignment. */
export function clearAssignment(db: DB, event_id: string, date: string): boolean {
  const existing = db
    .select()
    .from(schema.cookAssignment)
    .where(and(eq(schema.cookAssignment.event_id, event_id), eq(schema.cookAssignment.date, date)))
    .get();
  if (!existing) return false;
  db.delete(schema.cookAssignment).where(eq(schema.cookAssignment.id, existing.id)).run();
  return true;
}

/** The human name of what a cook block is cooking ("Oats + Chipotle bowls"),
 *  or null when unassigned. Used for the block subtitle and details. */
export function assignmentLabel(db: DB, a: CookAssignment): string | null {
  if (a.suite_id) {
    const suite = db.select().from(schema.mealSuite).where(eq(schema.mealSuite.id, a.suite_id)).get();
    return suite?.name ?? null;
  }
  if (a.meal_id) {
    const meal = db.select().from(schema.meal).where(eq(schema.meal.id, a.meal_id)).get();
    return meal?.name ?? null;
  }
  return null;
}
