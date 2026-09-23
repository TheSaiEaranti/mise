/**
 * Claude CLI chat backend. Same message-in / assistant-message-out shape as
 * ollama.ts's chatCompletion, so runAgentTurn's loop, proposal spine, undo and
 * describeOutcome are untouched — this is a model swap, not an agent-loop swap.
 *
 * It shells out to the `claude` binary in headless print mode (`claude -p
 * --output-format json`), riding Sai's subscription login — no API key. Tool
 * calling uses the same text protocol the compact/fine-tune path already
 * speaks (<tool_call>{"name":...,"arguments":{...}}</tool_call>), parsed by
 * the shared parser in ollama.ts, with the tool JSON schemas rendered into the
 * system prompt here (they arrive via opts.tools, so agent.ts needs no prompt
 * edit).
 *
 * Empirical notes from probing v2.1.226 (do not "fix" these without re-probing):
 * - `--tools ""` disables ALL built-in tools — pure text turns, no permission
 *   flags needed.
 * - stdin must carry data and close, or every call stalls 3s waiting on it.
 * - `--bare` / `--setting-sources ""` BREAK subscription auth ("Not logged in")
 *   — never add them.
 * - Errors are classified from the parsed JSON's `is_error`, not the exit code
 *   (exit status on error was not confirmed non-zero).
 * - `--resume <session_id>` carries context server-side but re-uploads the
 *   prompt cache anyway (cache_read was 0) — kept for correctness, not tokens;
 *   `--system-prompt` is re-passed on resume because its persistence across
 *   resume is unverified (harmless if redundant).
 */
import { existsSync } from 'node:fs';
import { chatCompletion, parseToolCallText, type ChatCompletionResult, type ChatMessage } from './ollama';

/** Why a CLI call failed — the fallback log names this. */
export type ClaudeErrorKind =
  | 'not-installed'
  | 'spawn-error'
  | 'not-authed'
  | 'timeout'
  | 'malformed-output'
  | 'api-error';

export class ClaudeCliError extends Error {
  constructor(
    public readonly kind: ClaudeErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ClaudeCliError';
  }
}

/** Per-invocation wall clock. A sonnet turn is ~2.5s; 120s means "wedged".
 *  Invalid values (empty, "2m", negative) fall back to the default — a bad
 *  env var must not become setTimeout(0) killing every call instantly. */
