/**
 * Intent router: a cheap, deterministic first step that decides how much of
 * the agent a turn needs. Measurement showed the model sees ~30k chars of
 * rules and 26 tool schemas (~41k chars) on every round, for requests that
 * need one or two tools; the smaller model follows a focused prompt far
 * better than the whole manual (eval/latency/phase2-haiku.json).
 *
 * route(message) → which intent families it belongs to (move, create, …).
 * The agent then sends ONLY those families' tools and prompt sections, plus
 * the core rules every request obeys, and only the calendar days the request
 * touches. Anything it can't place confidently is 'general': the full prompt
 * and every tool, exactly as before routing existed.
 *
 * The router never decides what happens — it only narrows what the model is
 * shown. Tool execution still goes through getModelTool, dry-run, the
 * validator and applyProposal, unchanged.
 */
import { addDaysWall, weekMonday, weekdayCode } from './time';

export type Family =
  | 'move'
  | 'create'
  | 'recurring'
  | 'cancel'
  | 'reminder'
  | 'preference'
  | 'workout'
  | 'meals'
  | 'internship'
  | 'question'
  | 'general';

export const FAMILIES: Family[] = ['move', 'create', 'recurring', 'cancel', 'reminder', 'preference', 'workout', 'meals', 'internship', 'question', 'general'];

/** Mutation families — two or more in one message is a compound request. */
const MUTATING = new Set<Family>(['move', 'create', 'recurring', 'cancel', 'reminder', 'preference', 'workout', 'meals']);

/** The 3–6 tools each family needs. 'general' = every model tool. */
export const FAMILY_TOOLS: Record<Exclude<Family, 'general'>, string[]> = {
  move: ['shift_events', 'set_event_time', 'place_adjacent', 'reschedule_to_free_slot', 'set_duration', 'get_schedule'],
  create: ['create_event', 'fit_in_event', 'block_free_time', 'add_classes', 'get_schedule'],
  recurring: ['set_recurring_days', 'set_recurrence', 'set_duration', 'slot_between_classes', 'fit_around_classes', 'copy_day'],
  cancel: ['cancel_event', 'get_schedule'],
  reminder: ['set_reminder'],
  preference: ['set_preference', 'place_adjacent'],
  workout: ['set_workout', 'set_gym_splits', 'edit_workout'],
  meals: ['import_meals', 'create_suite', 'get_meals'],
  internship: ['search_internships', 'track_application'],
  question: ['get_schedule', 'get_meals', 'search_internships'],
};

/**
 * Prompt sections (SYSTEM_PROMPT paragraph ids, see agent.ts) each family
 * needs on top of the core rules. Every paragraph of the full prompt belongs
 * to the core or to at least one family — nothing was deleted, only filed.
 */
export const FAMILY_SECTIONS: Record<Exclude<Family, 'general'>, string[]> = {
  move: ['5ad2', '5ai', '5ab', '5al', '5aa'],
  create: ['5', '5al', '5aa', '5ab', '5af', '5ac', '5ae', '5ak', '5ak2', 'gymcal'],
  recurring: ['5ah', '5ah2', '5ad2', '5ai2', '5ai3', '5ae', '5ae0', '5aj2'],
  cancel: ['5ai'],
  reminder: ['5ak2'],
  preference: ['5am', '5ai'],
  workout: ['5aj', '5aj2', '5ag', 'gymcal'],
  meals: ['4', '5an', '5an2'],
  internship: ['4b'],
  question: ['4', '4b', '4c'],
};

/** Rules every request obeys, whatever it is. */
export const CORE_SECTIONS = ['intro', 'hard', '1', '1a', '2', '2a', '2b', '3', '3a', '5a', '5b', '5c', '5d', '5e', '6', '6b', '7', 'facts'];

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const CODE = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
// Full names first: "(sat)(day)?" can't match "saturday" / "wednesdays".
const WD = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)';

