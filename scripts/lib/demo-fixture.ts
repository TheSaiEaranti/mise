/**
 * A realistic, entirely fake Fall semester built around a given "today".
 *
 * Shared by scripts/latency-eval.ts (with a frozen today, so every run sees the
 * same calendar) and by the demo seed. No real personal data: the courses are
 * generic lower-division titles, the people and places are made up.
 *
 * Shape (weekly):
 *   MWF  M 340L Matrices              10:00–10:50  pinned
 *   MW   SDS 322E Data Science        14:00–15:30  pinned
 *   TTh  CS 331 Algorithms            11:00–12:30  pinned
 *   TTh  ECO 304K Microeconomics      15:30–17:00  pinned
 *   Gym  Mon + Fri + today's and tomorrow's weekday (one weekly series per day;
 *        on a Wednesday: Mon 17:00, Wed 17:00, Thu 17:30, Fri 16:00)
 *   Cook lunches  Sun 18:00, Tue 18:30 (60 min)
 * Tomorrow always has a pinned class after 3pm (ECO 304K on TTh, else a
 * pinned review session for it).
 * One-offs: a study group the day after `today` at 19:30, an advising
 * appointment two days after `today` at 13:00, a career fair next Tuesday.
 */
import { schema, type DB } from '../../packages/core/src/db/client';
import { addDaysWall, weekdayCode } from '../../packages/core/src/time';

export const DEMO_SEMESTER_ID = 'sem-fall26';

type Ev = typeof schema.event.$inferInsert;
type Day = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

/** Each weekday's gym slot, clear of that day's classes and cook session. */
const GYM_SLOTS: [Day, string, string, string][] = [
  ['MO', '17:00', '18:30', 'chest-back'],
  ['TU', '17:15', '18:15', 'legs'], // ECO ends 17:00, cook at 18:30
  ['WE', '17:00', '18:30', 'legs'],
  ['TH', '17:30', '19:00', 'shoulders-arms'],
  ['FR', '16:00', '17:30', 'chest-back'],
  ['SA', '17:30', '19:00', 'legs'],
  ['SU', '16:30', '18:00', 'shoulders-arms'], // cook at 18:00
];

/** First date on/after `from` that falls on weekday `code`. */
function firstOnOrAfter(from: string, code: Day): string {
  for (let i = 0; i < 7; i++) {
    const d = addDaysWall(from, i);
    if (weekdayCode(d) === code) return d;
  }
  return from;
}

/** First date among `days`, on/after `from`. */
function firstOfDays(from: string, days: Day[]): string {
  return days.map((d) => firstOnOrAfter(from, d)).sort()[0]!;
}

export interface DemoFixture {
  today: string;
  semester: { start: string; end: string };
  /** Stable ids the eval's checks refer to. */
  ids: {
    classes: { m340l: string; sds322: string; cs331: string; eco304: string };
    gym: Partial<Record<Day, string>>;
    cook: Record<'SU' | 'TU', string>;
    studyGroup: string;
    advising: string;
    careerFair: string;
  };
  dates: { studyGroup: string; advising: string; careerFair: string };
}

