/**
 * Latency + accuracy eval for the chat agent.
 *
 *   bun run scripts/latency-eval.ts --label before [--reps 2] [--only c01,c06]
 *   bun run scripts/latency-eval.ts --validate      # check the checks, no model
 *
 * Runs a fixed set of realistic commands, each against a FRESH in-memory copy
 * of the demo semester (scripts/lib/demo-fixture.ts) with the clock frozen at
 * EVAL_NOW, through the real agent loop and the real commit policy
 * (settleForChat → applyProposal). Whichever backend the env selects answers
 * (MISE_CHAT_BACKEND etc.), so the same script measures before and after.
 *
 * Per command it records latency, model rounds, tokens (incl. prompt-cache
 * reads/writes), and whether it was RIGHT. Right means two things, in the
 * spirit of finetune/eval-tuned.mjs's exec-oracle:
 *   tool_ok  — the change came from an acceptable tool (or no change, when
 *              none was wanted), and
 *   state_ok — the calendar actually ended up the way the request meant,
 *              checked against the database after commit.
 * `--validate` checks the checks: a hand-written oracle call per command must
 * pass, an untouched calendar must fail, and plausible wrong calls (a series
 * move for a one-day request, a whole-day shift, a repeating create) must fail.
 *
 * Output: a table on stdout and eval/latency/<label>.json.
 */
import { EVAL_NOW } from './lib/eval-env'; // must stay the first import
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetDbForTests, type DB } from '../packages/core/src/db/client';
import { runAgentTurn } from '../packages/core/src/agent';
import { getInstances } from '../packages/core/src/schedule';
import { getModelTool } from '../packages/core/src/tools/index';
import { listReminders } from '../packages/core/src/reminders';
import { getPreferences } from '../packages/core/src/preferences';
import { createProposal, type ProposalRow } from '../packages/core/src/proposals';
import { addDaysWall, addMinutesWall, diffMinutes, timeOf, todayInTz } from '../packages/core/src/time';
import type { EventInstance } from '../packages/core/src/types';
import type { TurnTrace } from '../packages/core/src/trace';
import { settleForChat } from '../apps/api/src/lib/apply';
import { seedDemoSemester, type DemoFixture } from './lib/demo-fixture';

// ---------------------------------------------------------------------------
// Dates, relative to the frozen today (Wed). T=today, TH=tomorrow, …
// ---------------------------------------------------------------------------
const T = todayInTz();
const D = {
  T,
  TH: addDaysWall(T, 1),
  FR: addDaysWall(T, 2),
  SA: addDaysWall(T, 3),
  SU: addDaysWall(T, 4),
  MO: addDaysWall(T, 5),
  TU: addDaysWall(T, 6),
  WE2: addDaysWall(T, 7),
  TH2: addDaysWall(T, 8),
  FR2: addDaysWall(T, 9),
  SA2: addDaysWall(T, 10),
  MO2: addDaysWall(T, 12),
  TU2: addDaysWall(T, 13),
};

const on = (db: DB, date: string, pred: (i: EventInstance) => boolean) =>
  getInstances(db, date, date).filter(pred);
const gym = (db: DB, date: string) => on(db, date, (i) => i.kind === 'gym');
const titled = (db: DB, date: string, re: RegExp) => on(db, date, (i) => re.test(i.title));
const start = (i: EventInstance | undefined) => (i ? timeOf(i.starts_at) : null);
const mins = (i: EventInstance | undefined) => (i ? diffMinutes(i.starts_at, i.ends_at) : null);
const eco = (db: DB, date: string) => start(titled(db, date, /ECO 304K/)[0]);
/** A one-day request must leave the same block next week where it was. */
const sameNextWeek = (db: DB, date: string, pick: (db: DB, d: string) => EventInstance[], at: string, what: string) =>
  expect(start(pick(db, date)[0]) === at, `${what} next week moved too (${start(pick(db, date)[0])}, want ${at}) — only one day was asked`);
const cookOn = (db: DB, date: string) => titled(db, date, /Cook/);
const applied = (ps: ProposalRow[]) => ps.filter((p) => p.status === 'approved');

interface Ctx {
  db: DB;
  fx: DemoFixture;
  proposals: ProposalRow[];
  reply: string;
}

