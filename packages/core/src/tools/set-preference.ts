/**
 * set_preference — Sai states a STANDING rule once and it sticks.
 *
 * "I like to cook before I gym", "gym is a 5–8pm thing", "leave me 45 min after
 * class before the gym". These aren't one-day changes — they're policy the
 * reflow engine (reflow.ts) and the validator apply to every future day. So this
 * writes the durable preferences row (preferences.ts), not the calendar.
 *
 * Snapshot-undo, exactly like edit_workout: the whole preferences object before
 * the edit rides in the diff; Cmd-Z puts it back, and refuses if a newer edit
 * has landed since.
 */
import { z } from 'zod';
import type { Conflict, Diff, MutationToolDef, ToolMode, ToolResult } from '../types';
import { getDb } from '../db/client';
import { getPreferences, writePreferences, describePreferences, type Preferences } from '../preferences';
import { effectiveConstraints, writeUserSettings } from '@mise/config/settings';
import { fmt12, parseWindow } from '../time';

const WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

const argsSchema = z.object({
  type: z
    .enum(['order', 'window', 'buffer', 'sleep'])
    .describe(
      "Which kind of standing rule: 'order' (X before Y), 'window' (preferred times for a kind), 'buffer' (a spacing gap), " +
        "'sleep' (his protected sleep hours — nothing schedules inside them).",
    ),
  sleep: z
    .string()
    .regex(WINDOW_RE)
    .optional()
    .describe("For type 'sleep': the protected sleep window 'HH:mm-HH:mm' 24h, e.g. '02:00-09:00' for sleeping 2am–9am."),
  // order
  before: z.string().optional().describe("For type 'order': the kind that should come FIRST, e.g. 'cook'."),
  after: z.string().optional().describe("For type 'order': the kind that should come AFTER, e.g. 'gym'."),
  remove: z.boolean().optional().describe("For type 'order': true to REMOVE this ordering rule instead of adding it."),
  // window + buffer
  kind: z
    .string()
    .optional()
    .describe(
      "For type 'window': the block kind these times apply to, e.g. 'gym'. " +
        "For type 'buffer': the block kind that needs the gap — 'gym' for \"30 min after class before the gym\", " +
        "'cook' for \"a break between class and cooking\". Defaults to 'gym'.",
    ),
  windows: z
    .array(z.string().regex(WINDOW_RE))
    .optional()
    .describe("For type 'window': preferred time windows as 'HH:mm-HH:mm' 24h, e.g. ['17:00-20:00']. Replaces the kind's windows."),
  // buffer
  gap_minutes: z
    .number()
    .int()
    .min(0)
    .max(240)
    .optional()
    .describe("For type 'buffer': minutes of gap to leave. 0 removes the buffer for this kind."),
  after_kinds: z
    .array(z.string())
    .optional()
    .describe("For type 'buffer': the kinds the buffered block shouldn't immediately follow, e.g. ['class'] or ['cook','class']."),
});

export type SetPreferenceArgs = z.infer<typeof argsSchema>;

function refuse(summary: string, rule: string, message: string): ToolResult {
  const conflicts: Conflict[] = [{ type: 'constraint', rule, message }];
  return { diff: { summary, changes: [], unchanged_pinned: [] }, conflicts };
}

