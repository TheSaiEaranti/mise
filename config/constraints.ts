/**
 * Scheduling constraints. (SPEC §6)
 *
 * Not in the DB, on purpose: a TS file you edit by hand, typed and
 * version-controlled. These are the DEFAULTS — onboarding answers overlay a
 * subset of these via data/settings.local.json (see ./settings.ts); Sai's
 * answers are not hardcoded into the app, only into these defaults.
 */

export interface Constraints {
  classes: { pinned: boolean };
  commute: {
    /** Minutes needed between any two events at different locations.
     *  Location is a dumb string match — campus building codes. */
    default: number;
  };
  gym: {
    target_per_week: number;
    duration_minutes: number;
    /** Never schedule gym immediately after one of these kinds. */
    not_after_kinds: string[];
    /** Minutes that counts as "immediately after". */
    not_after_gap_minutes: number;
    preferred_windows: string[];
  };
  cook: {
    /** Sai cooks lunch every OTHER day. One session = 2 days of lunch. */
    cadence_days: number;
    duration_minutes: number;
    covers_next_lunches: number;
    preferred_windows: string[];
  };
  meals: {
    breakfast: 'batch' | 'cook' | 'out'; // overnight protein prep, no daily event
    lunch: 'batch' | 'cook' | 'out';     // from meal_plan
    dinner: 'batch' | 'cook' | 'out';    // 'out' = NOT SCHEDULED, no dinner events,
                                         // no dinner ingredients on the grocery list. Load-bearing.
  };
  sleep: { protect: string };            // 'HH:mm-HH:mm' — nothing scheduled here, ever
}

export const constraints: Constraints = {
  classes: { pinned: true },

  commute: {
    default: 15,
  },

  gym: {
    target_per_week: 4,
    duration_minutes: 90,
    not_after_kinds: ['cook'],
    not_after_gap_minutes: 30,
    preferred_windows: ['06:30-08:30', '16:00-19:00'],
  },

  cook: {
    cadence_days: 2,
    duration_minutes: 60,
    covers_next_lunches: 2,
    preferred_windows: ['18:00-21:00'],
  },

  meals: {
    breakfast: 'batch',
    lunch: 'cook',
    dinner: 'out',
  },

  sleep: { protect: '00:00-07:00' },
};
