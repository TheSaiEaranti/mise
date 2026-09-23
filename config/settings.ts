/**
 * Onboarding answers overlay. Defaults come from constraints.ts; the wizard
 * writes data/settings.local.json (gitignored) and this module merges it.
 * Effective constraints = defaults ⊕ user settings.
 */
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { constraints, type Constraints } from './constraints';

export interface UserSettingsFile {
  cook_cadence_days?: number;
  covers_next_lunches?: number;
  gym_target_per_week?: number;
  gym_duration_minutes?: number;
  meals?: Partial<Constraints['meals']>;
  /** Protected sleep window 'HH:mm-HH:mm' — nothing schedules here. Overrides the
   *  hardcoded default so Sai can set his real hours (e.g. '02:00-09:00'). */
  sleep_protect?: string;
  onboarded?: boolean;
}

function settingsPath(): string {
  // config/ → repo root is one level up.
  return process.env.MISE_SETTINGS_PATH ?? join(import.meta.dir, '..', 'data', 'settings.local.json');
}

export function readUserSettings(): UserSettingsFile {
  const p = settingsPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as UserSettingsFile;
  } catch {
    return {};
  }
}

export function writeUserSettings(next: UserSettingsFile): void {
  const p = settingsPath();
  mkdirSync(join(p, '..'), { recursive: true });
  const merged = { ...readUserSettings(), ...next };
  writeFileSync(p, JSON.stringify(merged, null, 2) + '\n');
}

/** The constraints the validator/tools actually use. */
export function effectiveConstraints(): Constraints {
  const s = readUserSettings();
  return {
    ...constraints,
    gym: {
      ...constraints.gym,
      target_per_week: s.gym_target_per_week ?? constraints.gym.target_per_week,
      duration_minutes: s.gym_duration_minutes ?? constraints.gym.duration_minutes,
    },
    cook: {
      ...constraints.cook,
      cadence_days: s.cook_cadence_days ?? constraints.cook.cadence_days,
      covers_next_lunches: s.covers_next_lunches ?? constraints.cook.covers_next_lunches,
    },
    sleep: { protect: s.sleep_protect ?? constraints.sleep.protect },
    meals: { ...constraints.meals, ...(s.meals ?? {}) },
  };
}

export { constraints, type Constraints };
