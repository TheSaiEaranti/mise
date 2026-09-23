/**
 * track_application — move an internship application through the pipeline
 * ("I applied to Stripe", "got an OA from Jane Street", "untrack Datadog").
 *
 * The model quotes a COMPANY, not an internship id: listings are resolved by
 * case-insensitive company substring, ranked by title_hint similarity then
 * recency. One clear winner → act on it; several plausible → a constraint
 * conflict listing the top candidates (the create_suite unknown_meal pattern),
 * so the model asks instead of guessing. Undo restores the prior application
 * row from the snapshot in the diff (see undo.ts).
 */
import { z } from 'zod';
import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import { getDb, schema, type DB } from '../db/client';
import { escapeLike, setInternshipStatus, type InternshipWithApp } from '../internships';
import type { Conflict, Diff, MutationToolDef, ToolMode, ToolResult } from '../types';

const ArgsZ = z.object({
  company: z
    .string()
    .min(1)
    .max(120)
    .describe('Company name as Sai said it — matched case-insensitively against the board, so "stripe" finds Stripe.'),
  title_hint: z
    .string()
    .max(200)
    .optional()
    .describe(
      'A few words of the role title, used to pick between a company\'s listings — "software", "ML", "quant trading". ' +
        'Include it whenever Sai names the role.',
    ),
  status: z
    .enum(['interested', 'applied', 'oa', 'interview', 'offer', 'rejected', 'ghosted', 'untrack'])
    .describe(
      "Where the application now stands: 'interested' (just tracking it), 'applied', 'oa' (online assessment), " +
        "'interview', 'offer', 'rejected', 'ghosted' — or 'untrack' to stop tracking it.",
    ),
  notes: z
    .string()
    .max(2000)
    .optional()
    .describe('Optional note to save on the application ("referred by Alex", "OA due Friday"). Omit to keep existing notes.'),
});

export type TrackApplicationArgs = z.infer<typeof ArgsZ>;

const EMPTY: Diff = { summary: 'Track application', changes: [], unchanged_pinned: [] };

function constraint(rule: string, message: string): ToolResult {
  return { diff: EMPTY, conflicts: [{ type: 'constraint', rule, message } satisfies Conflict] };
}

/** Every listing whose company loosely matches what Sai said. LIKE covers
 *  "stripe" ⊂ "Stripe Inc"; the fallback covers the reverse ("Jane Street
 *  Capital" said, "Jane Street" stored). Closed listings included — a tracked
 *  application to a closed role still moves through the pipeline. */
