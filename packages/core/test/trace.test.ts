/**
 * Per-turn latency tracing (trace.ts). The trace is measurement only, so the
 * tests pin two things: it records what happened (rounds, tool spans, DB time,
 * backend meta), and it records nothing outside a turn.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

process.env.MISE_SETTINGS_PATH = '/nonexistent/mise-trace-test-settings.json';

import { resetDbForTests, schema, type DB } from '../src/db/client';
import { runAgentTurn } from '../src/agent';
import type { ChatCompletionResult, chatCompletion } from '../src/ollama';
import { addDaysWall, composeTs, todayInTz } from '../src/time';
import { __clearTurnTraces, currentTrace, recentTurnTraces, summarizeTrace, traceSpan } from '../src/trace';
import { __setClaudeCliTestOverrides, claudeChatCompletion, claudeWithFallback, type ClaudeSpawnFn } from '../src/claude-cli';

const today = todayInTz();
const tomorrow = addDaysWall(today, 1);

let db: DB;

beforeEach(() => {
  __clearTurnTraces();
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'T', start_date: addDaysWall(today, -30), end_date: addDaysWall(today, 60), timezone: 'America/Chicago' })
    .run();
  db.insert(schema.event)
    .values({
      id: 'evt-gym',
      semester_id: 's1',
      title: 'Gym',
      kind: 'gym',
      starts_at: composeTs(tomorrow, '16:00'),
      ends_at: composeTs(tomorrow, '17:30'),
      pinned: false,
      rrule: null,
      source: 'manual',
      location: 'Gregory',
      notes: null,
    })
    .run();
});

function scripted(responses: ChatCompletionResult[]): typeof chatCompletion {
  let n = 0;
  return (async () => {
    const r = responses[n++];
    if (!r) throw new Error('exhausted');
    return r;
  }) as typeof chatCompletion;
}

const shiftCall: ChatCompletionResult = {
  message: {
    content: '',
    tool_calls: [
      {
        id: 'c1',
        type: 'function',
        function: {
          name: 'shift_events',
          arguments: JSON.stringify({ scope: 'single', date: tomorrow, event_id: 'evt-gym', expect_title: 'Gym', delta_minutes: 60 }),
        },
      },
    ],
  },
  meta: { backend: 'anthropic', model: 'test-model', ttft_ms: 12, input_tokens: 100, cache_read_tokens: 900, output_tokens: 20 },
};

describe('turn trace', () => {
  test('records every round, the tool dry-run, the commit, and DB time', async () => {
    const { trace } = await runAgentTurn(db, 'move my gym an hour later', {
      chat: scripted([shiftCall, { message: { content: 'Done.' } }]),
      // Refused by the gate: the model gets a second round to react.
      settle: async (p) => ({ ...p, conflicts: [{ type: 'pinned_moved', event_id: 'x', title: 'CS', instance_date: tomorrow } as never] }),
    });

    expect(trace.rounds).toHaveLength(2);
    expect(trace.rounds[0]!.meta).toMatchObject({ backend: 'anthropic', model: 'test-model', ttft_ms: 12, input_tokens: 100 });
    expect(trace.rounds[0]!.tool_calls).toBe(1);
    // A fake with no meta is labelled as injected, never guessed.
    expect(trace.rounds[1]!.meta.backend).toBe('injected');
    expect(trace.spans.map((s) => s.name)).toEqual(['dry:shift_events', 'commit:shift_events']);
    expect(trace.spans.every((s) => s.ok && s.ms >= 0)).toBe(true);
    expect(trace.db_queries).toBeGreaterThan(0);
    expect(trace.total_ms).toBeGreaterThanOrEqual(trace.rounds[1]!.start_ms);
    // Routed to the move family: its handful of tools, not all 26.
    expect(trace.route).toMatchObject({ families: ['move'], source: 'regex' });
    expect(trace.prompt.tools).toBe(6);
    expect(trace.prompt.system_chars).toBeGreaterThan(trace.prompt.context_chars);
    expect(trace.outcome).toMatchObject({ proposals: 1, applied: 0, tools: ['shift_events'] });
  });

  test('a failed model call is recorded as an errored round', async () => {
    const { trace, reply } = await runAgentTurn(db, 'hello', {
      chat: (async () => {
        throw new Error('backend down');
      }) as typeof chatCompletion,
    });
    expect(reply).toContain('bun run setup');
    expect(trace.rounds).toHaveLength(1);
    expect(trace.rounds[0]!.error).toContain('backend down');
  });

  test('tracing does not change which errors escape: a malformed result still throws', async () => {
    // Before tracing, reading res.message on a malformed result threw out of
    // the turn (a 500 from the route). Recording the round must not turn that
    // into the "backend down" reply.
    const bad = (async () => ({})) as unknown as typeof chatCompletion;
    await expect(runAgentTurn(db, 'hello', { chat: bad })).rejects.toThrow();
  });

  test('a status line built from bad model args never breaks the turn', async () => {
    const bad: ChatCompletionResult = {
      message: {
        content: '',
        tool_calls: [
          {
            id: 'b1',
            type: 'function',
            function: { name: 'set_event_time', arguments: JSON.stringify({ event_id: 'evt-gym', expect_title: 'Gym', date: '2026-09-31', start_time: '18:00', end_time: '19:00' }) },
          },
        ],
      },
    };
    const events: unknown[] = [];
    const { reply } = await runAgentTurn(db, 'gym at 6 on the 31st', {
      chat: scripted([bad, { message: { content: "There's no September 31st." } }]),
      onEvent: (e) => events.push(e),
    });
    expect(reply).toContain('September 31st');
  });

  test('finished turns land in the ring buffer, newest first, and summarize to one line', async () => {
    await runAgentTurn(db, 'first', { chat: scripted([{ message: { content: 'a' } }]) });
    await runAgentTurn(db, 'second', { chat: scripted([{ message: { content: 'b' } }]) });
    const recent = recentTurnTraces();
    expect(recent.map((t) => t.message)).toEqual(['second', 'first']);
    const line = JSON.stringify(summarizeTrace(recent[0]!));
    expect(line).not.toContain('\n');
    expect(line).not.toContain('You are Mise'); // no prompt text in the log line
  });

  test('outside a turn nothing is recorded and spans just run', async () => {
    expect(currentTrace()).toBeUndefined();
    expect(await traceSpan('x', () => 41 + 1)).toBe(42);
    db.select().from(schema.event).all();
    expect(recentTurnTraces()).toHaveLength(0);
  });

  test('span errors propagate unchanged and are marked not-ok', async () => {
    const { trace } = await runAgentTurn(db, 'move my gym an hour later', {
      chat: scripted([shiftCall, { message: { content: '' } }]),
      settle: async () => {
        throw new Error('gate exploded');
      },
    });
    const commit = trace.spans.find((s) => s.name === 'commit:shift_events');
    expect(commit?.ok).toBe(false);
  });
});

describe('claude CLI meta', () => {
  function okSpawn(json: unknown): ClaudeSpawnFn {
    return () => ({
      stdout: new Response(JSON.stringify(json)).body!,
      stderr: new Response('').body!,
      exited: Promise.resolve(0),
      kill() {},
    });
  }

  test('usage and durations from the CLI JSON are surfaced as meta', async () => {
    process.env.MISE_CLAUDE_BIN = '/fake/claude';
    __setClaudeCliTestOverrides({
      spawn: okSpawn({
        type: 'result',
        is_error: false,
        result: 'hi',
        session_id: 's',
        duration_ms: 2400,
        duration_api_ms: 2100,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7000, cache_creation_input_tokens: 300 },
      }),
    });
    try {
      const res = await claudeChatCompletion({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'yo' }] });
      expect(res.meta).toMatchObject({
        backend: 'claude-cli',
        ttft_ms: null,
        api_ms: 2100,
        backend_ms: 2400,
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 7000,
        cache_write_tokens: 300,
        resumed: false,
      });
    } finally {
      __setClaudeCliTestOverrides();
      delete process.env.MISE_CLAUDE_BIN;
    }
  });

  test('a fallback answer says it fell back, and why', async () => {
    process.env.MISE_CLAUDE_BIN = '/fake/claude';
    __setClaudeCliTestOverrides({
      spawn: okSpawn({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }),
      fallback: (async () => ({ message: { content: 'from ollama' } })) as typeof chatCompletion,
    });
    try {
      const res = await claudeWithFallback({ messages: [{ role: 'user', content: 'yo' }] });
      expect(res.message.content).toBe('from ollama');
      expect(res.meta).toMatchObject({ fallback_from: 'claude-cli', fallback_reason: 'not-authed' });
    } finally {
      __setClaudeCliTestOverrides();
      delete process.env.MISE_CLAUDE_BIN;
    }
  });
});
