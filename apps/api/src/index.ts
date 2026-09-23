/**
 * Server entry: `bun src/index.ts`. Binds 0.0.0.0:3001 — reachable from the
 * MacBook and iPhone over Tailscale, and from nowhere else (SPEC §1).
 */
import { activeChatBackend, anthropicModels, resolveClaudeBin } from '@mise/core';
import { app } from './app';
import { startInternshipPoller } from './lib/internship-poller';

startInternshipPoller();

// Which model answers chat turns. Resolved per-turn too — this is just the
// startup receipt (backend can flip via MISE_CHAT_BACKEND without a restart).
const backend = activeChatBackend();
const models = anthropicModels();
console.log(
  backend === 'anthropic'
    ? `[chat] backend: Anthropic API (${models.default}, escalates to ${models.escalated}), CLI/Ollama fallback`
    : backend === 'claude'
      ? `[chat] backend: claude CLI (${resolveClaudeBin()}), Ollama fallback`
      : '[chat] backend: ollama',
);

export default {
  port: Number(process.env.PORT ?? 3001),
  hostname: '0.0.0.0',
  fetch: app.fetch,
  // Bun aborts a request that runs past this, and a chat turn is a chain of
  // local-model round-trips: "friends over 6-7, adjust my gym" books the event,
  // then plans the gym move against the calendar that now contains it. At 120s
  // Bun was cutting those turns off mid-thought and the UI reported "can't reach
  // Ollama" for a model that was answering fine. 255 is Bun's maximum.
  idleTimeout: 255,
};
