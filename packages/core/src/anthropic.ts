/**
 * Anthropic Messages API chat backend. Same message-in / assistant-message-out
 * contract as ollama.ts's chatCompletion and claude-cli.ts's
 * claudeChatCompletion, so runAgentTurn's loop, the proposal spine, undo and
 * describeOutcome are untouched — this is a model swap, not a loop swap. The
 * model still never writes (I1): it only ever returns tool calls.
 *
 * Why it exists (see eval/latency/before.json): the CLI backend spent ~2.6s
 * per model round booting a `claude` process, emulated tool calls in text, and
 * carried ~95k tokens of unrelated connector tools into every call. Here:
 *   - one HTTPS request per round (keep-alive connection, no process spawn)
 *   - native tool use: real tool schemas, tool_use / tool_result blocks
 *   - streaming, so time-to-first-token is measured (and later surfaced)
 *   - prompt caching: tools + the static system prompt are one cached prefix;
 *     the volatile context (Now line, schedule) sits after the breakpoint
 *
 * Model routing: Haiku by default; the escalated tier (a stronger model) is
 * used when the agent loop asks for it — after a tool call fails validation,
 * or when the router marks a request complex. Both are env-configurable:
 *   MISE_ANTHROPIC_MODEL             default claude-haiku-4-5
 *   MISE_ANTHROPIC_ESCALATION_MODEL  default claude-sonnet-5
 *   MISE_ANTHROPIC_ESCALATION_EFFORT default low (ignored by models without effort)
 * Credentials: ANTHROPIC_API_KEY (Bun loads .env), or whatever the SDK
 * resolves by default.
 */
import Anthropic from '@anthropic-ai/sdk';
import { chatCompletion, type ChatCompletionOpts, type ChatCompletionResult, type ChatMessage, type ToolCall } from './ollama';
import { claudeWithFallback, resolveClaudeBin } from './claude-cli';
import { recordRound, type ChatMeta } from './trace';

export type AnthropicTier = 'default' | 'escalated';

export function anthropicModels(): { default: string; escalated: string } {
  return {
    default: process.env.MISE_ANTHROPIC_MODEL?.trim() || 'claude-haiku-4-5',
    escalated: process.env.MISE_ANTHROPIC_ESCALATION_MODEL?.trim() || 'claude-sonnet-5',
  };
}

/**
 * Sampling parameters (temperature/top_p/top_k) were removed on Opus 4.7+,
 * Sonnet 5 and newer — sending one is a 400. Haiku 4.5 and the 4.6-and-older
 * generation still take them.
 */
function acceptsSampling(model: string): boolean {
  return /^claude-(3|haiku-|sonnet-4-[0-6]|opus-4-[0-6])/.test(model);
}

/** `output_config.effort` exists on Opus 4.5+, Sonnet 4.6+ and Fable/Mythos;
 *  it errors on Haiku 4.5, Sonnet 4.5 and older. */
function acceptsEffort(model: string): boolean {
  return /^claude-(opus-4-[5-9]|opus-5|sonnet-4-6|sonnet-5|fable|mythos)/.test(model);
}

const MAX_TOKENS = 4096; // a round is a tool call or a short reply; truncation is detected below
const JSON_RETRIES = 2;

export class AnthropicBackendError extends Error {
  constructor(
    public readonly kind: 'truncated' | 'bad-tool-json' | 'stalled',
    message: string,
  ) {
    super(message);
    this.name = 'AnthropicBackendError';
  }
}

// ---------------------------------------------------------------------------
// Client + test seam — bun tests never reach the network
// ---------------------------------------------------------------------------

/** The slice of the SDK this backend uses; tests inject a fake. */
export interface AnthropicLike {
  messages: {
    stream(params: Anthropic.MessageStreamParams): AsyncIterable<Anthropic.MessageStreamEvent> & {
      finalMessage(): Promise<Anthropic.Message>;
      abort?(): void;
    };
  };
}

let client: AnthropicLike | null = null;
let fallbackImpl: typeof claudeWithFallback | null = null;

/**
 * Time budget. The SDK's `timeout` only covers waiting for response headers
 * (the streamed body has none), so a stream that stalls after the 200 is cut
 * by our own idle watchdog. Worst case for one round: 2 attempts × 30s + SDK
 * backoff, then the CLI fallback's 120s — under Bun's 255s idleTimeout on the
 * HTTP request, so the chat route always answers.
 */
const HEADER_TIMEOUT_MS = 30_000;
function streamIdleMs(): number {
  const n = Number(process.env.MISE_ANTHROPIC_IDLE_MS);
  return Number.isFinite(n) && n > 0 ? n : 20_000;
}

