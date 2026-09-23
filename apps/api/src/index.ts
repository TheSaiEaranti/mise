/**
 * Server entry: `bun src/index.ts`. Binds 0.0.0.0:3001 — reachable from the
 * MacBook and iPhone over Tailscale, and from nowhere else (SPEC §1).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { activeChatBackend, anthropicModels, dbPath, resolveClaudeBin, warmAnthropicCache, warmupPrefixes } from '@mise/core';
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

// Warm the prompt cache so the first command after startup isn't cold. The
// cache lives 5 minutes, so a restart inside that window (bun --watch in dev)
// skips it — no point paying to re-write a prefix that's still cached.
// MISE_WARMUP=0 turns it off.
if (backend === 'anthropic' && process.env.MISE_WARMUP !== '0') {
  const stamp = join(dirname(dbPath() === ':memory:' ? join(tmpdir(), 'x') : dbPath()), '.mise-warmup');
  const last = (() => {
    try {
      return Number(readFileSync(stamp, 'utf8'));
    } catch {
      return 0;
    }
  })();
  if (Date.now() - last > 4.5 * 60_000) {
    const t0 = performance.now();
    warmAnthropicCache(warmupPrefixes())
      .then(({ written, read }) => {
        try {
          writeFileSync(stamp, String(Date.now()));
        } catch {
          // stamp is an optimization only
        }
        console.log(`[chat] prompt cache warmed in ${Math.round(performance.now() - t0)}ms (${written} tokens written, ${read} already cached)`);
      })
      .catch((e) => console.warn('[chat] cache warm-up failed:', e instanceof Error ? e.message : String(e)));
  } else {
    console.log('[chat] prompt cache still warm from the last start — skipping warm-up');
  }
}

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
