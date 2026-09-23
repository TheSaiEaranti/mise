/**
 * Tool registry. The agent loop looks tools up here by name — unknown names
 * are rejected, never guessed (SPEC §4). Every mutation tool is written once
 * with a dry/commit mode flag.
 */
import type { AnyToolDef, MutationToolDef, ReadToolDef } from '../types';
import { shiftEventsTool } from './shift-events';
import { setEventTimeTool } from './set-event-time';
import { setRecurringDaysTool } from './set-recurring-days';
import { setRecurrenceTool } from './set-recurrence';
import { slotBetweenClassesTool } from './slot-between-classes';
import { fitAroundClassesTool } from './fit-around-classes';
import { setGymSplitsTool } from './set-gym-splits';
import { setDurationTool } from './set-duration';
import { copyDayTool } from './copy-day';
import { placeAdjacentTool } from './place-adjacent';
import { setWorkoutTool } from './set-workout';
import { createEventTool } from './create-event';
import { fitInEventTool } from './fit-in-event';
import { setPreferenceTool } from './set-preference';
import { setReminderTool } from './set-reminder';
import { cancelEventTool } from './cancel-event';
import { rescheduleTool } from './reschedule';
import { editWorkoutTool } from './edit-workout';
import { importMealsTool } from './import-meals';
import { createSuiteTool } from './create-suite';
import { setupSemesterTool } from './setup-semester';
import { addClassesTool } from './add-classes';
import { dropClassTool } from './drop-class';
import { blockFreeTimeTool } from './block-free-time';
import { trackApplicationTool } from './track-application';
import { getScheduleTool, getMealsTool } from './read';
import { searchInternshipsTool } from './search-internships';

export const mutationTools: MutationToolDef<any>[] = [
  shiftEventsTool,
  setEventTimeTool,
  setRecurringDaysTool,
  setRecurrenceTool,
  slotBetweenClassesTool,
  fitAroundClassesTool,
  setGymSplitsTool,
  setDurationTool,
  copyDayTool,
  placeAdjacentTool,
  setWorkoutTool,
  createEventTool,
  fitInEventTool,
  setPreferenceTool,
  setReminderTool,
  blockFreeTimeTool,
  cancelEventTool,
  rescheduleTool,
  editWorkoutTool,
  importMealsTool,
  createSuiteTool,
  setupSemesterTool,
  addClassesTool,
  dropClassTool,
  trackApplicationTool,
];

export const readTools: ReadToolDef<any>[] = [getScheduleTool, getMealsTool, searchInternshipsTool];

export const tools: AnyToolDef[] = [...mutationTools, ...readTools];

export function getTool(name: string): AnyToolDef | undefined {
  return tools.find((t) => t.name === name);
}

/** Tools that wipe a semester (setup_semester) or delete a whole class series
 *  from its own block (drop_class). Still user-initiated only — the wizard and
 *  the two-tap block affordance. The model never sees them.
 *
 *  add_classes is NO LONGER hidden: Sai asked that the assistant be able to
 *  rebuild his schedule itself, classes included, not only through the photo
 *  import or a backend edit. It creates pinned weekly classes, which I4 once
 *  forbade the model — that guard is relaxed on purpose here, kept safe by the
 *  overlap sanity-check, auto-apply's blocking-conflict refusal, and one-tap
 *  undo. Prompt rule 5ak scopes it to real courses only. */
const HIDDEN_FROM_MODEL = new Set(['setup_semester', 'drop_class']);

/** Tools the model is allowed to call. Hiding a tool from `modelToolSpecs()` is
 *  not enough: a model can emit any name it likes, so the agent loop must look
 *  tools up through THIS function, never `getTool` — otherwise setup_semester
 *  (which creates pinned events and can wipe the semester) would be reachable
 *  from chat, violating I1/I4. */
export function getModelTool(name: string): AnyToolDef | undefined {
  if (HIDDEN_FROM_MODEL.has(name)) return undefined;
  return getTool(name);
}

/** Names the model may call — used for the "unknown tool" retry message. */
export function modelToolNames(): string[] {
  return tools.filter((t) => !HIDDEN_FROM_MODEL.has(t.name)).map((t) => t.name);
}

/** The `tools` array sent to Ollama, OpenAI function format. */
export function modelToolSpecs(): unknown[] {
  return tools
    .filter((t) => !HIDDEN_FROM_MODEL.has(t.name))
    .map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}
