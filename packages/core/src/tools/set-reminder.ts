/**
 * set_reminder — "remind me to call the bank Thursday at 2pm."
 *
 * Reminders are lightweight day+time+label markers (a red "R" on the week grid),
 * NOT calendar blocks — no duration, never reflowed, no conflicts. Sai sets them
 * by telling the assistant; he deletes them by hovering the marker on the
 * calendar. This is the ONE place the AI writes a reminder.
 */
import { z } from 'zod';
import type { Diff, MutationToolDef, ToolMode, ToolResult } from '../types';
import { getDb } from '../db/client';
import { createReminder } from '../reminders';
import { fmt12, fmtDateLong, DATE_RE, TIME_RE } from '../time';

const argsSchema = z.object({
  date: z.string().regex(DATE_RE).describe('YYYY-MM-DD of the reminder, copied from the CALENDAR block.'),
  time: z.string().regex(TIME_RE).describe('Time of day, HH:mm (24h) — "2pm" is "14:00".'),
  title: z.string().min(1).max(200).describe("What to be reminded of, in Sai's words — e.g. 'Call the bank', 'Take out the trash'."),
});

export type SetReminderArgs = z.infer<typeof argsSchema>;

async function run(args: SetReminderArgs, mode: ToolMode): Promise<ToolResult> {
  const title = args.title.trim();
  const when = `${fmtDateLong(args.date, 'EEE MMM d')} · ${fmt12(args.time)}`;
  const diff: Diff = {
    summary: `Reminder · ${title}`,
    changes: [],
    unchanged_pinned: [],
    detail: when,
    reminder_changes: [`${title} — ${when}`],
  };
  if (mode === 'dry') return { diff, conflicts: [] };
  const reminder = createReminder(getDb(), { date: args.date, time: args.time, title });
  return { diff: { ...diff, reminder_id: reminder.id }, conflicts: [] };
}

export const setReminderTool: MutationToolDef<SetReminderArgs> = {
  name: 'set_reminder',
  description:
    'Set a REMINDER — "remind me to call the bank Thursday at 2pm", "set a reminder to take my meds at 9am". A reminder ' +
    'is a point-in-time marker (a red "R" on the week grid), NOT a scheduled block, so it never moves anything and never ' +
    'conflicts. Pass date (from the CALENDAR block), time (HH:mm), and title in Sai\'s words. He deletes reminders by ' +
    'hovering the marker on the calendar, so you only ever SET them.',
  parameters: z.toJSONSchema(argsSchema) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
