/**
 * The single low-level Ollama HTTP client. Used by recipe import and the
 * agent loop. Talks to Ollama's OpenAI-compatible endpoint (SPEC §2) so the
 * tool-calling code stays portable.
 */

export const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
export const MODEL = process.env.MISE_MODEL ?? 'qwen3:30b-a3b';
/** Vision model, used only to read a photo of a class schedule. */
export const VISION_MODEL = process.env.MISE_VISION_MODEL ?? 'qwen2.5vl:7b';

/**
 * How long ONE model round-trip may take before we call it stuck.
 *
 * A turn can now be several round-trips (create the event, then move the gym),
 * and a cold 8B load on this machine is ~30s on its own, so this is per-call and
 * generous. It exists to stop an infinite hang, not to police slowness.
 */
const CHAT_TIMEOUT_MS = Number(process.env.MISE_CHAT_TIMEOUT_MS ?? 300_000);

/** Abort errors arrive as DOMException, which is NOT `instanceof Error` in Bun
 *  — checking the name is the only reliable test. */
function isTimeout(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}
/** Reading a photo is slower than a chat turn. */
const VISION_TIMEOUT_MS = Number(process.env.MISE_VISION_TIMEOUT_MS ?? 300_000);

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ChatCompletionResult {
  message: { content: string | null; tool_calls?: ToolCall[] };
}

/** qwen3 prepends a <think>…</think> block; callers never want it. */
function stripThink(content: string | null): string | null {
  if (content == null) return null;
  return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Parse every <tool_call>{"name":...,"arguments":{...}}</tool_call> block out
 * of model text. Shared by two backends: the compact/fine-tuned qwen path
 * (trained to emit the literal string) and the Claude CLI backend (whose whole
 * tool protocol is this text). Returns the extracted calls plus the text with
 * the parsed blocks removed; a block whose JSON doesn't parse or has no name
 * is left in the text untouched. Ids are positional (tc0, tc1, …) — the agent
 * loop caps calls per round itself.
 */
export function parseToolCallText(raw: string): { text: string; tool_calls?: ToolCall[] } {
  const calls: ToolCall[] = [];
  const text = raw
    .replace(/<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/g, (full, json: string) => {
      try {
        const o = JSON.parse(json) as { name?: string; arguments?: unknown };
        if (typeof o.name === 'string' && o.name !== '') {
          calls.push({
            id: `tc${calls.length}`,
            type: 'function',
            function: {
              name: o.name,
              arguments: typeof o.arguments === 'string' ? o.arguments : JSON.stringify(o.arguments ?? {}),
            },
          });
          return '';
        }
      } catch {
        // fall through — leave the malformed block in the text
      }
      return full;
    })
    .trim();
  return { text, tool_calls: calls.length > 0 ? calls : undefined };
}

/**
 * Vision call against Ollama's NATIVE /api/chat (not the OpenAI-compatible
 * route): images ride as base64 strings on the message, and `format` takes a
 * JSON Schema so the model is forced to return parseable structured output.
 * Used only by schedule-import.ts — the model reads pixels, it never writes.
 */
export async function visionCompletion(opts: {
  prompt: string;
  /** Raw base64 (no data: prefix). */
  imagesB64: string[];
  /** JSON Schema the response must conform to. */
  format?: unknown;
  system?: string;
}): Promise<string> {
  const url = `${OLLAMA_URL}/api/chat`;
  const messages = [
    ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
    { role: 'user', content: opts.prompt, images: opts.imagesB64 },
  ];
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages,
        stream: false,
        format: opts.format,
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isTimeout(e)) {
      throw new Error(
        `${VISION_MODEL} didn't finish reading that image within ${Math.round(VISION_TIMEOUT_MS / 1000)}s. ` +
          `Try a smaller photo, or add the classes by hand.`,
      );
    }
    throw new Error(
      `Cannot reach Ollama at ${url}: ${msg}. Is Ollama running? ` +
        `The photo import needs the vision model: ollama pull ${VISION_MODEL}`,
    );
  }
  if (res.status === 404) {
    throw new Error(`Vision model "${VISION_MODEL}" is not installed. Run: ollama pull ${VISION_MODEL}`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 500);
    throw new Error(`Ollama returned ${res.status} from ${url}: ${body}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  const content = stripThink(data.message?.content ?? null);
  if (!content) throw new Error('The vision model returned nothing for that image.');
  return content;
}

export async function chatCompletion(opts: {
  messages: ChatMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
}): Promise<ChatCompletionResult> {
  const url = `${OLLAMA_URL}/v1/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // keep_alive holds the model in memory between turns so an interactive
      // back-and-forth never pays the ~30s cold-load again mid-conversation.
      body: JSON.stringify({ model: MODEL, keep_alive: '30m', ...opts }),
      // Ollama can wedge — swapping a model in, a bad load — and an un-timed
      // fetch waits forever, so the chat request never returns and the UI just
      // spins. Fail loudly instead: a turn that takes longer than this is
      // broken, not slow. (A cold model load is ~30s; 3 min is generous.)
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = String((e as { code?: unknown })?.code ?? '');
    if (isTimeout(e)) {
      throw new Error(
        `The local model didn't answer within ${Math.round(CHAT_TIMEOUT_MS / 1000)}s. ` +
          `It may be loading or stuck — check "ollama ps", then try again.`,
      );
    }
    const refused = /refused|ECONNREFUSED|fetch failed|unable to connect/i.test(`${msg} ${code}`);
    throw new Error(
      `Cannot reach Ollama at ${url}: ${msg}${
        refused ? '. Is Ollama running? Run scripts/setup.sh to install it and pull the model.' : ''
      }`,
    );
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 500);
    throw new Error(`Ollama returned ${res.status} ${res.statusText} from ${url}: ${body}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
  };
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error(`Ollama response from ${url} had no choices`);
  // The fine-tuned (compact) model is trained to emit the literal qwen3 tool-call
  // string in its content rather than a structured tool_calls field — training on
  // the exact text sidesteps chat-template rendering quirks. If the server didn't
  // parse it into tool_calls, pull it out of the content ourselves (shared with
  // the Claude CLI backend, which always speaks this text protocol).
  let tool_calls = message.tool_calls;
  const raw = message.content ?? '';
  if ((!tool_calls || tool_calls.length === 0) && raw.includes('<tool_call>')) {
    tool_calls = parseToolCallText(raw).tool_calls;
  }
  return { message: { content: stripThink(raw), tool_calls } };
}