function timeoutMs(): number {
  const raw = process.env.MISE_CLAUDE_TIMEOUT_MS;
  if (raw === undefined) return 120_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

function model(): string {
  return process.env.MISE_CLAUDE_MODEL ?? 'sonnet';
}

/**
 * Locate the claude binary. MISE_CLAUDE_BIN, when set, is honored VERBATIM —
 * no existence check and no falling through — so pointing it at a dead path
 * deliberately forces the not-installed → Ollama fallback (the kill switch the
 * spec's fallback test uses). Otherwise PATH, then the native-installer home
 * (~/.local/bin/claude — the nvm glob in the original spec was wrong for this
 * machine). Null means "no claude here": dispatch goes straight to Ollama.
 */
export function resolveClaudeBin(): string | null {
  const override = process.env.MISE_CLAUDE_BIN;
  if (override) return override;
  // PATH passed explicitly: Bun.which snapshots the process env otherwise,
  // which makes the lookup blind to runtime PATH changes (and untestable).
  const onPath = Bun.which('claude', { PATH: process.env.PATH ?? '' });
  if (onPath) return onPath;
  const home = process.env.HOME;
  if (home) {
    const local = `${home}/.local/bin/claude`;
    if (existsSync(local)) return local;
  }
  return null;
}

let warnedNoBinary = false;
let warnedBadBackendValue = false;

/**
 * Which backend a turn will use right now. Claude is the default; Ollama when
 * MISE_CHAT_BACKEND=ollama or no binary resolves. Re-evaluated every turn so
 * flipping the env var (or installing the CLI) needs no restart.
 */
export function activeChatBackend(): 'claude' | 'ollama' {
  const wanted = (process.env.MISE_CHAT_BACKEND ?? '').trim().toLowerCase();
  if (wanted === 'ollama') return 'ollama';
  if (wanted !== '' && wanted !== 'claude' && !warnedBadBackendValue) {
    // A typo like "olama" silently burning plan usage is the failure mode here.
    warnedBadBackendValue = true;
    console.warn(`[chat] MISE_CHAT_BACKEND="${process.env.MISE_CHAT_BACKEND}" not recognized (claude|ollama) — defaulting to claude`);
  }
  if (resolveClaudeBin() !== null) return 'claude';
  if (!warnedNoBinary) {
    warnedNoBinary = true;
    console.warn('[chat] claude CLI not found (PATH, ~/.local/bin, MISE_CLAUDE_BIN) — using the Ollama backend');
  }
  return 'ollama';
}

// ---------------------------------------------------------------------------
// Spawn seam — bun tests must never run the real CLI (burns Sai's plan usage)
// ---------------------------------------------------------------------------

export interface ClaudeSpawnLike {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  /** Bun's Subprocess.kill accepts an optional signal; mocks may ignore it. */
  kill(signal?: number | NodeJS.Signals): void;
}

export interface ClaudeSpawnOpts {
  cmd: string[];
  env: Record<string, string>;
  /** Prompt bytes; Bun writes them to stdin and CLOSES it (see header note). */
  stdin: Uint8Array;
  stdout: 'pipe';
  stderr: 'pipe';
}

export type ClaudeSpawnFn = (opts: ClaudeSpawnOpts) => ClaudeSpawnLike;

const realSpawn: ClaudeSpawnFn = (o) => Bun.spawn(o) as unknown as ClaudeSpawnLike;

let spawnImpl: ClaudeSpawnFn = realSpawn;
let fallbackImpl: typeof chatCompletion = chatCompletion;

/** Test seam. Call with no argument to restore the real spawn + Ollama. */
export function __setClaudeCliTestOverrides(
  o: { spawn?: ClaudeSpawnFn | null; fallback?: typeof chatCompletion | null } = {},
): void {
  spawnImpl = o.spawn ?? realSpawn;
  fallbackImpl = o.fallback ?? chatCompletion;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * The tool-call format instruction + the JSON schemas, appended to the system
 * prompt. Mirrors COMPACT_SYSTEM's (A)/(B) shape — the wording the probe
 * verified end-to-end (sonnet emitted exactly one well-formed <tool_call> with
 * correct date math and nothing else).
 */
function toolProtocolBlock(tools: unknown[]): string {
  const specs = tools
    .map((t) => {
      const fn = (t as { function?: unknown })?.function;
      return `- ${JSON.stringify(fn ?? t)}`;
    })
    .join('\n');
  return [
    'HOW TO ACT — respond in ONE of exactly two ways:',
    '(A) one or more tool calls, each on its own line, formatted EXACTLY like this and nothing else on the line (real JSON inside):',
    '<tool_call>{"name": "set_reminder", "arguments": {"date": "2026-08-08", "time": "09:00", "title": "Call mom"}}</tool_call>',
    '(B) or, if nothing should change (a question you can answer from the SCHEDULE, ambiguity, small talk), a short plain reply with NO <tool_call> block.',
    'Only the <tool_call>{...}</tool_call> form acts — never write a call as function(args) text or inside a code fence. After each call its result comes back as a "Tool result:" message; use it to decide your next call or your answer.',
    '',
    'Available tools (JSON Schemas):',
    specs,
  ].join('\n');
}

/** System text for the CLI: agent.ts's system message minus the qwen3-only
 *  `/no_think` switch, plus the tool protocol when tools were passed. */
function buildSystemPrompt(messages: ChatMessage[], tools: unknown[] | undefined): string {
  const sys = messages[0]?.role === 'system' ? messages[0].content : '';
  let out = sys.replace(/\s*\/no_think\s*$/, '').trimEnd();
  if (tools && tools.length > 0) out += '\n\n' + toolProtocolBlock(tools);
  return out;
}

/** One ChatMessage as transcript text for the prompt. */
function renderMessage(m: ChatMessage): string {
  if (m.role === 'user') return `User: ${m.content}`;
  if (m.role === 'tool') return `Tool result: ${m.content}`;
  if (m.role === 'assistant') {
    const calls = (m.tool_calls ?? []).map((tc) => {
      let args: unknown = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = tc.function.arguments;
      }
      return `<tool_call>${JSON.stringify({ name: tc.function.name, arguments: args })}</tool_call>`;
    });
    const parts = [m.content, ...calls].filter((p) => p && p.trim() !== '');
    return `Assistant: ${parts.join('\n')}`;
  }
  return m.content; // stray system message — pass through verbatim
}

/**
 * Session continuation within one agent turn, keyed on ARRAY IDENTITY:
 * runAgentTurn builds one `messages` array and mutates it across rounds, so
 * the array object itself identifies the turn. First round sends the whole
 * history+user transcript and remembers the CLI session id; later rounds
 * `--resume` and send only what was appended since (the tool results).
 * WeakMap so finished turns are collected with their arrays.
 */
const turnSessions = new WeakMap<ChatMessage[], { sessionId: string; sentCount: number }>();

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

/** Child env: inherit (PATH/HOME needed for the keychain-backed login) but
 *  strip CLAUDE- and ANTHROPIC-prefixed vars so nested-session state can't
 *  skew the call. (MISE_CLAUDE_* keys survive — different prefix.) */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(CLAUDE|ANTHROPIC)/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

interface ClaudeResultJson {
  type?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
}

/** stdout should be a single JSON object; tolerate stray warning lines. */
function parseClaudeStdout(stdout: string): ClaudeResultJson | null {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as ClaudeResultJson;
  } catch {
    for (const line of trimmed.split('\n')) {
      const l = line.trim();
      if (!l.startsWith('{')) continue;
      try {
        const o = JSON.parse(l) as ClaudeResultJson;
        if (o.type === 'result') return o;
      } catch {
        // keep scanning
      }
    }
    return null;
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function invokeClaude(bin: string, system: string, prompt: string, resumeId?: string): Promise<ClaudeResultJson> {
  // Accepted trade-off: --system-prompt rides argv, so the schedule context is
  // ps-visible for the seconds each call runs. Single-user Mac; the CLI has no
  // verified file/stdin channel for the system prompt, and embedding it in the
  // user prompt would demote its instruction authority. Revisit if the CLI
  // grows a --system-prompt-file flag.
  const cmd = [bin, '-p', '--output-format', 'json', '--model', model(), '--tools', '', '--system-prompt', system];
  if (resumeId) cmd.push('--resume', resumeId);

  let proc: ClaudeSpawnLike;
  try {
    proc = spawnImpl({
      cmd,
      env: cleanEnv(),
      stdin: new TextEncoder().encode(prompt),
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (e) {
    const code = String((e as { code?: unknown })?.code ?? '');
    const msg = errText(e);
    if (code === 'ENOENT' || /ENOENT|no such file/i.test(`${code} ${msg}`)) {
      throw new ClaudeCliError('not-installed', `claude binary not runnable at ${bin}: ${msg}`);
    }
    // EACCES/EPERM/resource exhaustion are NOT "not installed" — a wrong label
    // sends the operator chasing an install that's already there.
    throw new ClaudeCliError('spawn-error', `could not spawn ${bin}: ${msg}`);
  }

  const limit = timeoutMs();
  let exited = false;
  void proc.exited.then(
    () => (exited = true),
    () => (exited = true),
  );
  let timedOut = false;
  // Soft deadline: SIGTERM. A process that already exited must not be branded
  // timed-out by a timer firing in the same tick (the salvage below also
  // covers the race where full output arrived right at the wire).
  const termTimer = setTimeout(() => {
    if (exited) return;
    timedOut = true;
    proc.kill();
  }, limit);
  // Escalation: a CLI wedged in its SIGTERM cleanup gets SIGKILL.
  const killTimer = setTimeout(() => {
    if (!exited) proc.kill('SIGKILL');
  }, limit + 5_000);

  let stdout = '';
  let stderr = '';
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The stream reads themselves must be bounded: a grandchild that inherits
    // the pipe fds keeps them open past the parent's death, and an unbounded
    // await here would hang the turn forever.
    const io = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(
      ([o, e]) => {
        stdout = o;
        stderr = e;
      },
    );
    const hardDeadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new ClaudeCliError('timeout', `claude CLI unresponsive ${Math.round(limit / 1000)}s past deadline — abandoned`)),
        limit + 10_000,
      );
    });
    await Promise.race([io.then(() => proc.exited), hardDeadline]);
  } finally {
    clearTimeout(termTimer);
    clearTimeout(killTimer);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    // The only guarantee that NO exit path (stream-read throw included) leaves
    // an orphaned claude burning plan usage in the background. Guarded: kill
    // semantics on an already-dead process vary by runtime/mocks, and a throw
    // here would mask the real error.
    if (!exited) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }

  if (timedOut) {
    // Salvage: if a complete, successful result landed before the kill took
    // effect, the timer firing is bookkeeping, not failure.
    const salvaged = parseClaudeStdout(stdout);
    if (!(salvaged !== null && salvaged.type === 'result' && salvaged.is_error !== true)) {
      throw new ClaudeCliError('timeout', `claude CLI did not finish within ${Math.round(limit / 1000)}s — killed`);
    }
  }

  const parsed = parseClaudeStdout(stdout);
  if (parsed === null || parsed.type !== 'result') {
    const detail = (stderr || stdout).trim().slice(0, 300);
    throw new ClaudeCliError('malformed-output', `claude CLI emitted no result JSON: ${detail || '(empty output)'}`);
  }

  if (parsed.is_error === true) {
    const msg = typeof parsed.result === 'string' ? parsed.result : 'unknown CLI error';
    if (/not logged in|\/login/i.test(msg)) {
      throw new ClaudeCliError('not-authed', `claude CLI is not logged in: ${msg}`);
    }
    throw new ClaudeCliError('api-error', `claude CLI call failed: ${msg}`);
  }

  return parsed;
}

