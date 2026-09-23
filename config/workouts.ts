/**
 * Sai's gym split. (Hand-edited, like constraints.ts — this is his training, not
 * app data, and he will change it far more often than the app changes.)
 *
 * Three sessions rotate. A gym event carries a `workout` key naming which one it
 * is, so the block on the calendar can say "Chest and back" instead of just
 * "Gym", and the details view can list the exact lifts.
 *
 * `load` is written exactly the way he writes it: weight * reps * sets, e.g.
 * `60*10*8` is 60 lb for 10 reps, 8 sets. Two numbers (`90*12`) means he didn't
 * record a set count. It is a STRING on purpose — this is a training log, not a
 * spreadsheet, and parsing it into numbers would invite an app that "corrects"
 * what he wrote.
 */

export type WorkoutKey = 'chest-back' | 'shoulders-arms' | 'legs';

export interface Exercise {
  name: string;
  load: string;
}

export interface Workout {
  key: WorkoutKey;
  /** What the calendar block says. */
  name: string;
  exercises: Exercise[];
}

export const WORKOUTS: Record<WorkoutKey, Workout> = {
  'chest-back': {
    key: 'chest-back',
    name: 'Chest and back',
    exercises: [
      { name: 'Plate loaded incline MTS', load: '60*10*8' },
      { name: 'Lat pulldown (machine)', load: '100*10*8' },
      { name: 'Bench press', load: '120*8*6' },
      { name: 'Lat pullover', load: '45*9*7' },
      { name: 'Rear delt flies', load: '90*12' },
      { name: 'Bb smith row', load: '110*8*6' },
      { name: 'Cable chest fly', load: '120*9' },
    ],
  },
  'shoulders-arms': {
    key: 'shoulders-arms',
    name: 'Shoulder and arms',
    exercises: [
      { name: 'Db shoulder press', load: '90*9*7' },
      { name: 'Db incline curl', load: '27.5*9*8' },
      { name: 'Rope tricep push down', load: '45*9*9' },
      { name: 'Bb reverse curl', load: '50*7' },
      { name: 'Double rope overhead ext', load: '35*8*6' },
      { name: 'Hammer curls', load: '50*10*8' },
      { name: 'Db lateral raise', load: '20*12*10' },
      { name: 'Db front raise', load: '17.5*10*8' },
    ],
  },
  // Loads are sensible starting points in Sai's machine-forward style — edit
  // them to his real numbers, same as the other two days.
  legs: {
    key: 'legs',
    name: 'Legs',
    exercises: [
      { name: 'Leg press', load: '410*10*8' },
      { name: 'Plate loaded hack squat', load: '180*10*8' },
      { name: 'Leg extension (machine)', load: '100*12*8' },
      { name: 'Seated leg curl', load: '90*10*8' },
      { name: 'Plate loaded glute drive', load: '200*10*8' },
      { name: 'Standing calf raise (machine)', load: '180*15*10' },
      { name: 'Seated calf raise', load: '90*15' },
    ],
  },
};

/** The rotation, in order. Gym sessions cycle through this. */
export const WORKOUT_ROTATION: WorkoutKey[] = ['chest-back', 'shoulders-arms', 'legs'];

export function workoutFor(key: string | null | undefined): Workout | null {
  if (!key) return null;
  return WORKOUTS[key as WorkoutKey] ?? null;
}