interface Case {
  id: string;
  kind: 'move' | 'bulk' | 'recurring' | 'create' | 'cancel' | 'reminder' | 'question' | 'preference' | 'refuse' | 'chat';
  message: string;
  /** Tools that may legitimately make this change; [] = no change wanted. */
  tools: string[];
  /** The calendar/DB ended up right. Return true, or a string saying what is wrong. */
  check: (c: Ctx) => true | string;
  /** A call that achieves the intent — used by --validate to prove `check` is satisfiable. */
  oracle?: (fx: DemoFixture) => { tool: string; args: Record<string, unknown> };
  /** Plausible WRONG calls (series instead of one day, a whole-day shift, a
   *  repeating create) — --validate proves `check` rejects each one. */
  wrong?: { tool: string; args: Record<string, unknown> }[];
}

function expect(cond: boolean, what: string): true | string {
  return cond ? true : what;
}
function all(...rs: (true | string)[]): true | string {
  const bad = rs.filter((r) => r !== true);
  return bad.length === 0 ? true : bad.join('; ');
}

const CASES: Case[] = [
  {
    id: 'c01',
    kind: 'move',
    message: 'move my gym block to 6pm',
    tools: ['set_event_time', 'shift_events'],
    check: ({ db }) =>
      all(
        expect(start(gym(db, D.T)[0]) === '18:00', `today's gym at ${start(gym(db, D.T)[0])}, want 18:00`),
        sameNextWeek(db, D.WE2, gym, '17:00', 'Wednesday gym'),
      ),
    oracle: () => ({ tool: 'set_event_time', args: { event_id: 'gym-we', expect_title: 'Gym', date: D.T, start_time: '18:00', end_time: '19:30' } }),
    wrong: [{ tool: 'shift_events', args: { scope: 'series', date: D.T, event_id: 'gym-we', expect_title: 'Gym', delta_minutes: 60 } }],
  },
  {
    id: 'c02',
    kind: 'move',
    message: "move tomorrow's gym to 7pm",
    tools: ['set_event_time', 'shift_events'],
    check: ({ db }) =>
      all(
        expect(start(gym(db, D.TH)[0]) === '19:00', `tomorrow's gym at ${start(gym(db, D.TH)[0])}, want 19:00`),
        expect(eco(db, D.TH) === '15:30', 'pinned ECO moved'),
        sameNextWeek(db, D.TH2, gym, '17:30', 'Thursday gym'),
      ),
    oracle: () => ({ tool: 'set_event_time', args: { event_id: 'gym-th', expect_title: 'Gym', date: D.TH, start_time: '19:00', end_time: '20:30' } }),
    wrong: [{ tool: 'shift_events', args: { scope: 'series', date: D.TH, event_id: 'gym-th', expect_title: 'Gym', delta_minutes: 90 } }],
  },
  {
    id: 'c03',
    kind: 'move',
    message: 'push my gym back 30 minutes',
    tools: ['shift_events', 'set_event_time'],
    check: ({ db }) =>
      all(
        expect(start(gym(db, D.T)[0]) === '17:30', `today's gym at ${start(gym(db, D.T)[0])}, want 17:30`),
        sameNextWeek(db, D.WE2, gym, '17:00', 'Wednesday gym'),
      ),
    oracle: () => ({ tool: 'shift_events', args: { scope: 'single', date: D.T, event_id: 'gym-we', expect_title: 'Gym', delta_minutes: 30 } }),
    wrong: [{ tool: 'shift_events', args: { scope: 'series', date: D.T, event_id: 'gym-we', expect_title: 'Gym', delta_minutes: 30 } }],
  },
  {
    id: 'c04',
    kind: 'move',
    message: "move friday's gym to saturday",
    tools: ['shift_events', 'set_event_time'],
    check: ({ db }) =>
      all(
        expect(gym(db, D.FR).length === 0, 'Friday still has gym'),
        expect(gym(db, D.SA).length === 1, `Saturday has ${gym(db, D.SA).length} gym blocks, want 1`),
        sameNextWeek(db, D.FR2, gym, '16:00', 'Friday gym'),
        expect(gym(db, D.SA2).length === 0, 'next Saturday got a gym too — only this week was asked'),
        expect(start(titled(db, D.FR, /Advising/)[0]) === '13:00', 'the advising appointment moved too'),
      ),
    oracle: () => ({ tool: 'shift_events', args: { scope: 'single', date: D.FR, event_id: 'gym-fr', expect_title: 'Gym', delta_minutes: 1440 } }),
    wrong: [{ tool: 'shift_events', args: { scope: 'series', date: D.FR, event_id: 'gym-fr', expect_title: 'Gym', delta_minutes: 1440 } }, { tool: 'shift_events', args: { scope: 'day', date: D.FR, delta_minutes: 1440 } }],
  },
  {
    id: 'c05',
    kind: 'move',
    message: 'move my cook session on tuesday 30 minutes earlier',
    tools: ['shift_events', 'set_event_time'],
    check: ({ db }) => {
      const s = start(cookOn(db, D.TU)[0]);
      return all(
        expect(s === '18:00', `Tuesday cook at ${s}, want 18:00`),
        sameNextWeek(db, D.TU2, cookOn, '18:30', 'Tuesday cook'),
        expect(start(titled(db, D.TU, /Career fair/)[0]) === '13:00', 'the career fair moved too'),
      );
    },
    oracle: () => ({ tool: 'shift_events', args: { scope: 'single', date: D.TU, event_id: 'cook-tu', expect_title: 'Cook lunches', delta_minutes: -30 } }),
    wrong: [{ tool: 'shift_events', args: { scope: 'series', date: D.TU, event_id: 'cook-tu', expect_title: 'Cook lunches', delta_minutes: -30 } }, { tool: 'shift_events', args: { scope: 'day', date: D.TU, delta_minutes: -30 } }],
  },
  {
    id: 'c06',
    kind: 'bulk',
    message: 'shift everything after 3pm tomorrow back an hour',
    tools: ['shift_events'],
    check: ({ db }) =>
      all(
        expect(eco(db, D.TH) === '15:30', `pinned ECO 304K at ${eco(db, D.TH)} — it must not move`),
        expect(start(titled(db, D.TH, /CS 331/)[0]) === '11:00', 'pinned CS 331 moved'),
        expect(start(gym(db, D.TH)[0]) === '18:30', `gym at ${start(gym(db, D.TH)[0])}, want 18:30`),
        expect(start(titled(db, D.TH, /Study group/)[0]) === '20:30', `study group at ${start(titled(db, D.TH, /Study group/)[0])}, want 20:30`),
        sameNextWeek(db, D.TH2, gym, '17:30', 'Thursday gym'),
      ),
    oracle: () => ({ tool: 'shift_events', args: { scope: 'day', date: D.TH, after_time: '15:00', delta_minutes: 60 } }),
  },
  {
    id: 'c07',
    kind: 'recurring',
    message: 'no gym on Fridays',
    tools: ['set_recurring_days'],
    check: ({ db }) =>
      all(
        expect(gym(db, D.FR).length === 0 && gym(db, D.FR2).length === 0, 'a Friday still has gym'),
        expect(gym(db, D.MO).length === 1 && gym(db, D.WE2).length === 1 && gym(db, D.TH2).length === 1, 'lost a Mon/Wed/Thu gym'),
      ),
    oracle: () => ({ tool: 'set_recurring_days', args: { event_id: 'gym-mo', expect_title: 'Gym', days: ['MO', 'WE', 'TH'] } }),
  },
  {
    id: 'c08',
    kind: 'recurring',
    message: 'gym only on monday wednesday and friday from now on',
    tools: ['set_recurring_days'],
    check: ({ db }) =>
      all(
        expect(gym(db, D.TH2).length === 0 && gym(db, D.TH).length === 0, 'a Thursday still has gym'),
        expect(gym(db, D.MO).length === 1 && gym(db, D.WE2).length === 1 && gym(db, D.FR2).length === 1, 'missing a Mon/Wed/Fri gym'),
      ),
    oracle: () => ({ tool: 'set_recurring_days', args: { event_id: 'gym-mo', expect_title: 'Gym', days: ['MO', 'WE', 'FR'] } }),
  },
  {
    id: 'c09',
    kind: 'create',
    message: 'add a study session friday 2-4pm',
    tools: ['create_event', 'fit_in_event', 'block_free_time'],
    check: ({ db }) => {
      const s = titled(db, D.FR, /stud/i)[0];
      return all(
        expect(start(s) === '14:00' && mins(s) === 120, `Friday study block ${start(s)} (${mins(s)} min), want 14:00 for 120`),
        expect(titled(db, D.FR2, /stud/i).length === 0, 'created a weekly series — one session was asked'),
      );
    },
    oracle: () => ({ tool: 'create_event', args: { title: 'Study session', kind: 'personal', date: D.FR, start_time: '14:00', duration_minutes: 120 } }),
    wrong: [{ tool: 'create_event', args: { title: 'Study session', kind: 'personal', date: D.FR, start_time: '14:00', duration_minutes: 120, repeat: { frequency: 'weekly', days: ['FR'] } } }],
  },
  {
    id: 'c10',
    kind: 'create',
    message: 'friends are coming over at 8 tonight for two hours',
    tools: ['fit_in_event', 'create_event'],
    check: ({ db }) => {
      const s = titled(db, D.T, /friend/i)[0];
      return expect(start(s) === '20:00' && mins(s) === 120, `friends block ${start(s)} (${mins(s)} min), want 20:00 for 120`);
    },
    oracle: () => ({ tool: 'fit_in_event', args: { title: 'Friends over', kind: 'personal', date: D.T, start_time: '20:00', duration_minutes: 120 } }),
  },
  {
    id: 'c11',
    kind: 'cancel',
    message: 'cancel my advising appointment',
    tools: ['cancel_event'],
    // A cancel may be applied or held for confirmation; either way it must
    // target the advising appointment, and if applied, it must be gone.
    check: ({ db, proposals }) => {
      const p = proposals.find((x) => x.tool_name === 'cancel_event');
      if (!p) return 'no cancel_event proposal';
      if ((p.tool_args as { event_id?: string }).event_id !== 'evt-advising') return `cancelled ${(p.tool_args as { event_id?: string }).event_id}`;
      if (p.status === 'approved') return expect(titled(db, D.FR, /Advising/).length === 0, 'advising still on the calendar');
      return expect(p.status === 'pending', `cancel proposal is ${p.status}`);
    },
    oracle: () => ({ tool: 'cancel_event', args: { event_id: 'evt-advising', expect_title: 'Advising appointment' } }),
  },
  {
    id: 'c12',
    kind: 'reminder',
    message: 'remind me to call mom friday at 6pm',
    tools: ['set_reminder'],
    check: ({ db }) => {
      const r = listReminders(db).find((x) => /mom/i.test(x.title));
      return expect(r?.date === D.FR && r?.time === '18:00', `reminder ${r ? `${r.date} ${r.time}` : 'missing'}, want ${D.FR} 18:00`);
    },
    oracle: () => ({ tool: 'set_reminder', args: { date: D.FR, time: '18:00', title: 'Call mom' } }),
  },
  {
    id: 'c13',
    kind: 'question',
    message: 'what time is my gym tomorrow?',
    tools: [],
    check: ({ reply }) => expect(/5:30/.test(reply), `reply doesn't say 5:30: "${reply.slice(0, 80)}"`),
  },
  {
    id: 'c14',
    kind: 'question',
    message: 'when is my next class?',
    tools: [],
    check: ({ reply }) => expect(/340L|Matrices|10(:00)?\s*AM/i.test(reply), `reply doesn't name M 340L at 10: "${reply.slice(0, 80)}"`),
  },
  {
    id: 'c15',
    kind: 'recurring',
    message: 'make my gym sessions 2 hours long',
    tools: ['set_duration'],
    check: ({ db }) =>
      expect(mins(gym(db, D.MO)[0]) === 120 && mins(gym(db, D.TH2)[0]) === 120, `gym lengths ${mins(gym(db, D.MO)[0])}/${mins(gym(db, D.TH2)[0])}, want 120`),
    oracle: () => ({ tool: 'set_duration', args: { event_id: 'gym-mo', expect_title: 'Gym', duration_minutes: 120 } }),
  },
  {
    id: 'c16',
    kind: 'move',
    message: 'on tuesday put my cook session right after my last class',
    tools: ['place_adjacent', 'set_event_time', 'shift_events'],
    check: ({ db }) => {
      const s = start(cookOn(db, D.TU)[0]);
      return all(
        expect(s !== null && s >= '17:00' && s <= '17:45', `Tuesday cook at ${s}, want 17:00–17:45 (ECO ends 17:00)`),
        sameNextWeek(db, D.TU2, cookOn, '18:30', 'Tuesday cook'),
        expect(start(titled(db, D.TU, /Career fair/)[0]) === '13:00', 'the career fair moved too'),
      );
    },
    oracle: () => ({
      tool: 'place_adjacent',
      args: { event_id: 'cook-tu', expect_title: 'Cook lunches', date: D.TU, anchor_title: 'ECO 304K Microeconomics', position: 'after', gap_minutes: 0 },
    }),
    wrong: [{ tool: 'shift_events', args: { scope: 'series', date: D.TU, event_id: 'cook-tu', expect_title: 'Cook lunches', delta_minutes: -90 } }],
  },
  {
    id: 'c17',
    kind: 'preference',
    // Not a default (cook-before-gym already is — asking for it passes with no
    // change), and unambiguous: a stated window replaces the old one.
    message: 'from now on I prefer to cook between 5 and 8pm',
    tools: ['set_preference'],
    check: ({ db }) => {
      const w = getPreferences(db).windows.cook ?? [];
      return expect(w.length === 1 && w[0] === '17:00-20:00', `cook window ${JSON.stringify(w)}, want ["17:00-20:00"]`);
    },
    oracle: () => ({ tool: 'set_preference', args: { type: 'window', kind: 'cook', windows: ['17:00-20:00'] } }),
  },
  {
    id: 'c18',
    kind: 'refuse',
    message: 'move ECO 304K tomorrow to 5pm',
    tools: [],
    check: ({ db, proposals }) =>
      all(expect(eco(db, D.TH) === '15:30', 'pinned class moved'), expect(applied(proposals).length === 0, 'something was applied')),
  },
  {
    id: 'c19',
    kind: 'move',
    message: "push tomorrow's study group back 30 min",
    tools: ['shift_events', 'set_event_time'],
    check: ({ db }) => {
      const s = start(titled(db, D.TH, /Study group/)[0]);
      return all(
        expect(s === '20:00', `study group at ${s}, want 20:00`),
        expect(start(gym(db, D.TH)[0]) === '17:30', "tomorrow's gym moved too"),
      );
    },
    oracle: () => ({ tool: 'shift_events', args: { scope: 'single', date: D.TH, event_id: 'evt-study', expect_title: 'Study group — CS 331', delta_minutes: 30 } }),
    wrong: [{ tool: 'shift_events', args: { scope: 'day', date: D.TH, delta_minutes: 30 } }],
  },
  {
    id: 'c20',
    kind: 'move',
    message: "move monday's gym to 6pm",
    tools: ['set_event_time', 'shift_events'],
    check: ({ db }) =>
      all(
        expect(start(gym(db, D.MO)[0]) === '18:00', `Monday gym at ${start(gym(db, D.MO)[0])}, want 18:00`),
        expect(start(gym(db, D.MO2)[0]) === '17:00', 'the following Monday moved too (should be one day only)'),
      ),
    oracle: () => ({ tool: 'set_event_time', args: { event_id: 'gym-mo', expect_title: 'Gym', date: D.MO, start_time: '18:00', end_time: '19:30' } }),
    wrong: [{ tool: 'shift_events', args: { scope: 'series', date: D.MO, event_id: 'gym-mo', expect_title: 'Gym', delta_minutes: 60 } }],
  },
  {
    id: 'c21',
    kind: 'chat',
    message: 'thanks!',
    tools: [],
    check: ({ proposals }) => expect(proposals.length === 0, 'made a change'),
  },
  {
    id: 'c22',
    kind: 'create',
    message: 'block 2 hours to study saturday afternoon',
    tools: ['create_event', 'block_free_time', 'fit_in_event'],
    check: ({ db }) => {
      const s = titled(db, D.SA, /stud/i)[0];
      const st = start(s);
      return all(
        expect(st !== null && st >= '12:00' && st <= '16:00' && mins(s) === 120, `Saturday study ${st} (${mins(s)} min), want an afternoon 120-min block`),
        expect(titled(db, D.SA2, /stud/i).length === 0, 'created a weekly series — one block was asked'),
      );
    },
    oracle: () => ({ tool: 'create_event', args: { title: 'Study', kind: 'personal', date: D.SA, start_time: '14:00', duration_minutes: 120 } }),
    wrong: [{ tool: 'create_event', args: { title: 'Study', kind: 'personal', date: D.SA, start_time: '14:00', duration_minutes: 120, repeat: { frequency: 'weekly', days: ['SA'] } } }],
  },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface RunRecord {
  id: string;
  kind: Case['kind'];
  message: string;
  rep: number;
  /** The frozen clock this run saw (advances a minute per run — see clockFor). */
  now: string;
  total_ms: number;
  rounds: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  prompt_build_ms: number;
  db_ms: number;
  tools: { name: string; status: string; args: Record<string, unknown> }[];
  tool_ok: boolean;
  state_ok: boolean;
  correct: boolean;
  /** A model round threw (backend down, CLI logged out…). Scored as a miss, left out of latency/tokens. */
  errored: boolean;
  /** The primary backend failed and another answered. Left out of latency/tokens. */
  fell_back: boolean;
  why: string | null;
  reply: string;
  backends: string[];
  trace: TurnTrace;
}

function args(): { label: string; reps: number; only: Set<string> | null; validate: boolean } {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const reps = Number(get('--reps') ?? 1);
  if (!Number.isInteger(reps) || reps < 1) throw new Error(`--reps must be a positive integer, got ${get('--reps')}`);
  return {
    label: get('--label') ?? 'run',
    reps,
    only: get('--only') ? new Set(get('--only')!.split(',')) : null,
    validate: a.includes('--validate'),
  };
}

/**
 * The clock for run #i: EVAL_NOW plus i minutes (cycling within 50, so it stays
 * a Wednesday morning before the 10 AM class every check assumes). In
 * production the system prompt's `Now:` line changes every minute and the
 * schedule after every commit; a frozen, identical prompt on every run would
 * hand the eval prompt-cache hits real turns never get.
 */
function clockFor(i: number): string {
  return addMinutesWall(EVAL_NOW, i % 50);
}

function fresh(): { db: DB; fx: DemoFixture } {
  const db = resetDbForTests();
  const fx = seedDemoSemester(db, todayInTz());
  return { db, fx };
}

function toolOk(c: Case, proposals: ProposalRow[]): boolean {
  if (c.tools.length === 0) return applied(proposals).length === 0;
  return proposals.length > 0 && proposals.every((p) => c.tools.includes(p.tool_name));
}

/** Nearest-rank percentile; null for an empty sample (never a fake 0). */
function pct(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i]!;
}

