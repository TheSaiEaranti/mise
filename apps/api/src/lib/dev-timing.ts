/**
 * Dev-only latency surface: request timings for the endpoints a person waits
 * on (chat, drag = propose + approve, undo), kept in a small ring buffer next
 * to the per-turn traces from @mise/core. Measurement only.
 *
 * Off when NODE_ENV=production or MISE_DEV_PANEL=0.
 */
import type { MiddlewareHandler } from 'hono';

export function devPanelEnabled(): boolean {
  if (process.env.MISE_DEV_PANEL === '0') return false;
  return process.env.NODE_ENV !== 'production';
}

export interface RequestTiming {
  at: string;
  method: string;
  path: string;
  status: number;
  ms: number;
}

const RING_SIZE = 100;
const ring: RequestTiming[] = [];

/** Only the interactive paths: the UI's polling would drown everything else. */
const TIMED = /^\/api\/(chat|proposals)(\/|$)/;

export const requestTiming: MiddlewareHandler = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (c.req.method === 'GET' || !TIMED.test(path)) return next();
  const start = performance.now();
  await next();
  ring.push({
    at: new Date().toISOString(),
    method: c.req.method,
    path: path.replace(/\/prop[_-][A-Za-z0-9_-]+/, '/:id'),
    status: c.res.status,
    ms: Math.round((performance.now() - start) * 10) / 10,
  });
  if (ring.length > RING_SIZE) ring.shift();
};

export function recentRequests(limit = 30): RequestTiming[] {
  return ring.slice(-limit).reverse();
}
