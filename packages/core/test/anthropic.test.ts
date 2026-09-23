/**
 * Anthropic API backend. No network: the SDK client is replaced through
 * __setAnthropicTestOverrides, and the preload strips real credentials.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';

process.env.MISE_SETTINGS_PATH = '/nonexistent/mise-anthropic-test-settings.json';

import {
  __setAnthropicTestOverrides,
  anthropicChatCompletion,
  anthropicWithFallback,
  buildRequest,
  toAnthropicMessages,
  type AnthropicLike,
} from '../src/anthropic';
import { activeChatBackend } from '../src/claude-cli';
import { runAgentTurn, SYSTEM_PROMPT } from '../src/agent';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { modelToolSpecs } from '../src/tools/index';
import { addDaysWall, composeTs, todayInTz } from '../src/time';
import type { ChatCompletionOpts, ChatCompletionResult, chatCompletion } from '../src/ollama';

const ENV_KEYS = ['MISE_ANTHROPIC_MODEL', 'MISE_ANTHROPIC_ESCALATION_MODEL', 'MISE_ANTHROPIC_ESCALATION_EFFORT', 'MISE_CHAT_BACKEND', 'ANTHROPIC_API_KEY', 'MISE_CLAUDE_BIN'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __setAnthropicTestOverrides();
});

const baseOpts = (over: Partial<ChatCompletionOpts> = {}): ChatCompletionOpts => ({
  messages: [
    { role: 'system', content: 'STATIC\n\nCONTEXT\n\n/no_think' },
    { role: 'user', content: 'move my gym to 6pm' },
  ],
  tools: modelToolSpecs(),
  temperature: 0.1,
  system_blocks: [
    { text: 'STATIC', cache: true },
    { text: 'CONTEXT', cache: false },
  ],
  ...over,
});

function message(content: Anthropic.ContentBlock[], stop_reason: Anthropic.Message['stop_reason'], usage: Partial<Anthropic.Usage> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 7, output_tokens: 30, cache_read_input_tokens: 20000, cache_creation_input_tokens: 500, ...usage } as Anthropic.Usage,
  } as Anthropic.Message;
}

/** A client whose stream() yields one content_block_start then resolves to `results` in order. */
function fakeClient(results: (Anthropic.Message | Error)[]): AnthropicLike & { calls: Anthropic.MessageStreamParams[] } {
  const calls: Anthropic.MessageStreamParams[] = [];
  return {
    calls,
    messages: {
      stream(params) {
        calls.push(params);
        const r = results.shift();
        if (!r) throw new Error('fake client called more times than scripted');
        return {
          async *[Symbol.asyncIterator]() {
            if (r instanceof Error) throw r;
            yield { type: 'content_block_start', index: 0, content_block: r.content[0] ?? { type: 'text', text: '', citations: null } } as Anthropic.MessageStreamEvent;
          },
          finalMessage: async () => {
            if (r instanceof Error) throw r;
            return r;
          },
        };
      },
    },
  };
}

const toolUse = (id: string, name: string, input: unknown): Anthropic.ToolUseBlock =>
  ({ type: 'tool_use', id, name, input }) as Anthropic.ToolUseBlock;

