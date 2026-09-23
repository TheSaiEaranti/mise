/**
 * Discord alert shaping — pure parts only (embed shape, batching, overflow).
 * notifyNewInternships itself is NOT exercised here: bun test auto-loads the
 * repo .env, so calling it would hit the real webhook and write a watermark
 * file. The network path stays covered by the poller in dev.
 */
import { describe, test, expect } from 'bun:test';
import type { Internship } from '@mise/core';
import { alertEmbed, buildAlertPayloads } from '../src/lib/internship-alerts';

function listing(n: number, over?: Partial<Internship>): Internship {
  return {
    id: `simplify:${n}`,
    source: 'simplify',
    company: `Co${n}`,
    title: `Software Engineering Intern ${n}`,
    url: `https://example.com/${n}`,
    locations: ['NYC'],
    terms: ['Summer 2027'],
    category: 'Software',
    sponsorship: null,
    active: true,
    date_posted: '2026-07-22T12:00:00.000Z',
    date_updated: '2026-07-22T12:00:00.000Z',
    first_seen: '2026-07-22T12:00:00.000Z',
    ...over,
  };
}

describe('alertEmbed', () => {
  test('carries title, link, and the locations/terms/category line', () => {
    const e = alertEmbed(
      listing(1, { locations: ['NYC', 'SF', 'Austin', 'Seattle'] }),
    ) as { title: string; url: string; description: string; footer: { text: string } };
    expect(e.title).toBe('Co1 — Software Engineering Intern 1');
    expect(e.url).toBe('https://example.com/1');
    expect(e.description).toContain('NYC · SF (+2 more)');
    expect(e.description).toContain('Summer 2027');
    expect(e.footer.text).toBe('via simplify');
  });

  test('clamps to Discord field limits', () => {
    const e = alertEmbed(listing(1, { title: 'X'.repeat(400) })) as { title: string };
    expect(e.title.length).toBe(256);
  });
});

describe('buildAlertPayloads', () => {
  const many = (n: number) => Array.from({ length: n }, (_, k) => listing(k));

  test('nothing new → no payloads', () => {
    expect(buildAlertPayloads([])).toEqual([]);
  });

  test('one message under 10, split at 10, capped at 25 across 3 messages', () => {
    expect(buildAlertPayloads(many(7)).map((p) => p.embeds.length)).toEqual([7]);
    expect(buildAlertPayloads(many(25)).map((p) => p.embeds.length)).toEqual([10, 10, 5]);
    expect(buildAlertPayloads(many(25)).at(-1)!.content).toBeUndefined();
  });

  test('beyond the cap becomes one "+N more" line, not more messages', () => {
    const payloads = buildAlertPayloads(many(31));
    expect(payloads.map((p) => p.embeds.length)).toEqual([10, 10, 5]);
    expect(payloads.at(-1)!.content).toContain('6 more new roles');
    expect(payloads[0]!.content).toBeUndefined();
  });
});