function getClient(): AnthropicLike {
  // One SDK retry (429/5xx/connection): the fallback chain is the second line.
  client ??= new Anthropic({ timeout: HEADER_TIMEOUT_MS, maxRetries: 1 }) as unknown as AnthropicLike;
  return client;
}

/** Test seam. Call with no argument to restore the real client + fallback. */
export function __setAnthropicTestOverrides(
  o: { client?: AnthropicLike | null; fallback?: typeof claudeWithFallback | null } = {},
): void {
  client = o.client ?? null;
  fallbackImpl = o.fallback ?? null;
  disabledUntil = 0;
}

// ---------------------------------------------------------------------------
// Request assembly
// ---------------------------------------------------------------------------

/** OpenAI-style function spec (what tools/index.ts produces) → Anthropic tool. */
function toTools(tools: unknown[] | undefined): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => {
    const fn = (t as { function?: { name: string; description?: string; parameters?: Record<string, unknown> } }).function;
    if (!fn) throw new Error('tool spec without a function field');
    const { $schema: _ignored, ...schema } = (fn.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>;
    return {
      name: fn.name,
      description: fn.description,
      input_schema: schema as Anthropic.Tool.InputSchema,
      // Default for streamed requests with client tools. The server then does
      // not validate the input, so every input is re-validated against the
      // tool's zod schema by the agent loop before anything runs, and a
      // truncated turn (max_tokens) is refused below.
      eager_input_streaming: true,
    };
  });
}