describe('request shape', () => {
  test('tools + static system are the cached prefix; the per-turn context sits after the breakpoint', () => {
    const p = buildRequest(baseOpts());
    const sys = p.system as Anthropic.TextBlockParam[];
    expect(sys.map((b) => b.text)).toEqual(['STATIC', 'CONTEXT']);
    expect(sys[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(sys[1]!.cache_control).toBeUndefined();
    expect(p.cache_control).toEqual({ type: 'ephemeral' }); // automatic tail breakpoint
    const tools = p.tools as Anthropic.Tool[];
    expect(tools.map((t) => t.name)).toEqual(modelToolSpecs().map((t) => (t as { function: { name: string } }).function.name));
    expect(tools.every((t) => t.eager_input_streaming === true && !('$schema' in t.input_schema))).toBe(true);
    expect(p.tool_choice).toEqual({ type: 'auto' });
  });

  test('model routing: Haiku by default, Sonnet when escalated, both overridable', () => {
    expect(buildRequest(baseOpts()).model).toBe('claude-haiku-4-5');
    const esc = buildRequest(baseOpts({ tier: 'escalated' }));
    expect(esc.model).toBe('claude-sonnet-5');
    // Sonnet 5 rejects sampling params; effort only on the escalated tier.
    expect(esc.temperature).toBeUndefined();
    expect(esc.output_config).toEqual({ effort: 'low' });
    const def = buildRequest(baseOpts());
    expect(def.temperature).toBe(0.1);
    expect(def.output_config).toBeUndefined(); // Haiku 4.5 has no effort

    process.env.MISE_ANTHROPIC_MODEL = 'claude-sonnet-5';
    process.env.MISE_ANTHROPIC_ESCALATION_MODEL = 'claude-opus-5';
    expect(buildRequest(baseOpts()).model).toBe('claude-sonnet-5');
    expect(buildRequest(baseOpts()).temperature).toBeUndefined();
    expect(buildRequest(baseOpts({ tier: 'escalated' })).model).toBe('claude-opus-5');
  });

  test('messages: tool calls keep their ids, results merge into one user turn, leading assistant dropped', () => {
    const out = toAnthropicMessages([
      { role: 'system', content: 'x' },
      { role: 'assistant', content: 'stale receipt' },
      { role: 'user', content: 'do two things' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'toolu_a', type: 'function', function: { name: 'shift_events', arguments: '{"delta_minutes":60}' } },
          { id: 'toolu_b', type: 'function', function: { name: 'create_event', arguments: '{"title":"x"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_a', content: 'Done: a' },
      { role: 'tool', tool_call_id: 'toolu_b', content: 'Done: b' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const calls = out[1]!.content as Anthropic.ToolUseBlockParam[];
    expect(calls.map((c) => [c.id, c.name, c.input])).toEqual([
      ['toolu_a', 'shift_events', { delta_minutes: 60 }],
      ['toolu_b', 'create_event', { title: 'x' }],
    ]);
    const results = out[2]!.content as Anthropic.ToolResultBlockParam[];
    expect(results.map((r) => [r.type, r.tool_use_id])).toEqual([
      ['tool_result', 'toolu_a'],
      ['tool_result', 'toolu_b'],
    ]);
  });
});

describe('anthropicChatCompletion', () => {
  test('maps tool_use to tool_calls and reports usage, cache and time to first token', async () => {
    __setAnthropicTestOverrides({
      client: fakeClient([message([toolUse('toolu_1', 'shift_events', { scope: 'day', delta_minutes: 60 })], 'tool_use')]),
    });
    const res = await anthropicChatCompletion(baseOpts());
    expect(res.message.tool_calls).toEqual([
      { id: 'toolu_1', type: 'function', function: { name: 'shift_events', arguments: '{"scope":"day","delta_minutes":60}' } },
    ]);
    expect(res.meta).toMatchObject({
      backend: 'anthropic',
      tier: 'default',
      input_tokens: 7,
      cache_read_tokens: 20000,
      cache_write_tokens: 500,
      output_tokens: 30,
      stop_reason: 'tool_use',
    });
    expect(res.meta!.ttft_ms).toBeGreaterThanOrEqual(0);
  });

  test('a tool input cut off at max_tokens is never handed to the loop', async () => {
    __setAnthropicTestOverrides({ client: fakeClient([message([toolUse('t', 'shift_events', { scope: 'da' })], 'max_tokens')]) });
    await expect(anthropicChatCompletion(baseOpts())).rejects.toThrow('truncated');
  });

  test('a refusal runs none of its tool calls', async () => {
    __setAnthropicTestOverrides({
      client: fakeClient([message([{ type: 'text', text: 'No.', citations: null } as Anthropic.TextBlock, toolUse('t', 'cancel_event', {})], 'refusal')]),
    });
    const res = await anthropicChatCompletion(baseOpts());
    expect(res.message.tool_calls).toBeUndefined();
    expect(res.message.content).toBe('No.');
  });

  test('an unparseable streamed tool input is re-issued; API errors are not', async () => {
    const ok = message([toolUse('t', 'set_reminder', { title: 'x' })], 'tool_use');
    const c = fakeClient([new SyntaxError('Unexpected token'), ok]);
    __setAnthropicTestOverrides({ client: c });
    const res = await anthropicChatCompletion(baseOpts());
    expect(c.calls).toHaveLength(2);
    expect(res.meta!.json_retries).toBe(1);

    const rate = new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers());
    const c2 = fakeClient([rate, ok]);
    __setAnthropicTestOverrides({ client: c2 });
    await expect(anthropicChatCompletion(baseOpts())).rejects.toBeInstanceOf(Anthropic.RateLimitError);
    expect(c2.calls).toHaveLength(1);
  });

  test('on failure the call falls back, and the answer says so', async () => {
    const auth = new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } }, 'bad key', new Headers());
    __setAnthropicTestOverrides({
      client: fakeClient([auth]),
      fallback: (async () => ({ message: { content: 'from the CLI' }, meta: { backend: 'claude-cli', model: 'sonnet' } })) as never,
    });
    const res = await anthropicWithFallback(baseOpts());
    expect(res.message.content).toBe('from the CLI');
    expect(res.meta).toMatchObject({ backend: 'claude-cli', fallback_from: 'anthropic', fallback_reason: 'auth' });
  });
});

describe('review fixes', () => {
  test('a stalled stream is aborted by the idle watchdog and reported, not waited on', async () => {
    const prev = process.env.MISE_ANTHROPIC_IDLE_MS;
    let aborted = false;
    __setAnthropicTestOverrides({
      client: {
        messages: {
          stream() {
            let wake: (() => void) | undefined;
            return {
              async *[Symbol.asyncIterator]() {
                await new Promise<void>((r) => (wake = r)); // never yields until aborted
                throw new Error('aborted');
              },
              finalMessage: async () => {
                throw new Error('unreachable');
              },
              abort() {
                aborted = true;
                wake?.();
              },
            };
          },
        },
      },
    });
    process.env.MISE_ANTHROPIC_IDLE_MS = '50';
    try {
      const p = anthropicChatCompletion(baseOpts());
      await expect(Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('watchdog never fired')), 2_000))])).rejects.toThrow('stream idle');
      expect(aborted).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MISE_ANTHROPIC_IDLE_MS;
      else process.env.MISE_ANTHROPIC_IDLE_MS = prev;
    }
  });

  test('a config error turns the API off for a while instead of failing every round', async () => {
    const auth = new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } }, 'bad key', new Headers());
    const c = fakeClient([auth]);
    let fallbacks = 0;
    __setAnthropicTestOverrides({
      client: c,
      fallback: (async () => {
        fallbacks++;
        return { message: { content: 'cli' }, meta: { backend: 'claude-cli', model: 'sonnet' } };
      }) as never,
    });
    await anthropicWithFallback(baseOpts());
    const second = await anthropicWithFallback(baseOpts());
    expect(c.calls).toHaveLength(1); // the API was not tried again
    expect(fallbacks).toBe(2);
    expect(second.meta!.fallback_reason).toContain('disabled');
  });

  test('duplicate tool ids from text-protocol fallbacks are renamed with their results; blank user turns dropped', () => {
    const tc = (id: string) => ({ id, type: 'function' as const, function: { name: 'get_meals', arguments: '{}' } });
    const out = toAnthropicMessages([
      { role: 'user', content: 'hi' },
      { role: 'user', content: '   ' },
      { role: 'assistant', content: '', tool_calls: [tc('tc0')] },
      { role: 'tool', tool_call_id: 'tc0', content: 'a' },
      { role: 'assistant', content: '', tool_calls: [tc('tc0')] },
      { role: 'tool', tool_call_id: 'tc0', content: 'b' },
    ]);
    const ids = out.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).map((b) => ('id' in b ? b.id : (b as Anthropic.ToolResultBlockParam).tool_use_id));
    expect(ids).toEqual(['tc0', 'tc0', 'tc0_m4', 'tc0_m4']);
    expect(out.filter((m) => m.role === 'user' && typeof m.content === 'string')).toHaveLength(1);
  });
});