async function validate(): Promise<void> {
  let bad = 0;
  for (const [i, c] of CASES.entries()) {
    if (!c.oracle) {
      console.log(`  -   ${c.id} (no change wanted) "${c.message}"`);
      continue;
    }
    process.env.MISE_NOW = clockFor(i);
    const { db, fx } = fresh();
    const { tool: name, args: a } = c.oracle(fx);
    const tool = getModelTool(name);
    if (!tool || tool.kind !== 'mutation') throw new Error(`${c.id}: oracle tool ${name} is not a model mutation tool`);
    const parsed = tool.argsSchema.parse(a);
    const result = await tool.run(parsed, 'dry');
    const prop = createProposal(db, { user_message: c.message, tool_name: name, tool_args: parsed, diff: result.diff, conflicts: result.conflicts });
    const settled = await settleForChat(prop);
    const r = c.check({ db, fx, proposals: [settled], reply: '' });
    // …and the check must NOT pass on an untouched calendar, or it proves nothing.
    const untouched = fresh();
    const vacuous = c.check({ db: untouched.db, fx: untouched.fx, proposals: [], reply: '' }) === true;
    // …and every plausible wrong answer must fail it.
    const leaks: string[] = [];
    for (const w of c.wrong ?? []) {
      const f = fresh();
      const wt = getModelTool(w.tool);
      if (!wt || wt.kind !== 'mutation') throw new Error(`${c.id}: wrong-call tool ${w.tool} is not a model mutation tool`);
      const wargs = wt.argsSchema.parse(w.args);
      const wr = await wt.run(wargs, 'dry');
      const wp = await settleForChat(createProposal(f.db, { user_message: c.message, tool_name: w.tool, tool_args: wargs, diff: wr.diff, conflicts: wr.conflicts }));
      if (wp.status !== 'approved') leaks.push(`${w.tool} ${JSON.stringify(w.args)} didn't apply (${wp.status}) — not a useful wrong answer`);
      else if (c.check({ db: f.db, fx: f.fx, proposals: [wp], reply: '' }) === true) leaks.push(`accepts wrong ${w.tool} ${JSON.stringify(w.args)}`);
    }
    if (r !== true || vacuous || leaks.length > 0) bad++;
    console.log(
      `  ${r === true && !vacuous && leaks.length === 0 ? 'OK ' : 'BAD'} ${c.id} ${name} [${settled.status}] rejects ${(c.wrong ?? []).length - leaks.length}/${(c.wrong ?? []).length} wrong ${r === true ? '' : r}${vacuous ? ' (passes with no change — vacuous)' : ''}${leaks.length ? ' ' + leaks.join('; ') : ''}`,
    );
  }
  if (bad > 0) {
    console.error(`${bad} oracle(s) did not satisfy their own check`);
    process.exit(1);
  }
  console.log('all oracles satisfy their checks');
}