const RX: Record<Exclude<Family, 'general' | 'question'>, RegExp> = {
  reminder: /\bremind(?:er|ers)?\b/,
  internship: /\b(?:internships?|applications?|applied (?:to|at)|job board|listings?)\b/,
  // Not "grocery": "grocery shopping at 5" is a plan, not a meal edit.
  meals: /\b(?:recipes?|ingredients?|suites?|shopping list)\b|\bmeals?\b(?! prep)/,
  workout: /\b(?:split|workout (?:label|split|day)|lifts?|bench|squat|deadlift|ohp|leg day|legs day|chest and back|shoulders(?: and arms)?|sets? of|reps?)\b/,
  // Rule-shaped only: "never mind" / "I never make it by 5" are not rules.
  preference: /\b(?:from now on|(?:always|never) (?:schedule|put|have|do|want|keep|leave|book|plan|cook|gym|go|make|let|give)|i prefer|prefer to|prefer my|i like to|buffer|(?:gap|break) (?:between|after|before)|leave \d+ ?(?:min|minutes|mins|hours?) (?:after|before|between)|sleep (?:hours|window|from|is))\b/,
  recurring: new RegExp(
    String.raw`\b(?:only (?:on )?${WD}|no \w+ on ${WD}s|(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)s\b|weekends|weekdays|every (?:\d+|other|two|three|four) days?|each week|every week|weekly|times a week|x a week|days a week|recurring|repeat|same as ${WD}|copy ${WD}|(?:sessions|blocks) (?:\d+|an?|one|two|three) ?(?:hours?|hrs?|min(?:ute)?s?) long|(?:\d+|an?|one|two|three) ?(?:hours?|hrs?|min(?:ute)?s?) long|between my (?:two )?classes|around my class)`,
  ),
  cancel: /\b(?:cancel|delete|remove|skip|get rid of|scrap|call off)\b/,
  // Verbs only: "my gym block" / "my advising appointment" are nouns (see CREATE_NOUNS).
  create: /\b(?:add|create|schedule|book|block (?:off|out|some|time|\d|an?|one|two|three)|new event|set up|(?:friends|people|guests|family|someone) (?:are |is )?(?:coming )?over|coming over|going out|hanging out|i have (?:a|an)|i've got|got (?:a|an))\b/,
  move: /\b(?:move|push|pull|shift|bump|slide|reschedule|earlier|later|back|delay|postpone|swap|switch|put)\b/,
};

/** Event nouns: a create only when no other action was named ("dinner with Sam at 7"). */
const CREATE_NOUNS = /\b(?:meeting|appointment|dinner with|lunch with|coffee with|party|study session|study block|date|exam|interview)\b/;
/** A new plan named alongside another request ("dinner with my parents at 7, push cook later") — not "my appointment". */
const NEW_PLAN = /(?<!\b(?:my|the|that|this) )\b(?:dinner|lunch|brunch|coffee|meeting|exam|interview|party|call|appointment|date)\b(?: with [a-z ]+?)? (?:at|from|\d)/;
const MOVE_VERB = /\b(?:move|push|pull|shift|bump|slide|reschedule|delay|postpone)\b/;
const CLAUSES = /(?:,| and | then |;| also )/;

const QUESTION_START = /^(?:what|when|where|how|which|who|why|do i|did i|am i|is|are|does|can you tell|tell me|show me|list)\b/;

export interface Route {
  families: Family[];
  /** Compound or open-ended: start on the stronger model. */
  complex: boolean;
  /** How the family was decided. */
  source: 'regex' | 'model' | 'fallback';
  /** Tool names to send; null = every model tool. */
  tools: string[] | null;
  /** Prompt section ids to send; null = the full SYSTEM_PROMPT. */
  sections: string[] | null;
  /** Calendar dates the request touches; null = the full two-week window. */
  days: string[] | null;
}

export function normalize(message: string): string {
  return message
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Families whose keywords appear in the message (regex only). */
export function matchFamilies(message: string): Family[] {
  const m = normalize(message);
  const hits = new Set<Family>();
  for (const [fam, rx] of Object.entries(RX) as [Exclude<Family, 'general' | 'question'>, RegExp][]) {
    if (rx.test(m)) hits.add(fam);
  }
  if (hits.size === 0 && CREATE_NOUNS.test(m) && !QUESTION_START.test(m)) hits.add('create');
  // A plan named next to a move is a second request (rule 5aa: do both).
  if (hits.has('move') && NEW_PLAN.test(m)) hits.add('create');
  // Precedence — only when the words belong to ONE request. Two clauses
  // ("move gym to 7 and remind me at 6:30") keep both families; the route
  // is then compound, and compound turns start on the stronger model.
  const oneClause = !CLAUSES.test(m);
  // "no gym on fridays from now on" is a recurring change, not a new rule.
  if (hits.has('recurring')) hits.delete('preference');
  // "remind me to move my car" is a reminder.
  if (hits.has('reminder') && oneClause) for (const f of ['move', 'create', 'cancel'] as const) hits.delete(f);
  // A pasted recipe is not a calendar edit.
  if (hits.has('meals') && (oneClause || m.length > 200 || /\b(?:recipe|ingredients?)\b/.test(m))) for (const f of ['create', 'move'] as const) hits.delete(f);
  // "add a 30-min break between class and cook" is a buffer rule (5am), not a new event.
  if (hits.has('preference') && /\b(?:gap|break|buffer)\b/.test(m)) hits.delete('create');
  // "always put cook before gym": "put" is inside the rule, not a move.
  if (hits.has('preference') && !MOVE_VERB.test(m)) hits.delete('move');
  // "block off 2 hours" / "add a session" with "later"/"back" in it is still a create.
  if (hits.has('create') && hits.has('move') && !MOVE_VERB.test(m)) hits.delete('move');
  // A cancel phrased with "clear" / a move is still a cancel only if it says so.
  if (hits.size === 0 && QUESTION_START.test(m)) hits.add('question');
  if (hits.size === 0 && /\?$/.test(m) && !/\b(?:can you|could you|would you|will you|please)\b/.test(m)) hits.add('question');
  return [...hits];
}

/** Greetings / thanks: nothing to route, nothing to escalate. */
export function isSmallTalk(message: string): boolean {
  return /^(?:hi|hey|hello|yo|thanks|thank you|thx|ty|ok|okay|cool|nice|great|perfect|got it|sounds good|good (?:morning|night|evening))\b[\s!.,]*(?:mise|sai)?[\s!.]*$/.test(normalize(message));
}

/** Open-ended or multi-part: the stronger model starts the turn. */
function isComplex(message: string, families: Family[]): boolean {
  const m = normalize(message);
  const mutating = families.filter((f) => MUTATING.has(f));
  if (mutating.length >= 2) return true;
  return /\b(?:rearrange|reorganize|re-?plan|plan (?:my|out)|optimi[sz]e|balance|lighten|free up|whenever|on (?:the )?days (?:i|when|that)|every day (?:i|that|when))\b/.test(m);
}

/** Resolve the calendar dates a message mentions, the way the CALENDAR block does. */
export function resolveDays(message: string, today: string): string[] | null {
  const m = normalize(message);
  const out = new Set<string>();
  if (/\b(?:today|tonight|this (?:morning|afternoon|evening))\b/.test(m)) out.add(today);
  if (/\b(?:tomorrow|tmrw|tmr|tmw|tomo)\b/.test(m)) out.add(addDaysWall(today, 1));
  if (/\b(?:this week|rest of the week|this weekend|next week|the weekend)\b/.test(m)) return null; // wide: keep the window
  // Dates this resolver doesn't read (the 25th, 9/25, "day after", month names):
  // show the whole window rather than risk hiding the day.
  if (/\b(?:\d{1,2}(?:st|nd|rd|th)|\d{1,2}\/\d{1,2}|day after|(?:jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d)\b/.test(m)) return null;
  for (let i = 0; i < 7; i++) {
    const name = WEEKDAYS[i]!;
    const short = name.slice(0, 3);
    // Plural weekdays ("fridays") mean every week — the full window.
    if (new RegExp(`\\b${short}\\w*days\\b`).test(m) && new RegExp(`\\b(?:${name}s|${short}s)\\b`).test(m)) return null;
    const next = new RegExp(`\\bnext (?:${name}|${short})\\b`).test(m);
    const alt = short === 'tue' ? 'tues' : short === 'thu' ? 'thurs?' : short === 'wed' ? 'weds' : short;
    if (new RegExp(`\\b(?:${name}|${short}|${alt})(?:'s)?\\b`).test(m)) {
      out.add(weekdayDate(today, CODE[i]!, next));
    }
  }
  if (out.size === 0) return null;
  // Today and tomorrow ride along: "move my gym to friday" is about a gym on
  // another day, and hiding it leaves the model looking at the wrong one.
  out.add(today);
  out.add(addDaysWall(today, 1));
  return [...out].sort();
}

/** Bare weekday = soonest at or after today; "next <weekday>" = the one in next calendar week. */
export function weekdayDate(today: string, code: string, next = false): string {
  if (next) {
    const nextMonday = addDaysWall(weekMonday(today), 7);
    for (let i = 0; i < 7; i++) {
      const d = addDaysWall(nextMonday, i);
      if (weekdayCode(d) === code) return d;
    }
  }
  for (let i = 0; i < 7; i++) {
    const d = addDaysWall(today, i);
    if (weekdayCode(d) === code) return d;
  }
  return today;
}

/** Families that reason across weeks see the whole two-week window. */
const WIDE = new Set<Family>(['recurring', 'preference', 'workout', 'meals', 'internship', 'general']);

/** Build the route for a set of families (from the regex or the model). */
export function routeFor(families: Family[], message: string, today: string, source: Route['source']): Route {
  const fams = families.length > 0 ? families : (['general'] as Family[]);
  const general = fams.includes('general');
  const tools = general ? null : [...new Set(fams.flatMap((f) => FAMILY_TOOLS[f as Exclude<Family, 'general'>]))];
  const sections = general ? null : [...new Set(fams.flatMap((f) => FAMILY_SECTIONS[f as Exclude<Family, 'general'>]))];
  let days: string[] | null = null;
  if (!fams.some((f) => WIDE.has(f))) {
    // No day named means today (rule 5a) — plus the week ahead, so "my gym"
    // with no gym today can still be found and reported honestly.
    days = resolveDays(message, today) ?? Array.from({ length: 7 }, (_, i) => addDaysWall(today, i));
  }
  return {
    families: fams,
    complex: (general && !isSmallTalk(message)) || isComplex(message, fams),
    source,
    tools,
    sections,
    days,
  };
}

/** The deterministic route. `families` is empty when the regex can't place it. */
export function route(message: string, today: string): Route {
  if (isSmallTalk(message)) return { ...routeFor(['general'], message, today, 'regex'), complex: false };
  const fams = matchFamilies(message);
  return routeFor(fams, message, today, fams.length > 0 ? 'regex' : 'fallback');
}
