/**
 * Capture 1920×1080 stills of the app for docs (demo-assets/).
 * Needs the API (frozen clock, freshly seeded demo semester) and the DEV web
 * server on :3000 — the latency panel only exists outside production.
 *
 *   MISE_NOW=2026-09-23T10:00 MISE_DB_PATH=<db> bun run scripts/seed-demo.ts
 *   MISE_NOW=2026-09-23T10:00 MISE_DB_PATH=<db> bun apps/api/src/index.ts
 *   bun run dev:web
 *   bun run scripts/capture-assets.ts --out demo-assets
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const i = argv.indexOf('--out');
const OUT = resolve(i >= 0 ? argv[i + 1]! : 'demo-assets');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, timezoneId: 'America/Chicago' });
await page.clock.setFixedTime(new Date('2026-09-23T10:00:00-05:00'));
await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.screenshot({ path: join(OUT, '01-week-view.png') });

const input = page.locator('input[aria-label="Ask Mise"]:visible').first();
await input.click();
await input.fill('friends are coming over at 5 tonight for two hours');
await page.keyboard.press('Enter');
// The status line streams while the turn works.
await page.locator('[aria-live="polite"] span.t-body').first().waitFor({ state: 'visible', timeout: 10_000 });
await page.screenshot({ path: join(OUT, '02-chat-progress.png') });
await page.waitForFunction(() => {
  const el = [...document.querySelectorAll<HTMLInputElement>('input[aria-label="Ask Mise"]')].find((e) => e.offsetParent !== null);
  return el !== undefined && !el.disabled;
}, undefined, { timeout: 30_000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: join(OUT, '03-chat-receipt.png') });

// The diff card, up close (same frame, cropped to the chat rail).
const rail = await page.locator('[data-flip-key]').first().evaluate(() => null).then(() => ({ x: 1520, y: 0, width: 400, height: 1080 }));
await page.screenshot({ path: join(OUT, '04-diff-card.png'), clip: rail });

// The dev latency panel (Ctrl+Shift+L), showing the turn just run.
await page.mouse.click(700, 150);
await page.keyboard.press('Control+Shift+L');
await page.waitForTimeout(2500);
await page.screenshot({ path: join(OUT, '07-dev-timing-panel.png') });

await browser.close();
console.log(`stills → ${OUT}`);
