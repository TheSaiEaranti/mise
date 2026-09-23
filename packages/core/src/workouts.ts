/**
 * The live gym split — now EDITABLE data, not hardcoded config.
 *
 * It used to live only in config/workouts.ts, hand-edited like a training log.
 * Sai asked for the assistant to be able to change it from chat ("add a legs
 * day", "bump my bench to 125x8"), so the live copy moved into the DB: one row
 * holding the whole split as JSON, seeded from the config default the first time
 * it's read. config/workouts.ts is still the DEFAULT (the starting split); this
 * is the running one the app reads and the edit_workout tool writes.
 *
 * Loads stay STRINGS, verbatim — the tool writes exactly what Sai says and never
 * parses or "corrects" a number, same principle the config file always had.
 */
import { eq } from 'drizzle-orm';
import { WORKOUTS, WORKOUT_ROTATION } from '@mise/config/workouts';
import type { DB } from './db/client';
import { schema } from './db/client';

export interface Exercise {
  name: string;
  /** weight*reps*sets, written exactly as Sai writes it. A STRING, never parsed. */
  load: string;
}

export interface Workout {
  /** Stable id-safe key ('chest-back', 'push-day'). Free-form once editable. */
  key: string;
  /** What the calendar block says ("Chest and back"). */
  name: string;
  exercises: Exercise[];
}

/** A whole split: the days in rotation order. */
export interface WorkoutSplit {
  days: Workout[];
}

const SPLIT_ROW_ID = 1;

/** The starting split, from the config default (rotation order preserved). */
export function defaultSplit(): WorkoutSplit {
  return {
    days: WORKOUT_ROTATION.map((k) => {
      const w = WORKOUTS[k];
      return { key: w.key, name: w.name, exercises: w.exercises.map((e) => ({ name: e.name, load: e.load })) };
    }),
  };
}

/** Read the live split, seeding the row from the default the first time. */
export function getSplit(db: DB): WorkoutSplit {
  const row = db.select().from(schema.workoutSplit).where(eq(schema.workoutSplit.id, SPLIT_ROW_ID)).get();
  if (!row) {
    const seeded = defaultSplit();
    db.insert(schema.workoutSplit).values({ id: SPLIT_ROW_ID, data: JSON.stringify(seeded) }).run();
    return seeded;
  }
  try {
    return JSON.parse(row.data) as WorkoutSplit;
  } catch {
    return defaultSplit();
  }
}

/** Replace the live split. Whole-object write — the split is small. */
export function writeSplit(db: DB, split: WorkoutSplit): void {
  const data = JSON.stringify(split);
  const existing = db.select().from(schema.workoutSplit).where(eq(schema.workoutSplit.id, SPLIT_ROW_ID)).get();
  if (existing) {
    db.update(schema.workoutSplit).set({ data }).where(eq(schema.workoutSplit.id, SPLIT_ROW_ID)).run();
  } else {
    db.insert(schema.workoutSplit).values({ id: SPLIT_ROW_ID, data }).run();
  }
}

/** The workout a gym event's `workout` key names, from the LIVE split. */
export function workoutFor(db: DB, key: string | null | undefined): Workout | null {
  if (!key) return null;
  return getSplit(db).days.find((d) => d.key === key) ?? null;
}

/** The rotation, in order — the day keys, for assigning gym sessions. */
export function rotationKeys(db: DB): string[] {
  return getSplit(db).days.map((d) => d.key);
}

/** A url/id-safe key from a day name: "Push day" → "push-day". */
export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'day';
}

/**
 * Match a day by exact key, or by NAME (case-insensitive, punctuation-loose).
 *
 * Deliberately does NOT match a slugified ref against the KEY: a renamed day
 * keeps its key (gym rows point at it), so matching "Legs" against key 'legs'
 * would keep a day findable by its OLD name after a rename — and then adding a
 * fresh "Legs" day gets refused as a phantom duplicate. Match the current name,
 * not the frozen key.
 */
export function findDay(split: WorkoutSplit, dayRef: string): Workout | undefined {
  const want = dayRef.trim().toLowerCase();
  const wantSlug = slugify(dayRef);
  return split.days.find((d) => d.key === dayRef || d.name.toLowerCase() === want || slugify(d.name) === wantSlug);
}