async function main(): Promise<void> {
  const opt = args();
  if (opt.validate) return validate();

  const cases = CASES.filter((c) => !opt.only || opt.only.has(c.id));
  if (cases.length === 0) throw new Error(`--only ${[...(opt.only ?? [])].join(',')} matched no commands`);
  const runs: RunRecord[] = [];
  console.log(`latency-eval "${opt.label}" · ${cases.length} commands × ${opt.reps} · now=${EVAL_NOW}+ · backend env=${process.env.MISE_CHAT_BACKEND ?? '(default)'}`);

  let runIndex = 0;
  for (let rep = 0; rep < opt.reps; rep++) {
    for (const c of cases) {
      const now = clockFor(runIndex++);
      process.env.MISE_NOW = now;
      const { db, fx } = fresh();
      const { reply, proposals, trace } = await runAgentTurn(db, c.message, { settle: settleForChat });
      const errored = trace.rounds.some((r) => r.error !== undefined);
      const fellBack = trace.rounds.some((r) => r.meta.fallback_from !== undefined);
      const t_ok = toolOk(c, proposals);
      const s = c.check({ db, fx, proposals, reply });
      const sum = (f: (r: TurnTrace['rounds'][number]) => number | null | undefined) =>
        trace.rounds.reduce((acc, r) => acc + (f(r) ?? 0), 0);
      const rec: RunRecord = {
        id: c.id,
        kind: c.kind,
        message: c.message,
        rep,
        now,
        total_ms: trace.total_ms,
        rounds: trace.rounds.length,
        input_tokens: sum((r) => r.meta.input_tokens),
        cache_read_tokens: sum((r) => r.meta.cache_read_tokens),
        cache_write_tokens: sum((r) => r.meta.cache_write_tokens),
        output_tokens: sum((r) => r.meta.output_tokens),
        prompt_build_ms: trace.prompt_build_ms,
        db_ms: trace.db_ms,
        tools: proposals.map((p) => ({ name: p.tool_name, status: p.status, args: p.tool_args })),
        tool_ok: t_ok,
        state_ok: s === true,
        correct: !errored && t_ok && s === true,
        errored,
        fell_back: fellBack,
        why: errored
          ? `backend error: ${trace.rounds.find((r) => r.error)?.error}`
          : s === true
            ? t_ok
              ? null
              : `unexpected tool(s): ${proposals.map((p) => p.tool_name).join(',') || 'none'}`
            : s,
        reply,
        backends: [...new Set(trace.rounds.map((r) => `${r.meta.backend}${r.meta.model ? `/${r.meta.model}` : ''}${r.meta.fallback_from ? `(fallback)` : ''}`))],
        trace,
      };
      runs.push(rec);
      const flag = errored ? 'ERR ' : rec.correct ? 'OK  ' : 'MISS';
      console.log(
        `  ${flag} ${c.id} ${(rec.total_ms / 1000).toFixed(2).padStart(6)}s  r=${rec.rounds}  in=${rec.input_tokens + rec.cache_read_tokens + rec.cache_write_tokens}  ${rec.tools.map((t) => t.name).join(',') || '-'}  "${c.message}"${fellBack ? '  (FELL BACK)' : ''}${rec.why ? `  ← ${rec.why}` : ''}`,
      );
    }
  }

  // Latency / token / cache numbers come only from clean runs: a backend that
  // errored or fell back would otherwise pass off a 60 ms failure (or a 120 s
  // timeout) as the thing being measured. Accuracy counts every run, errors as misses.
  const clean = runs.filter((r) => !r.errored && !r.fell_back);
  const lat = clean.map((r) => r.total_ms);
  const simple = clean.filter((r) => r.kind === 'move').map((r) => r.total_ms);
  const totalIn = clean.reduce((a, r) => a + r.input_tokens + r.cache_read_tokens + r.cache_write_tokens, 0);
  const totalRead = clean.reduce((a, r) => a + r.cache_read_tokens, 0);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const summary = {
    label: opt.label,
    at: new Date().toISOString(),
    eval_now: EVAL_NOW,
    commands: cases.length,
    reps: opt.reps,
    runs: runs.length,
    clean_runs: clean.length,
    errored_runs: runs.filter((r) => r.errored).length,
    fallback_runs: runs.filter((r) => r.fell_back).length,
    backends: [...new Set(runs.flatMap((r) => r.backends))],
    p50_ms: pct(lat, 50),
    p90_ms: pct(lat, 90),
    mean_ms: lat.length ? Math.round(mean(lat)!) : null,
    simple_move_n: simple.length,
    simple_move_p50_ms: pct(simple, 50),
    simple_move_p90_ms: pct(simple, 90),
    rounds_mean: clean.length ? +mean(clean.map((r) => r.rounds))!.toFixed(2) : null,
    input_tokens_mean: clean.length ? Math.round(totalIn / clean.length) : null,
    output_tokens_mean: clean.length ? Math.round(mean(clean.map((r) => r.output_tokens))!) : null,
    cache_hit_rate: totalIn > 0 ? +(totalRead / totalIn).toFixed(3) : null,
    tool_accuracy: +(runs.filter((r) => r.tool_ok && !r.errored).length / runs.length).toFixed(3),
    outcome_accuracy: +(runs.filter((r) => r.correct).length / runs.length).toFixed(3),
    misses: runs.filter((r) => !r.correct).map((r) => ({ id: r.id, rep: r.rep, why: r.why })),
  };

  const dir = join(import.meta.dir, '..', 'eval', 'latency');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${opt.label}.json`);
  writeFileSync(out, JSON.stringify({ summary, runs }, null, 2));

  const s = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(2)}s`);
  const pc = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  console.log('');
  console.log(`| metric | ${opt.label} |`);
  console.log('|---|---|');
  console.log(`| backend | ${summary.backends.join(', ')} |`);
  console.log(`| runs (clean / errored / fell back) | ${summary.clean_runs} / ${summary.errored_runs} / ${summary.fallback_runs} |`);
  console.log(`| p50 latency (all) | ${s(summary.p50_ms)} |`);
  console.log(`| p90 latency (all) | ${s(summary.p90_ms)} |`);
  console.log(`| p50 / p90 simple moves (n=${summary.simple_move_n}) | ${s(summary.simple_move_p50_ms)} / ${s(summary.simple_move_p90_ms)} |`);
  console.log(`| rounds per turn | ${summary.rounds_mean ?? 'n/a'} |`);
  console.log(`| input tokens per turn | ${summary.input_tokens_mean ?? 'n/a'} |`);
  console.log(`| output tokens per turn | ${summary.output_tokens_mean ?? 'n/a'} |`);
  console.log(`| cache hit rate (input) | ${pc(summary.cache_hit_rate)} |`);
  console.log(`| tool accuracy | ${pc(summary.tool_accuracy)} |`);
  console.log(`| tool + outcome accuracy | ${pc(summary.outcome_accuracy)} |`);
  console.log(`\nwrote ${out}`);
  if (summary.errored_runs + summary.fallback_runs > 0) {
    console.warn(`\nWARNING: ${summary.errored_runs} errored and ${summary.fallback_runs} fell-back run(s) are excluded from latency/tokens and count as misses/flagged.`);
  }
  if (clean.length === 0) {
    console.error('No clean runs — the backend never answered. Nothing was measured.');
    process.exit(2);
  }
}

await main();
