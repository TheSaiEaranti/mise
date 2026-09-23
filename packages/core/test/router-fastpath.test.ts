/**
 * Phase 3: the intent router, the fast-path parser (and its fall-throughs),
 * and ending the turn early once a change has committed.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

process.env.MISE_SETTINGS_PATH = '/nonexistent/mise-router-test-settings.json';

import { resetDbForTests, schema, type DB } from '../src/db/client';
import { buildContext, promptFor, PROMPT_SECTIONS, runAgentTurn, SYSTEM_PROMPT } from '../src/agent';
import { CORE_SECTIONS, FAMILY_SECTIONS, FAMILY_TOOLS, requestedDirection, resolveDays, route } from '../src/router';
import { parseFastIntent, resolveFastCall } from '../src/fast-path';
import { getModelTool } from '../src/tools/index';
import { addDaysWall, todayInTz, weekdayCode } from '../src/time';
import type { ChatCompletionOpts, ChatCompletionResult, chatCompletion } from '../src/ollama';
import type { ProposalRow } from '../src/proposals';

const T = todayInTz(); // the preload freezes the clock (Tue 2026-09-01)
const nextDate = (code: string) => {
  for (let i = 0; i < 7; i++) if (weekdayCode(addDaysWall(T, i)) === code) return addDaysWall(T, i);
  return T;
};

describe('router', () => {
  const fam = (m: string) => route(m, T).families;

  test('places the common requests in one family', () => {
    expect(fam('move my gym block to 6pm')).toEqual(['move']);
    expect(fam('shift everything after 3pm tomorrow back an hour')).toEqual(['move']);
    expect(fam('no gym on Fridays')).toEqual(['recurring']);
    expect(fam('gym only on monday wednesday and friday from now on')).toEqual(['recurring']);
    expect(fam('make my gym sessions 2 hours long')).toEqual(['recurring']);
    expect(fam('add a study session friday 2-4pm')).toEqual(['create']);
    expect(fam('friends are coming over at 8 tonight')).toEqual(['create']);
    expect(fam('cancel my advising appointment')).toEqual(['cancel']);
    expect(fam('remind me to call mom friday at 6pm')).toEqual(['reminder']);
    expect(fam('from now on I prefer to cook between 5 and 8pm')).toEqual(['preference']);
    expect(fam('what time is my gym tomorrow?')).toEqual(['question']);
  });

  test('compound or open-ended requests start on the stronger model; small talk never does', () => {
    expect(route('friends over at 8, and push the cook session back', T).complex).toBe(true);
    expect(route('rearrange my week so I can study more', T).complex).toBe(true);
    expect(route('move my gym block to 6pm', T).complex).toBe(false);
    expect(route('thanks!', T)).toMatchObject({ families: ['general'], complex: false, tools: null, sections: null });
  });

  test('two requests in one message keep both families (review fixes)', () => {
    expect(route('dinner with my parents at 7, push cook later', T)).toMatchObject({ families: expect.arrayContaining(['move', 'create']), complex: true });
    expect(route('move my gym to 7 tonight and remind me at 6:30 to pack my bag', T).families.sort()).toEqual(['move', 'reminder']);
    expect(fam('add a 30-min break between class and cooking lunch')).toEqual(['preference']);
    expect(fam('never mind, push the gym back an hour')).toEqual(['move']); // "never mind" is not a rule
    expect(fam('remind me to move my car tomorrow')).toEqual(['reminder']);
  });

  test('reads which way Sai asked for something to move — only when unambiguous', () => {
    expect(requestedDirection('move the career fiar a little later, i want a break between classes')).toBe('later');
    // "back" is earlier, always (Sai's convention); a bare "push" is later.
    expect(requestedDirection('shift everything after 3pm tomorrow back an hour')).toBe('earlier');
    expect(requestedDirection('push my gym back 30 minutes')).toBe('earlier');
    expect(requestedDirection("push tomorrow's study group back 30 min")).toBe('earlier');
    expect(requestedDirection('push the gym an hour')).toBe('later');
    expect(requestedDirection('push my gym 30 minutes later')).toBe('later');
    expect(requestedDirection('delay the cook session')).toBe('later');
    expect(requestedDirection('move my gym up an hour')).toBe('earlier');
    expect(requestedDirection('move my cook session on tuesday 30 minutes earlier')).toBe('earlier');
    for (const m of ['move gym later and cook earlier', 'move my gym forward 30 min', 'tuesday is chest and back', 'move my gym back to 5pm', 'move my gym to 6pm']) {
      expect(requestedDirection(m)).toBeNull();
    }
  });

  test('unplaceable messages fall back to the full prompt and every tool', () => {
    const r = route('I am so tired of this week honestly', T);
    expect(r.source).toBe('fallback');
    expect(r.tools).toBeNull();
    expect(r.sections).toBeNull();
    expect(promptFor(r.sections)).toBe(SYSTEM_PROMPT);
  });

  test('days: only the days the request touches; wide for cross-week families', () => {
    // The named days, plus today and tomorrow (so a gym on another day is never hidden).
    expect(resolveDays('move tomorrow\'s gym to 7pm', T)).toEqual([T, addDaysWall(T, 1)]);
    expect(resolveDays('move friday\'s gym to saturday', T)).toEqual([...new Set([T, addDaysWall(T, 1), nextDate('FR'), nextDate('SA')])].sort());
    expect(resolveDays('move my gym on the 25th to 6pm', T)).toBeNull(); // a date it can't read → the whole window
    expect(resolveDays('push everything this week back', T)).toBeNull();
    expect(route('no gym on fridays', T).days).toBeNull();
    expect(route('move my gym block to 6pm', T).days).toHaveLength(7); // no day named: today + the week ahead
  });

  test('every prompt paragraph is filed under the core or a family — nothing was dropped', () => {
    const filed = new Set([...CORE_SECTIONS, ...Object.values(FAMILY_SECTIONS).flat()]);
    const orphans = PROMPT_SECTIONS.filter((p) => !filed.has(p.id)).map((p) => p.id);
    expect(orphans).toEqual([]);
    expect(PROMPT_SECTIONS.find((p) => p.id === '3a')).toBeDefined();
    // Every family's tools are real model tools.
    for (const names of Object.values(FAMILY_TOOLS)) for (const n of names) expect(getModelTool(n)).toBeDefined();
    // A routed prompt is much smaller than the whole manual.
    expect(promptFor(FAMILY_SECTIONS.move).length).toBeLessThan(SYSTEM_PROMPT.length / 2);
  });
});

describe('fast-path parser', () => {
  test('reads the high-frequency phrasings', () => {
    expect(parseFastIntent('move my gym block to 6pm')).toEqual({ kind: 'time', target: 'gym', day: null, time: '18:00' });
    expect(parseFastIntent("move tomorrow's gym to 7:30pm")).toEqual({ kind: 'time', target: 'gym', day: 'tomorrow', time: '19:30' });
    expect(parseFastIntent("move friday's gym to saturday")).toEqual({ kind: 'day', target: 'gym', day: 'friday', toDay: 'saturday' });
    expect(parseFastIntent('push my gym back 30 minutes')).toEqual({ kind: 'delta', target: 'gym', day: null, minutes: -30 });
    expect(parseFastIntent('push my gym 30 minutes later')).toEqual({ kind: 'delta', target: 'gym', day: null, minutes: 30 });
    expect(parseFastIntent('move my gym 30 minutes back')).toEqual({ kind: 'delta', target: 'gym', day: null, minutes: -30 });
    expect(parseFastIntent('move my cook session on tuesday 30 minutes earlier')).toEqual({ kind: 'delta', target: 'cook', day: 'tuesday', minutes: -30 });
    expect(parseFastIntent('push the gym back an hour')).toEqual({ kind: 'delta', target: 'gym', day: null, minutes: -60 });
    expect(parseFastIntent('Please move my gym to 18:00.')).toEqual({ kind: 'time', target: 'gym', day: null, time: '18:00' });
    expect(parseFastIntent('shift everything after 3pm tomorrow back an hour')).toEqual({ kind: 'bulk', day: 'tomorrow', afterTime: '15:00', minutes: -60 });
    expect(parseFastIntent('shift everything after 3pm tomorrow later by an hour')).toEqual({ kind: 'bulk', day: 'tomorrow', afterTime: '15:00', minutes: 60 });
  });

  test('falls through on anything ambiguous', () => {
    for (const m of [
      'move my gym to 6', // am or pm?
      'move my gym forward 30 min', // forward = earlier or later?
      'push everything back an hour', // bulk
      'move gym and cook later', // compound
      'move my gym sessions to 6pm', // plural
      'push everything after 3 tomorrow back an hour', // bare "3"
      'move my gym later', // no amount
      'move my gym to next week', // not a day
      'can you maybe move the gym somewhere tomorrow evening',
      "move tonight's movie to 11:15", // 11:15 AM or PM?
      'push everything tonight back 30 minutes', // tonight isn't the whole day
    ]) {
      expect(parseFastIntent(m)).toBeNull();
    }
  });
});

let db: DB;
const tomorrow = addDaysWall(T, 1);

function seed(): void {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'T', start_date: addDaysWall(T, -30), end_date: addDaysWall(T, 60), timezone: 'America/Chicago' })
    .run();
  const ev = (id: string, title: string, kind: 'gym' | 'class' | 'personal', date: string, s: string, e: string, pinned = false) => ({
    id, semester_id: 's1', title, kind, starts_at: `${date}T${s}`, ends_at: `${date}T${e}`, pinned, rrule: null, source: 'manual' as const, location: null, notes: null,
  });
  db.insert(schema.event)
    .values([
      ev('gym1', 'Gym', 'gym', tomorrow, '16:00', '17:30'),
      ev('cls1', 'CS 331', 'class', tomorrow, '11:00', '12:30', true),
      ev('stu1', 'Study group', 'personal', tomorrow, '19:30', '21:00'),
    ])
    .run();
}

describe('fast-path resolution', () => {
  beforeEach(seed);

  test('one matching block → one tool call that keeps its length', () => {
    const call = resolveFastCall(db, parseFastIntent("move tomorrow's gym to 6pm")!, T)!;
    expect(call.tool).toBe('set_event_time');
    expect(call.args).toMatchObject({ event_id: 'gym1', expect_title: 'Gym', date: tomorrow, start_time: '18:00', end_time: '19:30' });
  });

  test('whole words only, forward day moves only, no small-hours starts (review fixes)', () => {
    db.insert(schema.event)
      .values({ id: 'br1', semester_id: 's1', title: 'Brunch with Sam', kind: 'personal', starts_at: `${tomorrow}T11:00`, ends_at: `${tomorrow}T12:00`, pinned: false, rrule: null, source: 'manual', location: null, notes: null })
      .run();
    expect(resolveFastCall(db, parseFastIntent("move tomorrow's run to 7pm")!, T)).toBeNull(); // not b-RUN-ch
    expect(resolveFastCall(db, parseFastIntent("move tomorrow's brunch to 1pm")!, T)?.args).toMatchObject({ event_id: 'br1' });
    expect(resolveFastCall(db, parseFastIntent("move tomorrow's gym to 12am")!, T)).toBeNull();
    // A weekday earlier than the source day is never "next week's".
    const d = parseFastIntent(`move tomorrow's gym to ${['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(`${T}T12:00`).getDay()]}`)!;
    expect(resolveFastCall(db, d, T)).toBeNull();
  });

  test('no match today, a pinned class, or a move across midnight → the model', () => {
    expect(resolveFastCall(db, parseFastIntent('move my gym to 6pm')!, T)).toBeNull(); // no gym today
    expect(resolveFastCall(db, parseFastIntent('move tomorrow\'s cs 331 to 3pm')!, T)).toBeNull(); // pinned
    expect(resolveFastCall(db, parseFastIntent("push tomorrow's study group 4 hours later")!, T)).toBeNull(); // past midnight
  });

  test('a fast-path turn never calls the model and still files + commits a Proposal row', async () => {
    let modelCalls = 0;
    const chat = (async () => {
      modelCalls++;
      return { message: { content: 'x' } };
    }) as typeof chatCompletion;
    const settle = async (p: ProposalRow) => ({ ...p, status: 'approved' as const });
    const { reply, proposals, trace } = await runAgentTurn(db, "push tomorrow's gym back 30 minutes", { chat, settle });
    expect(modelCalls).toBe(0);
    expect(trace.route?.source).toBe('fast_path');
    expect(proposals.map((p) => p.tool_name)).toEqual(['shift_events']);
    expect(db.select().from(schema.proposal).all()).toHaveLength(1);
    expect(reply).toContain('Moved Gym');
  });
});

describe('ending the turn early', () => {
  beforeEach(seed);

  const shift = (id: string): ChatCompletionResult => ({
    message: {
      content: '',
      tool_calls: [{ id, type: 'function', function: { name: 'shift_events', arguments: JSON.stringify({ scope: 'single', date: tomorrow, event_id: 'gym1', expect_title: 'Gym', delta_minutes: 60 }) } }],
    },
  });
  const counting = (script: ChatCompletionResult[]) => {
    const seen: ChatCompletionOpts[] = [];
    const chat = (async (o: ChatCompletionOpts) => {
      seen.push(o);
      const r = script.shift();
      if (!r) throw new Error('model called more times than scripted');
      return r;
    }) as typeof chatCompletion;
    return { chat, seen };
  };

  test('a clean commit ends the turn: no summarising round', async () => {
    const { chat, seen } = counting([shift('a'), { message: { content: 'should never be asked' } }]);
    const settle = async (p: ProposalRow) => ({ ...p, status: 'approved' as const });
    const { reply } = await runAgentTurn(db, 'the gym tomorrow, an hour later please, if you can', { chat, settle, fastPath: false });
    expect(seen).toHaveLength(1);
    expect(reply).toContain('Moved Gym');
  });

  test('a refused change gets another round so the model can say why', async () => {
    const { chat, seen } = counting([shift('a'), { message: { content: "That runs into your class." } }]);
    const settle = async (p: ProposalRow) => ({ ...p, conflicts: [{ type: 'pinned_moved', event_id: 'cls1', title: 'CS 331' }] as never });
    await runAgentTurn(db, 'the gym tomorrow, an hour later please, if you can', { chat, settle, fastPath: false });
    expect(seen).toHaveLength(2);
  });

  test('a compound turn is not ended early: its second request may need the first committed', async () => {
    const { chat, seen } = counting([shift('a'), { message: { content: '' } }]);
    const settle = async (p: ProposalRow) => ({ ...p, status: 'approved' as const });
    await runAgentTurn(db, 'dinner with sam at 8 tomorrow, push the gym an hour later', { chat, settle, fastPath: false });
    expect(seen).toHaveLength(2);
  });

  test('a move the opposite way from what he asked is never filed — the model has to explain instead', async () => {
    // The live bug: "a little later" came back as −30 min (later would have
    // hit a pinned class), and the career fair moved earlier.
    const wrong: ChatCompletionResult = {
      message: {
        content: '',
        tool_calls: [{ id: 'w', type: 'function', function: { name: 'shift_events', arguments: JSON.stringify({ scope: 'single', date: tomorrow, event_id: 'gym1', expect_title: 'Gym', delta_minutes: -30 }) } }],
      },
    };
    const { chat, seen } = counting([wrong, { message: { content: 'Later runs into your study group at 7:30 — want it earlier instead?' } }]);
    const settle = async (p: ProposalRow) => ({ ...p, status: 'approved' as const });
    const { reply, proposals } = await runAgentTurn(db, 'move the gym tomorrow a little later', { chat, settle, fastPath: false });
    expect(proposals).toHaveLength(0);
    expect(db.select().from(schema.proposal).all()).toHaveLength(0);
    expect(db.select().from(schema.event).all().find((e) => e.id === 'gym1')!.starts_at).toBe(`${tomorrow}T16:00`);
    const toolMsg = seen[1]!.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toContain('NOT applied');
    expect(seen[1]!.tier).toBe('escalated'); // the retry goes to the stronger model
    expect(reply).toContain('want it earlier instead?');
  });

  test('the direction carries over when he is answering the assistant\'s own question', async () => {
    // Live: "a little later" → "how much of a break?" → "like next available
    // slot" → moved EARLIER, because the answer itself names no direction.
    db.insert(schema.chatMessage)
      .values([
        { id: 'm1', proposal_id: null, role: 'user', content: 'move the gym tomorrow a little later', created_at: `${T}T08:00` },
        { id: 'm2', proposal_id: null, role: 'assistant', content: 'How much later — 15 minutes, 30?', created_at: `${T}T08:00` },
      ])
      .run();
    const wrong: ChatCompletionResult = {
      message: {
        content: '',
        tool_calls: [{ id: 'w2', type: 'function', function: { name: 'shift_events', arguments: JSON.stringify({ scope: 'single', date: tomorrow, event_id: 'gym1', expect_title: 'Gym', delta_minutes: -45 }) } }],
      },
    };
    const { chat, seen } = counting([wrong, { message: { content: 'The next slot later is after your study group — want 9 PM?' } }]);
    const settle = async (p: ProposalRow) => ({ ...p, status: 'approved' as const });
    const { proposals } = await runAgentTurn(db, 'like the next available slot', { chat, settle, fastPath: false });
    expect(proposals).toHaveLength(0);
    expect(seen[1]!.messages.find((m) => m.role === 'tool')!.content).toContain('NOT applied');
  });

  test('the same move in the direction he asked goes through', async () => {
    const { chat } = counting([shift('ok')]);
    const settle = async (p: ProposalRow) => ({ ...p, status: 'approved' as const });
    const { proposals } = await runAgentTurn(db, 'move the gym tomorrow a little later', { chat, settle, fastPath: false });
    expect(proposals.map((p) => p.tool_name)).toEqual(['shift_events']);
  });

  test('"back" means earlier: a +60 answer to "back an hour" is refused, and the fast path shifts −60', async () => {
    // The demo bug: "shift everything after 3pm tomorrow back an hour" moved
    // everything an hour LATER. For Sai "back" is earlier, always.
    const { chat, seen } = counting([shift('b'), { message: { content: 'Earlier, then?' } }]);
    const settle = async (p: ProposalRow) => ({ ...p, status: 'approved' as const });
    const r1 = await runAgentTurn(db, 'the gym tomorrow, push it back an hour', { chat, settle, fastPath: false });
    expect(r1.proposals).toHaveLength(0);
    expect(seen[1]!.messages.find((m) => m.role === 'tool')!.content).toContain('NOT applied');

    const call = resolveFastCall(db, parseFastIntent('shift everything after 3pm tomorrow back an hour')!, T);
    expect(call?.args).toMatchObject({ scope: 'day', date: tomorrow, after_time: '15:00', delta_minutes: -60 });
  });

  test('without a commit policy nothing is final, so the loop behaves as before', async () => {
    const { chat, seen } = counting([shift('a'), { message: { content: '' } }]);
    await runAgentTurn(db, 'the gym tomorrow, an hour later please, if you can', { chat, fastPath: false });
    expect(seen).toHaveLength(2);
  });
});

describe('trimmed context', () => {
  beforeEach(seed);
  test('only the requested days are in the schedule table, and it says so', () => {
    const ctx = buildContext(db, { days: [tomorrow] });
    expect(ctx).toContain('only the days this request is about');
    expect(ctx).toContain('gym1');
    expect(buildContext(db, { days: [T] })).not.toContain('gym1');
    expect(buildContext(db)).toContain('gym1'); // default: the full window
  });
});
