/**
 * Record the DEMO.md script as a backup video (Playwright, system Chrome,
 * 1920×1080, a visible cursor dot, no dev UI on screen).
 *
 *   bun run seed:demo && bun run dev:demo      # in another terminal (or prod web)
 *   bun run record:demo [--out demo.webm] [--frames dir]
 *
 * Then convert for sharing (H.264, plays everywhere):
 *   ffmpeg -i demo.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart demo.mp4
 *
 * The page is driven like a person would: type each command, wait for the
 * answer, pause so the viewer can see the calendar change.
 */
import { mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { addDaysWall, todayInTz } from '../packages/core/src/time';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1]! : d;
};
const OUT = resolve(opt('--out', 'demo.webm'));
const FRAMES = resolve(opt('--frames', join(dirname(OUT), 'demo-frames')));
const URL = opt('--url', 'http://localhost:3000/');
const W = 1920;
const H = 1080;
const TODAY = todayInTz();
const TOMORROW = addDaysWall(TODAY, 1);
/** The block for `title` on `date` (event-block's data-flip-key is "title|YYYY-MM-DDTHH:mm"). */
const block = (title: string, date: string) => `[data-flip-key^="${title}"][data-flip-key*="|${date}T"]`;

// A cursor the viewer can follow — headless Chrome draws none.
const CURSOR = `
  addEventListener('DOMContentLoaded', () => {
    const d = document.createElement('div');
    d.setAttribute('aria-hidden', 'true');
    Object.assign(d.style, {
      position: 'fixed', left: '0', top: '0', width: '22px', height: '22px',
      margin: '-11px 0 0 -11px', borderRadius: '50%', background: 'rgba(22,24,29,0.78)',
      boxShadow: '0 0 0 3px rgba(255,255,255,0.95), 0 2px 8px rgba(0,0,0,0.25)',
      zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-200px,-200px)',
      transition: 'scale 120ms ease',
    });
    document.body.appendChild(d);
    addEventListener('mousemove', (e) => { d.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)'; }, true);
    addEventListener('mousedown', () => { d.style.scale = '0.75'; }, true);
    addEventListener('mouseup', () => { d.style.scale = '1'; }, true);
  });
`;

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

/** Glide the cursor to an element's centre, the way a hand would. */
async function glide(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`not on screen: ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
}

const INPUT = 'input[aria-label="Ask Mise"]:visible';

async function ask(page: Page, text: string): Promise<void> {
  await glide(page, INPUT);
  await page.locator(INPUT).first().click();
  await page.locator(INPUT).first().pressSequentially(text, { delay: 70 });
  await pause(page, 350);
  await page.keyboard.press('Enter');
  // The input is disabled while the turn runs; it comes back with the answer.
  await page.waitForFunction((sel) => {
    const el = [...document.querySelectorAll<HTMLInputElement>(sel.replace(':visible', ''))].find((e) => e.offsetParent !== null);
    return el !== undefined && !el.disabled;
  }, INPUT, { timeout: 30_000 });
}

async function frame(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(FRAMES, `${name}.png`) });
}

mkdirSync(FRAMES, { recursive: true });
const videoDir = join(dirname(OUT), '.demo-video-tmp');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: videoDir, size: { width: W, height: H } },
});
await context.addInitScript(CURSOR);
const page = await context.newPage();
const t0 = Date.now();

await page.goto(URL, { waitUntil: 'networkidle' });
await page.mouse.move(W * 0.4, H * 0.45, { steps: 20 });
await pause(page, 6500);

// 1. A simple move — today's gym slides to 6pm.
await ask(page, 'move my gym block to 6pm');
await pause(page, 900);
await glide(page, `[data-flip-key="Gym|${TODAY}T18:00"]`);
await pause(page, 5200);
await frame(page, '1-move');

// 2. A bulk shift — tomorrow's pinned class after 3pm must stay put.
await ask(page, 'shift everything after 3pm tomorrow back an hour');
await pause(page, 1500);
await glide(page, block('ECO 304K', TOMORROW));
await pause(page, 5500);
await frame(page, '2-shift-pinned-stays');

// 3. A recurring change — every Friday loses its gym.
await ask(page, 'no gym on Fridays');
await pause(page, 1200);
await glide(page, 'text=/^fri$/i');
await pause(page, 5500);
await frame(page, '3-no-gym-fridays');

// 4. A cancel — it asks first, and only the tap deletes it.
await ask(page, 'cancel my advising appointment');
await pause(page, 3200);
await frame(page, '4-cancel-asks');
await glide(page, 'button:has-text("Approve")');
await pause(page, 900);
await page.locator('button:has-text("Approve")').first().click();
await pause(page, 3500);

// 5. Undo — one keystroke brings it back.
await page.mouse.move(W * 0.45, 150, { steps: 20 }); // off the input so Cmd-Z reaches the calendar
await page.mouse.click(W * 0.45, 150);
await pause(page, 600);
await page.keyboard.press('Meta+z');
await pause(page, 900);
await glide(page, block('Advising', addDaysWall(TODAY, 2)));
await pause(page, 5000);
await frame(page, '5-undo');
await pause(page, 4500);

const seconds = (Date.now() - t0) / 1000;
const video = page.video();
await context.close();
await browser.close();
renameSync(await video!.path(), OUT);
console.log(`recorded ${seconds.toFixed(1)}s → ${OUT}`);
console.log(`frames → ${FRAMES}`);