/**
 * Drop-in for ollama.ts's chatCompletion (same opts, same result shape).
 * temperature/max_tokens are accepted but ignored — the CLI exposes no knobs
 * for them, and the agent's 0.1 setting is a qwen taming measure anyway.
 * Throws ClaudeCliError (see taxonomy) — callers wanting a guaranteed answer
 * go through claudeWithFallback.
 */
export async function claudeChatCompletion(opts: {
  messages: ChatMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
}): Promise<ChatCompletionResult> {
  const bin = resolveClaudeBin();
  if (bin === null) {
    throw new ClaudeCliError('not-installed', 'no claude binary found (PATH, ~/.local/bin/claude, MISE_CLAUDE_BIN)');
  }

  const system = buildSystemPrompt(opts.messages, opts.tools);
  const session = turnSessions.get(opts.messages);

  let prompt: string;
  if (session === undefined) {
    // First round of this turn: the whole transcript after the system message.
    prompt = opts.messages.slice(1).map(renderMessage).join('\n\n');
  } else {
    // Resume: only what the agent loop appended since the last call. Assistant
    // entries are skipped — the session already holds Claude's own replies.
    // (Edge case knowingly accepted: if Claude failed mid-turn and Ollama
    // answered a round, that assistant text is skipped too; the tool results
    // that follow it carry what actually happened.)
    prompt = opts.messages
      .slice(session.sentCount)
      .filter((m) => m.role !== 'assistant')
      .map(renderMessage)
      .join('\n\n');
  }
  if (prompt.trim() === '') prompt = '(continue)';

  let parsed: ClaudeResultJson;
  try {
    parsed = await invokeClaude(bin, system, prompt, session?.sessionId);
  } catch (e) {
    // A failed call poisons the cached session: a dead --resume id would make
    // every remaining round of this turn fail the same way, and a session that
    // died mid-mutation must not be resumed into a re-issue. Fresh start next
    // round (full transcript replay) instead.
    turnSessions.delete(opts.messages);
    throw e;
  }

  const sid = typeof parsed.session_id === 'string' && parsed.session_id !== '' ? parsed.session_id : session?.sessionId;
  if (sid !== undefined) {
    // sentCount = the array length NOW: the agent loop appends its assistant
    // echo + tool results after we return, and those are exactly what the next
    // resume must send.
    turnSessions.set(opts.messages, { sessionId: sid, sentCount: opts.messages.length });
  }

  const raw = typeof parsed.result === 'string' ? parsed.result : '';
  const { text, tool_calls } = parseToolCallText(raw);

  // parseToolCallText leaves a block whose JSON doesn't parse IN the text. On
  // this backend that text is the final reply when no calls parsed — raw
  // <tool_call> markup would reach Sai's chat and the schema-retry spine would
  // never engage. Synthesize a call carrying the unparsed body instead: the
  // agent loop's JSON.parse fails and sends the model a correction message.
  if (text.includes('<tool_call>')) {
    const salvaged = [...(tool_calls ?? [])];
    let residual = text;
    residual = residual.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_full, body: string) => {
      const nameMatch = /"name"\s*:\s*"([A-Za-z0-9_]+)"/.exec(body);
      salvaged.push({
        id: `tc${salvaged.length}`,
        type: 'function',
        function: { name: nameMatch?.[1] ?? 'unparseable_tool_call', arguments: body },
      });
      return '';
    });
    return {
      message: {
        content: residual.trim(),
        tool_calls: salvaged.length > 0 ? salvaged : undefined,
      },
    };
  }

  return { message: { content: text, tool_calls } };
}

/**
 * The production entry: try Claude, and on ANY failure warn (naming the
 * taxonomy kind) and run the same call through Ollama — so agent.ts's
 * catch-and-apologize path fires only when BOTH backends are down, exactly as
 * before this backend existed.
 */
export async function claudeWithFallback(opts: {
  messages: ChatMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
}): Promise<ChatCompletionResult> {
  try {
    return await claudeChatCompletion(opts);
  } catch (e) {
    const kind = e instanceof ClaudeCliError ? e.kind : 'unexpected';
    console.warn(`[chat] claude backend failed (${kind}): ${errText(e)} — falling back to Ollama for this call`);
    return fallbackImpl(opts);
  }
}