function candidatesFor(db: DB, company: string): InternshipWithApp[] {
  const join = (where: SQL) =>
    db
      .select()
      .from(schema.internship)
      .leftJoin(schema.internshipApplication, eq(schema.internshipApplication.internship_id, schema.internship.id))
      .where(where)
      .all()
      .map((r) => ({ ...r.internship, application: r.internship_application }));
  const needle = company.trim();
  const rows = join(sql`${schema.internship.company} LIKE ${`%${escapeLike(needle)}%`} ESCAPE '\\'`);
  if (rows.length > 0) return rows;
  const lower = needle.toLowerCase();
  const names = [
    ...new Set(
      db
        .select({ company: schema.internship.company })
        .from(schema.internship)
        .all()
        .map((r) => r.company)
        .filter((c) => lower.includes(c.toLowerCase())),
    ),
  ];
  return names.length > 0 ? join(inArray(schema.internship.company, names)) : [];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** The way Sai actually says roles — expanded before scoring, because the
 *  feeds spell titles out ("Machine Learning Intern") while the tool's own
 *  examples teach the model to pass "ML". */
const HINT_EXPANSIONS: Record<string, string> = {
  ml: 'machine learning',
  ai: 'artificial intelligence',
  swe: 'software engineer',
  sde: 'software development engineer',
  ds: 'data science',
  sre: 'site reliability engineer',
  pm: 'product manager',
  apm: 'associate product manager',
  infra: 'infrastructure',
};

/** How well a hint names a title: 3 exact, 2 containment, 1 shares a word or
 *  reads as an acronym of the title's initials ("sde" ⊂ "sdei"). */
function titleScore(hint: string, title: string): number {
  const t = norm(title);
  const raw = norm(hint);
  if (!raw || !t) return 0;
  const h = raw
    .split(' ')
    .map((w) => HINT_EXPANSIONS[w] ?? w)
    .join(' ');
  if (h === t || raw === t) return 3;
  if (t.includes(h) || h.includes(t) || t.includes(raw)) return 2;
  const words = new Set(t.split(' '));
  if (h.split(' ').some((w) => words.has(w))) return 1;
  const acronym = raw.replace(/ /g, '');
  const initials = t
    .split(' ')
    .map((w) => w[0])
    .join('');
  return acronym.length >= 2 && initials.includes(acronym) ? 1 : 0;
}

async function run(args: TrackApplicationArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();
  const untrack = args.status === 'untrack';
  const all = candidatesFor(db, args.company);
  if (all.length === 0) {
    const boardEmpty = db.select({ id: schema.internship.id }).from(schema.internship).limit(1).get() === undefined;
    return constraint(
      'unknown_company',
      boardEmpty
        ? 'The internship board is empty — Sai loads it with Refresh on the Internships tab.'
        : `No internship at "${args.company}" on the board — check the company with search_internships.`,
    );
  }
  const candidates = untrack ? all.filter((c) => c.application !== null) : all;
  if (candidates.length === 0) {
    return constraint('not_tracked', `Nothing at ${all[0]!.company} is tracked — nothing to untrack.`);
  }

  // Rank: title_hint similarity, then recency.
  const scored = candidates
    .map((c) => ({ c, score: args.title_hint ? titleScore(args.title_hint, c.title) : 0 }))
    .sort((a, b) => b.score - a.score || b.c.date_posted.localeCompare(a.c.date_posted));

  let winner: InternshipWithApp | null = null;
  if (scored.length === 1) {
    winner = scored[0]!.c;
  } else if (scored[0]!.score > 0 && scored[0]!.score > scored[1]!.score) {
    // The hint names exactly one listing best.
    winner = scored[0]!.c;
  } else if (!untrack && args.status !== 'interested') {
    // Pipeline movement ("I applied", "got the offer") on a company where
    // exactly one listing is already tracked can only mean that one.
    const tracked = scored.filter((s) => s.c.application !== null);
    if (tracked.length === 1) winner = tracked[0]!.c;
  }
  if (!winner) {
    // The LIKE match can span companies ("amp" → Ampere AND Amp Robotics), so
    // every numbered candidate names its company and the phrasing stays
    // neutral unless they all share one.
    const companies = new Set(scored.map((s) => s.c.company));
    const tops = scored
      .slice(0, 3)
      .map((s, i) => `${i + 1}) ${s.c.company} — ${s.c.title} (posted ${s.c.date_posted.slice(0, 10)})`)
      .join('  ');
    const lead =
      companies.size > 1
        ? `Several listings match "${args.company}"`
        : `${scored[0]!.c.company} has several listings`;
    return constraint(
      'ambiguous_internship',
      `${lead} — which role? ${tops}. Ask Sai which, or retry with a title_hint naming it.`,
    );
  }

  const before = winner.application;
  if (!untrack && before?.status === args.status && args.notes === undefined) {
    return constraint('no_change', `${winner.company} — ${winner.title} is already marked ${args.status}.`);
  }

  const toLabel = untrack ? 'untracked' : args.status;
  const line =
    `${winner.company} — ${winner.title}: (${before?.status ?? 'untracked'}) → ${toLabel}` +
    (args.notes !== undefined ? ' · note saved' : '');
  const diff: Diff = {
    summary: `Application · ${winner.company} → ${toLabel}`,
    detail: winner.title,
    changes: [],
    unchanged_pinned: [],
    application_changes: [line],
  };
  if (mode === 'dry') return { diff, conflicts: [] };

  const after = setInternshipStatus(db, winner.id, args.status === 'untrack' ? null : args.status, args.notes);
  return {
    diff: {
      ...diff,
      application_internship_id: winner.id,
      application_before: before,
      application_after: after?.application ?? null,
    },
    conflicts: [],
  };
}

export const trackApplicationTool: MutationToolDef<TrackApplicationArgs> = {
  name: 'track_application',
  description:
    'Track or update an internship APPLICATION on the Internships board. Use it whenever Sai reports movement or wants ' +
    'a role tracked: "I applied to Stripe" → status "applied"; "got an OA from Jane Street" → "oa"; "Datadog rejected ' +
    'me" → "rejected"; "track the Nvidia ML internship" → "interested" with title_hint "ML"; "stop tracking Amazon" → ' +
    '"untrack". Pass the company as Sai said it (loose match is fine) plus a title_hint when he names the role — the ' +
    'tool finds the listing itself, and lists the candidates instead of guessing when several fit. Pipeline: ' +
    'interested → applied → oa → interview → offer / rejected / ghosted.',
  parameters: z.toJSONSchema(ArgsZ, { io: 'input' }),
  argsSchema: ArgsZ,
  kind: 'mutation',
  run,
};
