/**
 * Discord alerts for new internship listings — the internmaxx notifier,
 * webhook-shaped: after a sync lands genuinely-new active listings, post
 * them as embeds to the channel behind DISCORD_WEBHOOK_URL (.env; unset =
 * feature off, e.g. in tests).
 *
 * "Genuinely new" is a durable watermark, not a per-cycle diff: alerts.json
 * next to the DB file stores the first_seen high-water mark that has been
 * successfully posted. Post fails → watermark stays → the same listings
 * retry next cycle (never lost, never duplicated). No watermark file yet →
 * it initializes to now WITHOUT posting, so enabling alerts on an
 * already-seeded board (or a first 14k-row sync) never blasts the channel —
 * internmaxx's seeding rule.
 *
 * Discord limits: 10 embeds per message, ~30 messages/min per webhook. A
 * cycle posts at most MAX_ALERTS embeds across ≤3 messages with a breather
 * between them; anything beyond becomes one "+N more" line, and the
 * watermark still advances past it (overflow is summarized, not re-alerted).
 */
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { dbPath, getInternshipsFirstSeenAfter, type DB, type Internship } from '@mise/core';

const MAX_ALERTS = 25;
const EMBEDS_PER_MESSAGE = 10;
const MESSAGE_SPACING_MS = 500;
const EMBED_COLOR = 0xd9552a; // --signal, roughly: this IS a look-here-now channel

function watermarkPath(): string {
  return join(dirname(dbPath()), 'internship-alerts.json');
}

/** The webhook URL, from the environment or straight from <repo>/.env. The
 *  file fallback matters because the long-running dev process may predate
 *  .env — bun --watch reloads code, not necessarily the env — and alerts
 *  should arm without making Sai restart his dev server. */
export function webhookUrl(): string | null {
  // An explicitly-set empty var means OFF — don't fall through to the file.
  if ('DISCORD_WEBHOOK_URL' in process.env) return process.env.DISCORD_WEBHOOK_URL || null;
  try {
    // data/ sits at the repo root, next to .env.
    const env = readFileSync(join(dirname(dbPath()), '..', '.env'), 'utf8');
    const line = env.split('\n').find((l) => l.startsWith('DISCORD_WEBHOOK_URL='));
    const url = line?.slice('DISCORD_WEBHOOK_URL='.length).trim();
    return url || null;
  } catch {
    return null;
  }
}

export function readWatermark(): string | null {
  try {
    const raw = JSON.parse(readFileSync(watermarkPath(), 'utf8')) as { watermark?: unknown };
    return typeof raw.watermark === 'string' ? raw.watermark : null;
  } catch {
    return null;
  }
}

function writeWatermark(watermark: string): void {
  writeFileSync(watermarkPath(), `${JSON.stringify({ watermark })}\n`);
}

/** One listing → one Discord embed. Exported for tests. */
export function alertEmbed(i: Internship): Record<string, unknown> {
  const locs =
    i.locations.length > 2
      ? `${i.locations.slice(0, 2).join(' · ')} (+${i.locations.length - 2} more)`
      : i.locations.join(' · ');
  const line = [locs || 'location unlisted', i.terms.join(' · ') || null, i.category]
    .filter(Boolean)
    .join('  ·  ');
  return {
    title: `${i.company} — ${i.title}`.slice(0, 256),
    url: i.url,
    description: line.slice(0, 2048),
    color: EMBED_COLOR,
    timestamp: i.date_posted,
    footer: { text: `via ${i.source}` },
  };
}

/** Batch listings into webhook payloads (≤10 embeds each); the overflow count
 *  beyond MAX_ALERTS becomes a content line on the last message. Exported for
 *  tests. */
export function buildAlertPayloads(
  items: Internship[],
): Array<{ embeds: Record<string, unknown>[]; content?: string }> {
  const shown = items.slice(0, MAX_ALERTS);
  const overflow = items.length - shown.length;
  const payloads: Array<{ embeds: Record<string, unknown>[]; content?: string }> = [];
  for (let at = 0; at < shown.length; at += EMBEDS_PER_MESSAGE) {
    payloads.push({ embeds: shown.slice(at, at + EMBEDS_PER_MESSAGE).map(alertEmbed) });
  }
  if (overflow > 0 && payloads.length > 0) {
    payloads[payloads.length - 1]!.content =
      `…and ${overflow} more new role${overflow === 1 ? '' : 's'} — open the Internships tab.`;
  }
  return payloads;
}

async function post(url: string, payload: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  // 204 on success; 429 carries retry_after but we just fail the cycle — the
  // watermark holds and the next tick retries.
  if (!res.ok) throw new Error(`Discord webhook HTTP ${res.status}`);
}

/** Alert on everything first seen since the watermark. Returns what happened
 *  for the poller's log line. */
export async function notifyNewInternships(
  db: DB,
): Promise<{ posted: number; overflow: number } | 'disabled' | 'seeded'> {
  const url = webhookUrl();
  if (!url) return 'disabled';

  const watermark = readWatermark();
  if (watermark === null) {
    // First run with alerts on: draw the line at "now", alert only deltas
    // after this — never the seeded backlog.
    writeWatermark(new Date().toISOString());
    return 'seeded';
  }

  const fresh = getInternshipsFirstSeenAfter(db, watermark);
  if (fresh.length === 0) return { posted: 0, overflow: 0 };

  const payloads = buildAlertPayloads(fresh);
  for (let p = 0; p < payloads.length; p++) {
    if (p > 0) await new Promise((r) => setTimeout(r, MESSAGE_SPACING_MS));
    await post(url, payloads[p]!); // a throw leaves the watermark for retry
  }
  writeWatermark(fresh.reduce((hi, i) => (i.first_seen > hi ? i.first_seen : hi), watermark));
  const posted = Math.min(fresh.length, MAX_ALERTS);
  return { posted, overflow: fresh.length - posted };
}
