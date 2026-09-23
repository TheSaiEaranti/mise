/**
 * Dev seed: a realistic UT Austin summer schedule around the current week.
 * Idempotent — wipes and re-inserts. Run: bun run seed
 */
import { getDb, schema } from '../packages/core/src/db/client';
import { todayInTz, weekMonday, addDaysWall, composeTs } from '../packages/core/src/time';
import { WORKOUT_ROTATION } from '../config/workouts';

const db = getDb();
const today = todayInTz();
const monday = weekMonday(today); // this week's Monday
const nextMonday = addDaysWall(monday, 7);

// Wipe (dev only — the proposal audit log is preserved on purpose).
// Chat history goes too: reseeding gives you a fresh calendar, and leaving the
// old conversation attached to it means the assistant reasons about events that
// no longer exist.
for (const t of [
  schema.eventException,
  schema.cookAssignment,
  schema.mealSuite,
  schema.meal,
  schema.event,
  schema.semester,
  schema.chatMessage,
]) {
  db.delete(t).run();
}

db.insert(schema.semester)
  .values({
    id: 'sem-summer26',
    name: 'Summer 2026',
    start_date: '2026-06-04',
    end_date: '2026-08-14',
    timezone: 'America/Chicago',
  })
  .run();

// --- Classes: pinned, weekly recurring -------------------------------------
db.insert(schema.event)
  .values([
    {
      id: 'evt-cs429',
      semester_id: 'sem-summer26',
      title: 'CS 429 Computer Organization',
      kind: 'class',
      starts_at: '2026-06-04T10:00',
      ends_at: '2026-06-04T11:30',
      pinned: true,
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH;UNTIL=20260814',
      source: 'recurring',
      location: 'GDC 2.216',
      notes: null,
    },
    {
      id: 'evt-m408d',
      semester_id: 'sem-summer26',
      title: 'M 408D Sequences & Series',
      kind: 'class',
      starts_at: '2026-06-04T13:00',
      ends_at: '2026-06-04T14:15',
      pinned: true,
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH;UNTIL=20260814',
      source: 'recurring',
      location: 'PMA 5.104',
      notes: null,
    },
  ])
  .run();

// --- Movable events for this week + next -----------------------------------
type Ev = typeof schema.event.$inferInsert;
const movables: Ev[] = [];
let n = 0;
function ev(
  date: string,
  start: string,
  end: string,
  kind: Ev['kind'],
  title: string,
  location: string | null = null,
  workout: string | null = null,
): Ev {
  return {
    id: `evt-seed-${n++}`,
    semester_id: 'sem-summer26',
    title,
    kind,
    starts_at: composeTs(date, start),
    ends_at: composeTs(date, end),
    pinned: false,
    rrule: null,
    source: 'manual',
    location,
    notes: null,
    workout,
  };
}

// The split alternates across gym sessions: chest-and-back, then shoulders-and-
// arms, then back around. (config/workouts.ts holds the actual lifts.)
let gymIndex = 0;
for (const wk of [monday, nextMonday]) {
  // Gym ×4: Mon, Tue, Thu, Sat 17:00–18:30 (inside the 16:00–19:00 window)
  for (const d of [0, 1, 3, 5]) {
    const workout = WORKOUT_ROTATION[gymIndex++ % WORKOUT_ROTATION.length]!;
    movables.push(ev(addDaysWall(wk, d), '17:00', '18:30', 'gym', 'Gym', 'Gregory Gym', workout));
  }
  // Cook every other day: Mon, Wed, Fri 18:45–19:45
  for (const d of [0, 2, 4]) movables.push(ev(addDaysWall(wk, d), '18:45', '19:45', 'cook', 'Cook lunches'));
}
movables.push(ev(addDaysWall(nextMonday, 1), '11:45', '12:30', 'personal', 'Advising appointment', 'GDC 1.302'));
db.insert(schema.event).values(movables).run();

// --- Meals v2: two meals paired into a suite, assigned to the first cook ----
db.insert(schema.meal)
  .values([
    {
      id: 'meal-oats',
      name: 'Overnight oats',
      meal_type: 'breakfast',
      ingredients: ['2 cups rolled oats', '1 cup milk', '2 tbsp chia seeds', '1 tbsp honey'],
      details: 'Mix it all and refrigerate overnight.',
      created_at: composeTs(monday, '08:00'),
    },
    {
      id: 'meal-chipotle-bowls',
      name: 'Chipotle Chicken Rice Bowls',
      meal_type: 'lunch',
      ingredients: ['2 lb chicken thighs', '2 cups rice', '1 can black beans', '1 cup corn', '2 limes'],
      details: 'Marinate chicken in chipotle, lime, garlic. Cook rice. Sear chicken, rest, slice. Assemble.',
      created_at: composeTs(monday, '08:01'),
    },
  ])
  .run();

db.insert(schema.mealSuite)
  .values({
    id: 'suite-oats-bowls',
    name: 'Oats + Chipotle bowls',
    breakfast_meal_id: 'meal-oats',
    lunch_meal_id: 'meal-chipotle-bowls',
    created_at: composeTs(monday, '08:02'),
  })
  .run();

const firstCook = movables.find((e) => e.kind === 'cook')!;
db.insert(schema.cookAssignment)
  .values({
    id: 'asg-seed-1',
    event_id: firstCook.id!,
    date: firstCook.starts_at!.slice(0, 10),
    suite_id: 'suite-oats-bowls',
    meal_id: null,
    created_at: composeTs(monday, '08:03'),
  })
  .run();

console.log(`Seeded: Summer 2026, 2 pinned classes, ${movables.length} movable events, 2 meals, 1 suite, 1 cook assignment.`);
console.log(`Weeks seeded: ${monday} and ${nextMonday}. Today: ${today}.`);
