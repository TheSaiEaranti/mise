/**
 * The dev latency surface: GET /api/dev/turns serves recent turn traces and
 * request timings, and disappears when the dev panel is off.
 */
import { afterEach, describe, expect, test } from 'bun:test';

process.env.MISE_SETTINGS_PATH = '/nonexistent/mise-dev-test-settings.json';

import { resetDbForTests } from '@mise/core';
import { app } from '../src/app';

afterEach(() => {
  delete process.env.MISE_DEV_PANEL;
});

describe('/api/dev/turns', () => {
  test('serves traces and request timings when enabled', async () => {
    resetDbForTests();
    // A POST to a timed path (400: bad body) is still a timed request.
    await app.request('/api/chat', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    const res = await app.request('/api/dev/turns');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { turns: unknown[]; requests: { method: string; path: string; status: number; ms: number }[] };
    expect(Array.isArray(body.turns)).toBe(true);
    expect(body.requests[0]).toMatchObject({ method: 'POST', path: '/api/chat', status: 400 });
    expect(body.requests[0]!.ms).toBeGreaterThanOrEqual(0);
  });

  test('404 when the panel is off', async () => {
    process.env.MISE_DEV_PANEL = '0';
    const res = await app.request('/api/dev/turns');
    expect(res.status).toBe(404);
  });
});