function toSystem(opts: ChatCompletionOpts): Anthropic.TextBlockParam[] | undefined {
  if (opts.system_blocks && opts.system_blocks.length > 0) {
    return opts.system_blocks
      .filter((b) => b.text.trim() !== '')
      .map((b) => ({
        type: 'text' as const,
        text: b.text,
        ...(b.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
      }));
  }
  const sys = opts.messages[0]?.role === 'system' ? opts.messages[0].content : '';
  const text = sys.replace(/\s*\/no_think\s*$/, '').trim(); // qwen3-only switch
  return text ? [{ type: 'text', text }] : undefined;
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

/**
 * ChatMessage[] (OpenAI shape, shared by every backend) → Anthropic messages.
 * Assistant tool_calls become tool_use blocks carrying the SAME ids; the agent
 * loop's tool messages become tool_result blocks, and consecutive results are
 * merged into ONE user message (splitting them teaches Claude to stop making
 * parallel calls).
 */
export function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  // tool_use ids must be unique across the request. The text-protocol
  // fallbacks (CLI, Ollama) number theirs tc0, tc1… per response, so a turn
  // that fell back twice can repeat one; later repeats are renamed, and the
  // results that follow them are mapped to the same new id.
  const usedIds = new Set<string>();
  let rename = new Map<string, string>();
  messages.forEach((m, idx) => {
    if (m.role === 'system') return; // rendered via `system`
    if (m.role === 'user') {
      // The API rejects whitespace-only text; the route only checks length.
      if (m.content.trim() !== '') out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content && m.content.trim() !== '') blocks.push({ type: 'text', text: m.content });
      rename = new Map();
      for (const tc of m.tool_calls ?? []) {
        let id = tc.id;
        if (usedIds.has(id)) {
          id = `${tc.id}_m${idx}`;
          rename.set(tc.id, id);
        }
        usedIds.add(id);
        blocks.push({ type: 'tool_use', id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
      }
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      const callId = m.tool_call_id ?? '';
      const result: Anthropic.ToolResultBlockParam = { type: 'tool_result', tool_use_id: rename.get(callId) ?? callId, content: m.content };
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user' && Array.isArray(prev.content) && prev.content.every((b) => b.type === 'tool_result')) {
        (prev.content as Anthropic.ToolResultBlockParam[]).push(result);
      } else {
        out.push({ role: 'user', content: [result] });
      }
    }
  });
  // The first message must be from the user (history can start mid-exchange).
  while (out.length > 0 && out[0]!.role !== 'user') out.shift();
  return out;
}

export function buildRequest(opts: ChatCompletionOpts): Anthropic.MessageStreamParams {
  const models = anthropicModels();
  const tier: AnthropicTier = opts.tier ?? 'default';
  const model = tier === 'escalated' ? models.escalated : models.default;
  const effort = escalationEffort();
  const tools = toTools(opts.tools);
  return {
    model,
    max_tokens: opts.max_tokens ?? MAX_TOKENS,
    system: toSystem(opts),
    messages: toAnthropicMessages(opts.messages),
    ...(tools ? { tools, tool_choice: { type: 'auto' as const } } : {}),
    // Automatic breakpoint on the conversation tail: a second round of the
    // same turn re-reads the context + history it already sent. The explicit
    // breakpoint on the static system block is what carries ACROSS turns.
    cache_control: { type: 'ephemeral' },
    ...(opts.temperature !== undefined && acceptsSampling(model) ? { temperature: opts.temperature } : {}),
    ...(tier === 'escalated' && acceptsEffort(model) ? { output_config: { effort } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];
/** A bad value would 400 every escalated call; fall back to 'low' instead. */
function escalationEffort(): Effort {
  const raw = (process.env.MISE_ANTHROPIC_ESCALATION_EFFORT ?? '').trim().toLowerCase();
  if (raw === '') return 'low';
  if ((EFFORTS as readonly string[]).includes(raw)) return raw as Effort;
  console.warn(`[chat] MISE_ANTHROPIC_ESCALATION_EFFORT="${raw}" is not one of ${EFFORTS.join('|')} — using low`);
  return 'low';
}

function num(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * One model round. Throws Anthropic.APIError subclasses (auth, rate limit…)
 * and AnthropicBackendError; callers wanting a guaranteed answer go through
 * anthropicWithFallback.
 */
export async function anthropicChatCompletion(opts: ChatCompletionOpts): Promise<ChatCompletionResult> {
  const params = buildRequest(opts);
  const t0 = performance.now();

  let message: Anthropic.Message | null = null;
  let ttft: number | null = null;
  let attempts = 0;
  for (let attempt = 0; message === null; attempt++) {
    attempts = attempt + 1;
    ttft = null;
    const stream = getClient().messages.stream(params);
    // Idle watchdog: reset on every event; a silent stream is aborted.
    let stalled = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        stalled = true;
        stream.abort?.();
      }, streamIdleMs());
    };
    try {
      arm();
      for await (const ev of stream) {
        arm();
        if (ttft === null && (ev.type === 'content_block_start' || ev.type === 'content_block_delta')) {
          ttft = performance.now() - t0;
        }
      }
      message = await stream.finalMessage();
    } catch (e) {
      if (stalled) throw new AnthropicBackendError('stalled', `stream idle for ${streamIdleMs()}ms — aborted`);
      // With eager input streaming the SDK can fail to parse a tool input at
      // all; only that is re-issued. API errors (auth, rate limit…) propagate.
      if (e instanceof Anthropic.APIError || attempt >= JSON_RETRIES) {
        if (e instanceof Anthropic.APIError) throw e;
        throw new AnthropicBackendError('bad-tool-json', `tool input was not parseable JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      clearTimeout(idle);
    }
  }

  const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  // A tool input cut off at max_tokens can still parse as a valid partial
  // object — never hand it to the loop.
  const cutOff = message.stop_reason === 'max_tokens' || (message.stop_reason as string) === 'model_context_window_exceeded';
  if (cutOff && toolUses.length > 0) {
    throw new AnthropicBackendError('truncated', 'tool input truncated at max_tokens');
  }
  let text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  // A refusal with no text would otherwise reach Sai as a bare "OK.".
  if (message.stop_reason === 'refusal' && text === '') text = "I can't help with that one.";
  // A refusal can cut a tool_use off mid-input: run none of that turn's tools.
  const tool_calls: ToolCall[] | undefined =
    message.stop_reason === 'refusal' || toolUses.length === 0
      ? undefined
      : toolUses.map((b) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));

  const u = message.usage;
  const meta: ChatMeta = {
    backend: 'anthropic',
    model: message.model ?? params.model,
    tier: opts.tier ?? 'default',
    ttft_ms: ttft === null ? null : Math.round(ttft * 10) / 10,
    api_ms: null,
    input_tokens: num(u?.input_tokens),
    output_tokens: num(u?.output_tokens),
    cache_read_tokens: num(u?.cache_read_input_tokens) ?? 0,
    cache_write_tokens: num(u?.cache_creation_input_tokens) ?? 0,
    system_chars: (params.system as Anthropic.TextBlockParam[] | undefined)?.reduce((a, b) => a + b.text.length, 0) ?? 0,
    prompt_chars: opts.messages.slice(1).reduce((a, m) => a + (m.content?.length ?? 0), 0),
    stop_reason: message.stop_reason ?? null,
    ...(attempts > 1 ? { json_retries: attempts - 1 } : {}),
  };
  return { message: { content: text, tool_calls }, meta };
}

const ROUTE_LABELS = ['move', 'create', 'recurring', 'cancel', 'reminder', 'preference', 'workout', 'meals', 'internship', 'question', 'general'] as const;
const ROUTE_SYSTEM =
  'Classify a message sent to a personal calendar assistant. Reply with exactly one label, nothing else:\n' +
  'move (change when an existing block happens), create (add a new event), recurring (change which days/how often something repeats, or every block\'s length), ' +
  'cancel, reminder, preference (a standing rule: always/never/prefer), workout (gym split / lifts), meals (recipes, meal suites), ' +
  'internship (internship board / applications), question (asks about the schedule, changes nothing), general (anything else or several of these).';

/**
 * The router's fallback: one tiny call to the default model when the keyword
 * classifier can't place a message. ~200 input tokens, 3 output. Any failure
 * → null, and the turn simply gets the full prompt.
 */
export async function classifyIntent(message: string): Promise<(typeof ROUTE_LABELS)[number] | null> {
  const started = performance.now();
  try {
    const stream = getClient().messages.stream({
      model: anthropicModels().default,
      max_tokens: 5,
      system: ROUTE_SYSTEM,
      messages: [{ role: 'user', content: message.slice(0, 500) }],
    });
    const msg = await stream.finalMessage();
    const word = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, '');
    const label = (ROUTE_LABELS as readonly string[]).includes(word) ? (word as (typeof ROUTE_LABELS)[number]) : null;
    recordRound({
      round: -1,
      startedAt: started,
      tool_calls: 0,
      meta: {
        backend: 'anthropic',
        model: msg.model,
        purpose: 'route',
        input_tokens: num(msg.usage?.input_tokens),
        output_tokens: num(msg.usage?.output_tokens),
        cache_read_tokens: num(msg.usage?.cache_read_input_tokens) ?? 0,
        cache_write_tokens: num(msg.usage?.cache_creation_input_tokens) ?? 0,
      },
    });
    return label;
  } catch (e) {
    console.warn(`[chat] intent classification failed (${errorKind(e)}) — using the full prompt`);
    return null;
  }
}

function errorKind(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'auth';
  if (e instanceof Anthropic.PermissionDeniedError) return 'permission';
  if (e instanceof Anthropic.NotFoundError) return 'not-found';
  if (e instanceof Anthropic.RateLimitError) return 'rate-limit';
  if (e instanceof Anthropic.BadRequestError) return 'bad-request';
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (e instanceof Anthropic.APIConnectionError) return 'connection';
  if (e instanceof Anthropic.InternalServerError) return 'server-error';
  if (e instanceof Anthropic.APIError) return `api-${e.status ?? 'error'}`;
  if (e instanceof AnthropicBackendError) return e.kind;
  return 'unexpected';
}

/**
 * The production entry: the API, and on ANY failure (after the SDK's own
 * retries) warn with the error kind and answer the same call through the
 * claude CLI when it's installed, else Ollama — so agent.ts's
 * catch-and-apologize path fires only when every backend is down.
 */
/** Config failures don't fix themselves between calls: a revoked key or a
 *  mistyped model name turns the API off for a while instead of paying a
 *  failed request on every round. */
const CONFIG_KINDS = new Set(['auth', 'permission', 'not-found', 'bad-request']);
const DISABLE_MS = 5 * 60_000;
let disabledUntil = 0;
let disabledReason = '';

export async function anthropicWithFallback(opts: ChatCompletionOpts): Promise<ChatCompletionResult> {
  const next = fallbackImpl ?? (resolveClaudeBin() !== null ? claudeWithFallback : chatCompletion);
  if (Date.now() < disabledUntil) {
    const res = await next(opts);
    return { ...res, meta: { ...(res.meta ?? { backend: 'unknown', model: null }), fallback_from: 'anthropic', fallback_reason: `disabled (${disabledReason})` } };
  }
  try {
    return await anthropicChatCompletion(opts);
  } catch (e) {
    const kind = errorKind(e);
    if (CONFIG_KINDS.has(kind)) {
      disabledUntil = Date.now() + DISABLE_MS;
      disabledReason = kind;
      console.error(`[chat] Anthropic API ${kind} error — using the fallback backend for the next ${DISABLE_MS / 60_000} min. Check ANTHROPIC_API_KEY / MISE_ANTHROPIC_MODEL.`);
    }
    console.warn(`[chat] anthropic backend failed (${kind}): ${e instanceof Error ? e.message : String(e)} — falling back for this call`);
    const res = await next(opts);
    return {
      ...res,
      meta: {
        ...(res.meta ?? { backend: 'unknown', model: null }),
        fallback_from: 'anthropic',
        fallback_reason: res.meta?.fallback_from ? `${kind}; then ${res.meta.fallback_from} ${res.meta.fallback_reason}` : kind,
      },
    };
  }
}