export function seedDemoSemester(db: DB, today: string): DemoFixture {
  // A semester that is ~4 weeks in and runs ~11 more.
  const start = addDaysWall(today, -28);
  const end = addDaysWall(today, 77);
  const until = end.replaceAll('-', '');

  db.insert(schema.semester)
    .values({ id: DEMO_SEMESTER_ID, name: 'Fall 2026', start_date: start, end_date: end, timezone: 'America/Chicago' })
    .run();

  const rows: Ev[] = [];
  const weekly = (
    id: string,
    title: string,
    kind: Ev['kind'],
    days: Day[],
    s: string,
    e: string,
    pinned: boolean,
    location: string | null,
    workout: string | null = null,
  ) => {
    const first = firstOfDays(start, days);
    rows.push({
      id,
      semester_id: DEMO_SEMESTER_ID,
      title,
      kind,
      starts_at: `${first}T${s}`,
      ends_at: `${first}T${e}`,
      pinned,
      rrule: `FREQ=WEEKLY;BYDAY=${days.join(',')};UNTIL=${until}`,
      source: 'recurring',
      location,
      notes: null,
      color: null,
      workout,
    });
  };
  const oneOff = (id: string, title: string, kind: Ev['kind'], date: string, s: string, e: string, location: string | null) =>
    rows.push({
      id,
      semester_id: DEMO_SEMESTER_ID,
      title,
      kind,
      starts_at: `${date}T${s}`,
      ends_at: `${date}T${e}`,
      pinned: false,
      rrule: null,
      source: 'manual',
      location,
      notes: null,
      color: null,
      workout: null,
    });

  // Classes — pinned, the validator will refuse to move them (I4).
  weekly('cls-m340l', 'M 340L Matrices', 'class', ['MO', 'WE', 'FR'], '10:00', '10:50', true, 'RLM 6.104');
  weekly('cls-sds322', 'SDS 322E Data Science', 'class', ['MO', 'WE'], '14:00', '15:30', true, 'GDC 1.304');
  weekly('cls-cs331', 'CS 331 Algorithms', 'class', ['TU', 'TH'], '11:00', '12:30', true, 'GDC 2.216');
  weekly('cls-eco304', 'ECO 304K Microeconomics', 'class', ['TU', 'TH'], '15:30', '17:00', true, 'UTC 3.102');

  // Gym — one weekly series per day, each carrying its split day.
  // Gym: Mondays and Fridays always, plus today's and tomorrow's weekday, so
  // the demo's "move my gym block to 6pm" (today) and "shift everything after
  // 3pm tomorrow" have a gym to act on whatever day it's run. On a Wednesday
  // this is exactly Mon/Wed/Thu/Fri — the latency eval's fixture.
  const gymDays = new Set<Day>(['MO', 'FR', weekdayCode(today) as Day, weekdayCode(addDaysWall(today, 1)) as Day]);
  for (const [day, s, e, workout] of GYM_SLOTS) {
    if (gymDays.has(day)) weekly(`gym-${day.toLowerCase()}`, 'Gym', 'gym', [day], s, e, false, 'Gregory Gym', workout);
  }

  // Cook — lunches for the next few days.
  weekly('cook-su', 'Cook lunches', 'cook', ['SU'], '18:00', '19:00', false, null);
  weekly('cook-tu', 'Cook lunches', 'cook', ['TU'], '18:30', '19:30', false, null);

  const studyGroup = addDaysWall(today, 1);
  // Tomorrow always has a pinned class after 3pm (the demo's "shift everything
  // after 3pm tomorrow" must visibly leave it alone). TTh have ECO 304K; on any
  // other day a review session for it stands in.
  const tomorrowCode = weekdayCode(studyGroup);
  if (tomorrowCode !== 'TU' && tomorrowCode !== 'TH') {
    // After 3pm, clear of Mon/Wed's SDS class (ends 15:30) and before the gym.
    const [rs, re] = tomorrowCode === 'MO' || tomorrowCode === 'WE' ? ['15:40', '16:30'] : ['15:00', '15:50'];
    rows.push({
      id: 'cls-eco304-review',
      semester_id: DEMO_SEMESTER_ID,
      title: 'ECO 304K Review Session',
      kind: 'class',
      starts_at: `${studyGroup}T${rs}`,
      ends_at: `${studyGroup}T${re}`,
      pinned: true,
      rrule: null,
      source: 'manual',
      location: 'UTC 3.102',
      notes: null,
      color: null,
      workout: null,
    });
  }
  const advising = addDaysWall(today, 2);
  const careerFair = firstOnOrAfter(addDaysWall(today, 3), 'TU');
  oneOff('evt-study', 'Study group — CS 331', 'personal', studyGroup, '19:30', '21:00', 'PCL 3.114');
  oneOff('evt-advising', 'Advising appointment', 'personal', advising, '13:00', '13:30', 'GDC 1.302');
  oneOff('evt-career-fair', 'Career fair', 'personal', careerFair, '13:00', '14:30', 'Gregory Gym');

  db.insert(schema.event).values(rows).run();

  // Meals: a breakfast + lunch paired into a suite, assigned to the next cook,
  // so cook blocks show what they cook (derived — I5).
  const stamp = `${start}T08:00`;
  db.insert(schema.meal)
    .values([
      {
        id: 'meal-oats',
        name: 'Overnight oats',
        meal_type: 'breakfast',
        ingredients: ['2 cups rolled oats', '1 cup milk', '2 tbsp chia seeds', '1 tbsp honey'],
        details: 'Mix it all and refrigerate overnight.',
        created_at: stamp,
      },
      {
        id: 'meal-chipotle-bowls',
        name: 'Chipotle Chicken Rice Bowls',
        meal_type: 'lunch',
        ingredients: ['2 lb chicken thighs', '2 cups rice', '1 can black beans', '1 cup corn', '2 limes'],
        details: 'Marinate chicken in chipotle, lime, garlic. Cook rice. Sear chicken, rest, slice. Assemble.',
        created_at: stamp,
      },
    ])
    .run();
  db.insert(schema.mealSuite)
    .values({
      id: 'suite-oats-bowls',
      name: 'Oats + Chipotle bowls',
      breakfast_meal_id: 'meal-oats',
      lunch_meal_id: 'meal-chipotle-bowls',
      created_at: stamp,
    })
    .run();
  const nextCook = firstOfDays(today, ['SU', 'TU']);
  db.insert(schema.cookAssignment)
    .values({
      id: 'asg-demo-1',
      event_id: weekdayCode(nextCook) === 'SU' ? 'cook-su' : 'cook-tu',
      date: nextCook,
      suite_id: 'suite-oats-bowls',
      meal_id: null,
      created_at: stamp,
    })
    .run();

  return {
    today,
    semester: { start, end },
    ids: {
      classes: { m340l: 'cls-m340l', sds322: 'cls-sds322', cs331: 'cls-cs331', eco304: 'cls-eco304' },
      gym: Object.fromEntries([...gymDays].map((d) => [d, `gym-${d.toLowerCase()}`])),
      cook: { SU: 'cook-su', TU: 'cook-tu' },
      studyGroup: 'evt-study',
      advising: 'evt-advising',
      careerFair: 'evt-career-fair',
    },
    dates: { studyGroup, advising, careerFair },
  };
}