describe('backend selection', () => {
  test('an API key makes the API the default; MISE_CHAT_BACKEND still wins', () => {
    process.env.MISE_CLAUDE_BIN = '/fake/claude';
    expect(activeChatBackend()).toBe('claude');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(activeChatBackend()).toBe('anthropic');
    process.env.MISE_CHAT_BACKEND = 'claude';
    expect(activeChatBackend()).toBe('claude');
    process.env.MISE_CHAT_BACKEND = 'ollama';
    expect(activeChatBackend()).toBe('ollama');
    delete process.env.ANTHROPIC_API_KEY;
    process.env.MISE_CHAT_BACKEND = 'anthropic';
    expect(activeChatBackend()).toBe('claude'); // asked for the API without a key → next backend
  });
});

describe('agent loop on the API path', () => {
  let db: DB;
  const tomorrow = addDaysWall(todayInTz(), 1);
  beforeEach(() => {
    db = resetDbForTests();
    db.insert(schema.semester)
      .values({ id: 's1', name: 'T', start_date: addDaysWall(todayInTz(), -30), end_date: addDaysWall(todayInTz(), 60), timezone: 'America/Chicago' })
      .run();
    db.insert(schema.event)
      .values({ id: 'gym1', semester_id: 's1', title: 'Gym', kind: 'gym', starts_at: composeTs(tomorrow, '16:00'), ends_at: composeTs(tomorrow, '17:30'), pinned: false, rrule: null, source: 'manual', location: null, notes: null })
      .run();
  });

  test('sends the cacheable system blocks, and escalates after a call fails validation', async () => {
    const seen: ChatCompletionOpts[] = [];
    const script: ChatCompletionResult[] = [
      { message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shift_events', arguments: '{"scope":"single"}' } }] } },
      {
        message: {
          content: '',
          tool_calls: [
            {
              id: 'c2',
              type: 'function',
              function: { name: 'shift_events', arguments: JSON.stringify({ scope: 'single', date: tomorrow, event_id: 'gym1', expect_title: 'Gym', delta_minutes: 60 }) },
            },
          ],
        },
      },
      { message: { content: '' } },
    ];
    const chat = (async (opts: ChatCompletionOpts) => {
      seen.push({ ...opts, messages: [...opts.messages] });
      return script.shift()!;
    }) as typeof chatCompletion;

    const { proposals } = await runAgentTurn(db, 'push my gym tomorrow an hour', { chat });
    expect(proposals).toHaveLength(1);
    expect(seen[0]!.system_blocks![0]).toEqual({ text: SYSTEM_PROMPT, cache: true });
    expect(seen[0]!.system_blocks![1]!.cache).toBe(false);
    expect(seen[0]!.system_blocks![1]!.text).toContain('SCHEDULE');
    expect(seen.map((o) => o.tier)).toEqual(['default', 'escalated', 'escalated']);
  });

  test('only the calls a round answers are echoed; parallel bad calls cost one retry, so the escalated model still gets a round', async () => {
    const bad = (i: number) => ({ id: `b${i}`, type: 'function' as const, function: { name: 'shift_events', arguments: '{"scope":"single"}' } });
    const seen: ChatCompletionOpts[] = [];
    const script: ChatCompletionResult[] = [
      { message: { content: '', tool_calls: [bad(1), bad(2), bad(3), bad(4), bad(5)] } },
      { message: { content: 'Which gym?' } },
    ];
    const chat = (async (opts: ChatCompletionOpts) => {
      seen.push({ ...opts, messages: [...opts.messages] });
      return script.shift()!;
    }) as typeof chatCompletion;
    const { reply } = await runAgentTurn(db, 'move my gym', { chat });
    expect(reply).toBe('Which gym?'); // not "couldn't produce valid arguments"
    const round2 = seen[1]!.messages;
    const echoed = round2.find((m) => m.role === 'assistant')!;
    expect(echoed.tool_calls).toHaveLength(4);
    expect(round2.filter((m) => m.role === 'tool')).toHaveLength(4);
    expect(seen[1]!.tier).toBe('escalated');
  });
});
