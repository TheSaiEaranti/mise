/**
 * Background internship-board sync — every 3 minutes while the API runs, so
 * new postings land without anyone opening the tab (SPEC-adjacent to
 * internmaxx's tier-1 cadence).
 *
 * Cheap by construction: each idle cycle is one conditional commits-API call
 * per source, and the stored ETag turns "nothing changed" into a 304 that
 * GitHub does not count against the unauthenticated rate limit. A real
 * download only happens when the upstream repo actually committed — for
 * simplify that's about once an hour, so ~19 of every 20 cycles are free.
 *
 * Started from index.ts (the server entry), NOT app.ts — tests import app.ts
 * and must never inherit a live timer.
 */
import { getDb, syncInternships } from '@mise/core';
import { notifyNewInternships } from './internship-alerts';

const EVERY_MS = Number(process.env.INTERNSHIP_SYNC_MS ?? 3 * 60 * 1000);
/** First tick waits out server boot (migrations, first requests). */
const BOOT_DELAY_MS = Math.min(15_000, EVERY_MS);

let inFlight = false;

async function tick(): Promise<void> {
  if (inFlight) return; // a slow download outlasting the interval must not stack
  inFlight = true;
  try {
    const report = await syncInternships(getDb());
    const fresh = report.sources.filter((s) => !s.skipped && !s.error && s.fetched > 0);
    if (fresh.length > 0) {
      console.log(
        `[internships] board updated: ${fresh
          .map((s) => `${s.source} +${s.inserted} new / ${s.updated} refreshed`)
          .join(', ')}`,
      );
    }
    const failed = report.sources.filter((s) => s.error);
    if (failed.length > 0) {
      console.warn(
        `[internships] sync errors: ${failed.map((s) => `${s.source}: ${s.error}`).join('; ')}`,
      );
    }
    // Discord alerts ride the same tick; a webhook failure must never take
    // the sync loop down with it.
    try {
      const alerted = await notifyNewInternships(getDb());
      if (alerted === 'seeded') {
        console.log('[internships] Discord alerts armed — new listings from now on');
      } else if (typeof alerted === 'object' && alerted.posted > 0) {
        console.log(
          `[internships] Discord: alerted ${alerted.posted} new role(s)` +
            (alerted.overflow > 0 ? ` (+${alerted.overflow} summarized)` : ''),
        );
      }
    } catch (e) {
      console.warn('[internships] Discord alert failed (will retry next cycle)', e);
    }
  } catch (e) {
    console.warn('[internships] background sync failed', e);
  } finally {
    inFlight = false;
  }
}

export function startInternshipPoller(): void {
  setTimeout(() => void tick(), BOOT_DELAY_MS);
  setInterval(() => void tick(), EVERY_MS);
}
