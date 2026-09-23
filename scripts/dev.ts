/**
 * `bun dev` — brings up the API (:3001) and the Next.js UI (:3000) together.
 */
import { spawn } from 'bun';

const root = new URL('..', import.meta.url).pathname;

const procs = [
  spawn(['bun', '--watch', 'apps/api/src/index.ts'], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  }),
  spawn(['bun', 'run', 'dev'], {
    cwd: `${root}apps/web`,
    stdout: 'inherit',
    stderr: 'inherit',
  }),
];

function shutdown() {
  for (const p of procs) p.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await Promise.all(procs.map((p) => p.exited));
