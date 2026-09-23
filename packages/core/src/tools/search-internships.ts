/**
 * search_internships — read-only view of the internship board (the Internships
 * tab): listings synced from community aggregator feeds, LEFT JOINed with
 * Sai's tracked applications.
 *
 * ONE call scans the whole board internally (memory: the 30B won't iterate —
 * whole-horizon tools only): every matching row is pulled, filtered in memory,
 * and only the top page is returned, so the model never needs to page or loop.
 * Results are compact lines because tool output is truncated at 1500 chars —
 * and URLs (60-120 chars each) ride along only when ≤ 5 rows are shown, since
 * a default page with links measures ~2500 chars and would be cut mid-row.
 */
import { z } from 'zod';
import { getDb } from '../db/client';
import { getInternshipLastSynced, listInternships, type InternshipWithApp } from '../internships';
import type { ReadToolDef } from '../types';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
/** URLs are included only at or below this row count (see header note). */
const URL_LIMIT = 5;
/** "Fetch everything that matches" — the board is a few thousand rows. */
const SCAN_LIMIT = 100_000;

const ArgsZ = z.object({
  query: z
    .string()
    .max(120)
    .optional()
    .describe('Free-text filter matched against company OR title, e.g. "machine learning", "stripe", "quant".'),
  company: z
    .string()
    .max(120)
    .optional()
    .describe('Company name only ("stripe" finds Stripe and nothing titled stripe). Use for "any X internships?".'),
  category: z
    .string()
    .max(60)
    .optional()
    .describe("Exact category: 'Software', 'AI/ML/Data', 'Quant', 'Hardware', or 'Product'."),
  status: z
    .enum(['interested', 'applied', 'oa', 'interview', 'offer', 'rejected', 'ghosted'])
    .optional()
    .describe(
      "Only Sai's TRACKED applications with this status — use for pipeline questions like \"what have I applied to?\" (status 'applied').",
    ),
  posted_within_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe('Only listings posted in the last N days — 7 for "new this week", 30 for "this month".'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Max rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). The total count is always reported.`),
});

export type SearchInternshipsArgs = z.infer<typeof ArgsZ>;

/** "Stripe — Software Engineering Intern — San Francisco, CA (+1 more) — posted 2026-07-20 — tracked: applied — url" */
function compactLine(i: InternshipWithApp, withUrl: boolean): string {
  const locs =
    i.locations.length > 2
      ? `${i.locations.slice(0, 2).join(' · ')} (+${i.locations.length - 2} more)`
      : i.locations.join(' · ');
  const parts = [i.company, i.title, locs || 'location unlisted', `posted ${i.date_posted.slice(0, 10)}`];
  if (!i.active) parts.push('CLOSED');
  if (i.application) parts.push(`tracked: ${i.application.status}`);
  if (withUrl) parts.push(i.url);
  return parts.join(' — ');
}

function syncedAgo(iso: string | null): string {
  if (!iso) return 'never — the board is empty until Sai hits Refresh on the Internships tab';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export const searchInternshipsTool: ReadToolDef<SearchInternshipsArgs> = {
  name: 'search_internships',
  description:
    'Search the internship board (the Internships tab): live SWE / AI-ML / quant / hardware / product internship ' +
    'listings from community feeds, plus the application statuses Sai tracks. Use it for ANY internship question — ' +
    '"who\'s hiring?", "any Stripe internships?", "new ML roles this week?", "what have I applied to?". ONE call ' +
    'scans the ENTIRE board — never call it once per company or per day. Examples: {"query":"machine learning",' +
    '"posted_within_days":7} → this week\'s new ML roles; {"company":"stripe"} → everything at Stripe; ' +
    '{"status":"applied"} → every application Sai has marked applied. Posting URLs appear only when 5 or fewer rows ' +
    'are shown — for a link, narrow with company or set limit to 5 or less. Read-only.',
  parameters: z.toJSONSchema(ArgsZ, { io: 'input' }),
  argsSchema: ArgsZ,
  kind: 'read',
  async run(args) {
    const db = getDb();
    // A status question is about HIS applications — closed listings included
    // (the board keeps them for exactly this). Otherwise active-only.
    const { items } = listInternships(db, {
      q: args.query,
      category: args.category,
      status: args.status,
      activeOnly: args.status === undefined,
      limit: SCAN_LIMIT,
    });
    let filtered = items;
    if (args.company) {
      const needle = args.company.trim().toLowerCase();
      filtered = filtered.filter(
        (i) => i.company.toLowerCase().includes(needle) || needle.includes(i.company.toLowerCase()),
      );
    }
    if (args.posted_within_days !== undefined) {
      const cutoff = new Date(Date.now() - args.posted_within_days * 86_400_000).toISOString();
      filtered = filtered.filter((i) => i.date_posted >= cutoff);
    }
    const limit = args.limit ?? DEFAULT_LIMIT;
    const shown = filtered.slice(0, limit);
    const withUrl = shown.length <= URL_LIMIT;
    // total/synced first so they survive the 1500-char truncation.
    return {
      total: filtered.length,
      showing: shown.length,
      board_last_synced: syncedAgo(getInternshipLastSynced(db)),
      ...(withUrl ? {} : { note: `urls omitted at this size — filter tighter (company, or limit ≤ ${URL_LIMIT}) to get links` }),
      internships: shown.map((i) => compactLine(i, withUrl)),
    };
  },
};
