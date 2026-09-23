/**
 * What a block SAYS beyond its name, and what "View details" opens.
 *
 * A block called "Gym" four times a week tells you nothing you didn't know. The
 * useful fact is WHICH session it is — "Chest and back" — and behind that, the
 * actual lifts. Same for "Cook lunches": the fact worth surfacing is what you
 * are cooking, and behind it the meals and their ingredients.
 *
 * Both are DERIVED, never stored on the instance: the workout comes from the
 * event's `workout` key (config/workouts.ts), the cooking from the
 * cook_assignment pointing at this (event, date). Storing them would mean two
 * copies of one truth.
 */
import { and, eq } from 'drizzle-orm';
import { workoutFor } from './workouts';
import type { DB } from './db/client';
import { schema } from './db/client';
import { fmtDateLong, fmtRange12 } from './time';
import type { CookAssignment, DetailSection, EventDetails, EventInstance, Meal } from './types';

/** `${event_id}|${date}` → its cook assignment, plus a per-event index. The
 *  per-event index is the fallback for a STANDALONE cook block dragged to a
 *  different day: its assignment stays keyed to the old date (nothing migrates
 *  it), but a standalone event holds at most one assignment (assignCook
 *  replaces event-wide), so matching by event_id alone is unambiguous. */
function cookAssignments(db: DB): { exact: Map<string, CookAssignment>; byEvent: Map<string, CookAssignment[]> } {
  const exact = new Map<string, CookAssignment>();
  const byEvent = new Map<string, CookAssignment[]>();
  for (const a of db.select().from(schema.cookAssignment).all()) {
    exact.set(`${a.event_id}|${a.date}`, a);
    const list = byEvent.get(a.event_id);
    if (list) list.push(a);
    else byEvent.set(a.event_id, [a]);
  }
  return { exact, byEvent };
}

/** The assignment for one instance: exact (event, date) match, else — for a
 *  non-recurring instance only — the event's single assignment from another
 *  date (the block was dragged since it was assigned). */
function assignmentFor(
  maps: { exact: Map<string, CookAssignment>; byEvent: Map<string, CookAssignment[]> },
  event_id: string,
  date: string,
  recurring: boolean,
): CookAssignment | undefined {
  const hit = maps.exact.get(`${event_id}|${date}`);
  if (hit) return hit;
  if (recurring) return undefined;
  const list = maps.byEvent.get(event_id);
  return list && list.length === 1 ? list[0] : undefined;
}

/** The name of what an assignment cooks — suite name, or the single meal's. */
function cookingLabel(a: CookAssignment, suites: Map<string, string>, meals: Map<string, Meal>): string | null {
  if (a.suite_id) return suites.get(a.suite_id) ?? null;
  if (a.meal_id) return meals.get(a.meal_id)?.name ?? null;
  return null;
}

/**
 * Add `subtitle` + `has_details` to instances. The week grid renders the
 * subtitle under the time; the popover fetches the rest on demand.
 */
export function enrichInstances(db: DB, instances: EventInstance[]): EventInstance[] {
  const assignments = cookAssignments(db);
  const suites = new Map(db.select().from(schema.mealSuite).all().map((s) => [s.id, s.name]));
  const meals = new Map(db.select().from(schema.meal).all().map((m) => [m.id, m]));

  return instances.map((i) => {
    if (i.kind === 'gym') {
      const w = workoutFor(db, i.workout);
      return { ...i, subtitle: w?.name ?? null, has_details: w !== null };
    }
    if (i.kind === 'cook') {
      const a = assignmentFor(assignments, i.event_id, i.instance_date, i.recurring);
      const label = a ? cookingLabel(a, suites, meals) : null;
      return { ...i, subtitle: label, has_details: label !== null };
    }
    // Anything else: its notes are the only thing behind the block.
    return { ...i, subtitle: null, has_details: Boolean(i.notes?.trim()) };
  });
}

/** One "Breakfast · Overnight oats" section listing the meal's ingredients. */
function mealSection(heading: string, meal: Meal): DetailSection {
  return {
    heading: `${heading} · ${meal.name}`,
    lines: meal.ingredients.map((line) => ({ label: line })),
  };
}

/** The full details for one instance — what the "View details" panel shows. */
export function detailsFor(db: DB, eventId: string, date: string): EventDetails | null {
  const ev = db.select().from(schema.event).where(eq(schema.event.id, eventId)).get();
  if (!ev) return null;

  // The instance's real times: a recurring event's row holds the pattern anchor,
  // not this occurrence, so recompose from the requested date.
  const startTime = ev.starts_at.slice(11);
  const endTime = ev.ends_at.slice(11);
  const when = `${fmtDateLong(date, 'EEE MMM d')} · ${fmtRange12(`${date}T${startTime}`, `${date}T${endTime}`)}`;

  const sections: DetailSection[] = [];
  let subtitle: string | null = null;
  let body: string | null = ev.notes?.trim() || null;

  if (ev.kind === 'gym') {
    const w = workoutFor(db, ev.workout);
    if (w) {
      subtitle = w.name;
      sections.push({
        heading: w.name,
        lines: w.exercises.map((e) => ({ label: e.name, value: e.load })),
      });
    }
  }

  if (ev.kind === 'cook') {
    // Exact (event, date) first; for a standalone block, fall back to its one
    // event-wide assignment (the block may have been dragged since assigning).
    let a = db
      .select()
      .from(schema.cookAssignment)
      .where(and(eq(schema.cookAssignment.event_id, eventId), eq(schema.cookAssignment.date, date)))
      .get();
    if (!a && ev.rrule === null) {
      const all = db.select().from(schema.cookAssignment).where(eq(schema.cookAssignment.event_id, eventId)).all();
      if (all.length === 1) a = all[0];
    }
    if (a) {
      const mealById = (id: string | null) =>
        id ? db.select().from(schema.meal).where(eq(schema.meal.id, id)).get() : undefined;
      if (a.suite_id) {
        const suite = db.select().from(schema.mealSuite).where(eq(schema.mealSuite.id, a.suite_id)).get();
        if (suite) {
          subtitle = suite.name;
          const b = mealById(suite.breakfast_meal_id);
          const l = mealById(suite.lunch_meal_id);
          if (b) sections.push(mealSection('Breakfast', b));
          if (l) sections.push(mealSection('Lunch', l));
          const method = [b?.details, l?.details].filter(Boolean).join('\n\n');
          body = method || body;
        }
      } else {
        const m = mealById(a.meal_id);
        if (m) {
          subtitle = m.name;
          sections.push(mealSection(m.meal_type === 'breakfast' ? 'Breakfast' : 'Lunch', m));
          body = m.details?.trim() || body;
        }
      }
    }
  }

  return { title: ev.title, subtitle, when, sections, body };
}