async function run(args: SetPreferenceArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();

  // Sleep hours live in the settings overlay (effectiveConstraints reads them),
  // NOT the DB preferences — so the validator and every tool pick up the new
  // window automatically. Snapshot-undo via sleep_before/after on the diff.
  if (args.type === 'sleep') {
    if (!args.sleep) return refuse('Set preference · sleep', 'bad_sleep', "Say your sleep hours, e.g. '2am to 9am'.");
    const oldSleep = effectiveConstraints().sleep.protect;
    if (oldSleep === args.sleep) {
      const { start, end } = parseWindow(args.sleep);
      return refuse('Set preference · sleep', 'already', `Your sleep hours are already ${fmt12(start)}–${fmt12(end)}.`);
    }
    const { start, end } = parseWindow(args.sleep);
    const line = `sleep ${fmt12(start)}–${fmt12(end)}`;
    const diff: Diff = {
      summary: `Preference · ${line}`,
      changes: [],
      unchanged_pinned: [],
      pref_changes: [line],
      sleep_before: oldSleep,
      sleep_after: args.sleep,
      detail: `Nothing schedules during ${fmt12(start)}–${fmt12(end)}; everything else is fair game.`,
    };
    if (mode === 'dry') return { diff, conflicts: [] };
    writeUserSettings({ sleep_protect: args.sleep });
    return { diff, conflicts: [] };
  }

  const before = getPreferences(db);
  const next: Preferences = JSON.parse(JSON.stringify(before)); // deep clone

  let line: string;

  if (args.type === 'order') {
    if (!args.before || !args.after) return refuse('Set preference · order', 'bad_order', 'Say which kind comes first and which comes after.');
    if (args.before === args.after) return refuse('Set preference · order', 'bad_order', "A kind can't come before itself.");
    const has = next.order.some((o) => o.before === args.before && o.after === args.after);
    if (args.remove) {
      if (!has) return refuse('Set preference · order', 'already', `There's no rule that ${args.before} comes before ${args.after}.`);
      next.order = next.order.filter((o) => !(o.before === args.before && o.after === args.after));
      line = `Removed: ${args.before} before ${args.after}`;
    } else {
      if (has) return refuse('Set preference · order', 'already', `${args.before} before ${args.after} is already a rule.`);
      // Drop any opposite rule so we don't hold a contradiction.
      next.order = next.order.filter((o) => !(o.before === args.after && o.after === args.before));
      next.order.push({ before: args.before, after: args.after });
      line = `${args.before} before ${args.after}`;
    }
  } else if (args.type === 'window') {
    if (!args.kind || !args.windows) return refuse('Set preference · window', 'bad_window', 'Say which kind and which time windows.');
    for (const w of args.windows) {
      const { start, end } = parseWindow(w);
      if (start >= end) return refuse('Set preference · window', 'bad_window', `${w} ends before it starts.`);
    }
    if (JSON.stringify(next.windows[args.kind] ?? []) === JSON.stringify(args.windows)) {
      return refuse('Set preference · window', 'already', `${args.kind} is already preferred ${args.windows.join(', ')}.`);
    }
    next.windows[args.kind] = [...args.windows];
    line = `${args.kind} preferred ${args.windows.join(', ')}`;
  } else {
    // buffer: "no {bufKind} within {gap} min after {after_kinds}". bufKind is
    // which block needs the gap — 'gym' after cook, 'cook' after class, etc.
    if (args.gap_minutes === undefined) return refuse('Set preference · buffer', 'bad_buffer', 'Say how many minutes of buffer.');
    const bufKind = args.kind ?? 'gym';
    const existing = next.buffers.find((b) => b.kind === bufKind);
    const kinds = args.after_kinds ?? existing?.after_kinds ?? [];
    if (args.gap_minutes > 0 && kinds.length === 0) {
      return refuse('Set preference · buffer', 'bad_buffer', `Say what the ${bufKind} gap should come after, e.g. after class.`);
    }
    if (
      existing &&
      existing.gap_minutes === args.gap_minutes &&
      JSON.stringify(existing.after_kinds) === JSON.stringify(kinds)
    ) {
      return refuse('Set preference · buffer', 'already', `That ${bufKind} buffer is already set.`);
    }
    if (args.gap_minutes === 0 && !existing) {
      return refuse('Set preference · buffer', 'already', `There's no ${bufKind} buffer to remove.`);
    }
    // Upsert: one buffer per kind, so a cook rule never clobbers the gym rule.
    next.buffers = next.buffers.filter((b) => b.kind !== bufKind);
    if (args.gap_minutes > 0) next.buffers.push({ kind: bufKind, after_kinds: kinds, gap_minutes: args.gap_minutes });
    line = args.gap_minutes > 0 ? `no ${bufKind} within ${args.gap_minutes} min after ${kinds.join('/')}` : `removed the ${bufKind} buffer`;
  }

  const diff: Diff = {
    summary: `Preference · ${line}`,
    changes: [],
    unchanged_pinned: [],
    pref_changes: [line],
    pref_before: before,
    pref_after: next,
    detail: `Standing rules now: ${describePreferences(next).join(' · ')}`,
  };

  if (mode === 'dry') return { diff, conflicts: [] };
  writePreferences(db, next);
  return { diff, conflicts: [] };
}

export const setPreferenceTool: MutationToolDef<SetPreferenceArgs> = {
  name: 'set_preference',
  description:
    'Save a STANDING scheduling rule that applies to every future day, when Sai says "always", "never", "I like to", ' +
    '"from now on", "I prefer". Three kinds: type "order" for "cook before gym" (before + after kinds); type "window" ' +
    'for "gym is a 5–8pm thing" (kind + windows like ["17:00-20:00"]); type "buffer" for a spacing gap (kind = which ' +
    'block needs the gap + gap_minutes + after_kinds). Buffer examples: "leave 30 min after class before gym" → kind ' +
    '"gym", after_kinds ["class"]; "a break between class and cooking" → kind "cook", after_kinds ["class"]; "no gym ' +
    'right after cooking" → kind "gym", after_kinds ["cook"]. These drive how the day reflows around new events forever ' +
    'after. Use this for durable rules — a ONE-DAY change is a normal move (set_event_time / place_adjacent), not a preference.',
  parameters: z.toJSONSchema(argsSchema) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
