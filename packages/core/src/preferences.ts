/**
 * Standing scheduling preferences — Sai's durable rules, now EDITABLE data.
 *
 * The reflow engine (reflow.ts) and the validator read these to decide how the
 * day rearranges: which kind comes before which ("cook before gym"), the
 * preferred time-of-day windows per kind, and the buffer to leave before a gym.
 *
 * They used to be fixed defaults in config/constraints.ts. Sai wanted to set
 * them once in chat and have them stick — "I like to cook before I gym", "gym is
 * a 5–8pm thing" — so the live copy lives in the DB as one JSON row, seeded from
 * the config defaults the first time it's read (so nothing changes on day one).
 * config/constraints.ts is still the DEFAULT; this is the running copy that
 * set_preference writes and everything reads.
 */
import { eq } from 'drizzle-orm';
import { effectiveConstraints, type Constraints } from '@mise/config/settings';
import type { DB } from './db/client';
import { schema } from './db/client';

/** An ordering rule: a block of kind `before` should come before one of `after`. */
export interface OrderRule {
  before: string;
  after: string;
}

/**
 * A spacing rule: "no {kind} within {gap_minutes} after a block of one of
 * {after_kinds}." Generalises the old gym-only buffer — "30 min after class
 * before the gym" is kind 'gym' after ['class']; "a break between class and
 * cooking" is kind 'cook' after ['class']. The reflow engine leaves the gap
 * whether the earlier block is fixed (a class) or movable (a cook).
 *
 * Gaps key by (kind, after_kind): set_preference MERGES a new after_kind into
 * the kind's buffer rather than replacing it, so one kind can span several rows,
 * one per distinct gap (gym 30 after cook, gym 45 after class).
 */
export interface BufferRule {
  kind: string;
  after_kinds: string[];
  gap_minutes: number;
}

export interface Preferences {
  /** Ordering rules, e.g. [{ before: 'cook', after: 'gym' }]. */
  order: OrderRule[];
  /** kind → preferred time-of-day windows as 'HH:mm-HH:mm' strings. */
  windows: Record<string, string[]>;
  /** Spacing rules: no `kind` within `gap_minutes` after one of `after_kinds`. */
  buffers: BufferRule[];
}

const PREF_ROW_ID = 1;

/** The starting preferences, from the config constraints (so behaviour is
 *  identical until Sai changes something). */
export function defaultPreferences(c: Constraints = effectiveConstraints()): Preferences {
  return {
    order: [{ before: 'cook', after: 'gym' }],
    windows: {
      gym: [...c.gym.preferred_windows],
      cook: [...c.cook.preferred_windows],
    },
    buffers:
      c.gym.not_after_kinds.length > 0
        ? [{ kind: 'gym', after_kinds: [...c.gym.not_after_kinds], gap_minutes: c.gym.not_after_gap_minutes }]
        : [],
  };
}

/** Old rows stored a single `gym_buffer`; carry it into the general `buffers` list. */
function migrateBuffers(parsed: { buffers?: unknown; gym_buffer?: unknown }, fallback: BufferRule[]): BufferRule[] {
  if (Array.isArray(parsed.buffers)) return parsed.buffers as BufferRule[];
  const gb = parsed.gym_buffer as { after_kinds?: string[]; gap_minutes?: number } | undefined;
  if (gb && Array.isArray(gb.after_kinds)) {
    return gb.after_kinds.length > 0 ? [{ kind: 'gym', after_kinds: gb.after_kinds, gap_minutes: gb.gap_minutes ?? 30 }] : [];
  }
  return fallback;
}

/** Read the live preferences, seeding the row from the default the first time. */
export function getPreferences(db: DB): Preferences {
  const row = db.select().from(schema.preferences).where(eq(schema.preferences.id, PREF_ROW_ID)).get();
  if (!row) {
    const seeded = defaultPreferences();
    db.insert(schema.preferences).values({ id: PREF_ROW_ID, data: JSON.stringify(seeded) }).run();
    return seeded;
  }
  try {
    const parsed = JSON.parse(row.data) as Partial<Preferences> & { gym_buffer?: unknown };
    // Merge over the default so an older/partial row never leaves a field undefined.
    const d = defaultPreferences();
    return {
      order: parsed.order ?? d.order,
      windows: { ...d.windows, ...(parsed.windows ?? {}) },
      buffers: migrateBuffers(parsed, d.buffers),
    };
  } catch {
    return defaultPreferences();
  }
}

/** Replace the live preferences. Whole-object write — it's tiny. */
export function writePreferences(db: DB, prefs: Preferences): void {
  const data = JSON.stringify(prefs);
  const existing = db.select().from(schema.preferences).where(eq(schema.preferences.id, PREF_ROW_ID)).get();
  if (existing) {
    db.update(schema.preferences).set({ data }).where(eq(schema.preferences.id, PREF_ROW_ID)).run();
  } else {
    db.insert(schema.preferences).values({ id: PREF_ROW_ID, data }).run();
  }
}

/** One-line human summaries of the standing rules, for the model's context. */
export function describePreferences(prefs: Preferences): string[] {
  const lines: string[] = [];
  for (const o of prefs.order) lines.push(`${o.before} before ${o.after}`);
  for (const [kind, wins] of Object.entries(prefs.windows)) {
    if (wins.length > 0) lines.push(`${kind} preferred ${wins.join(', ')}`);
  }
  for (const b of prefs.buffers) {
    if (b.after_kinds.length > 0) lines.push(`no ${b.kind} within ${b.gap_minutes} min after ${b.after_kinds.join('/')}`);
  }
  return lines;
}
