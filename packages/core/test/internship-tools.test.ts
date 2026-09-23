/**
 * The internship AI tools: search_internships (one call scans the whole board)
 * and track_application (company-resolved dry/commit status changes, ambiguity
 * as a constraint conflict, snapshot undo). No network — the board is seeded
 * through ingestFeedEntries.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { ingestFeedEntries, setInternshipStatus, type FeedEntry } from '../src/internships';
import { searchInternshipsTool } from '../src/tools/search-internships';
import { trackApplicationTool } from '../src/tools/track-application';
import { createProposal, type ProposalRow } from '../src/proposals';
import { undoProposal, isUndoable } from '../src/undo';
import { isActionable } from '../src/types';

const DAY = 86_400;
const nowSec = Math.floor(Date.now() / 1000);

/** Feed-shaped fixtures pinned relative to now so posted_within_days is testable. */
const FEED: FeedEntry[] = [
  {
    id: 'sw1',
    company_name: 'Stripe',
    title: 'Software Engineering Intern',
    url: 'https://stripe.com/jobs/swe',
    locations: ['San Francisco, CA', 'New York, NY', 'Seattle, WA'],
    terms: ['Summer 2026'],
    category: 'Software Engineering',
    active: true,
    is_visible: true,
    date_posted: nowSec - 2 * DAY,
    date_updated: nowSec - DAY,
  },
  {
    id: 'ml1',
    company_name: 'Stripe',
    title: 'Machine Learning Intern',
    url: 'https://stripe.com/jobs/ml',
    locations: ['New York, NY'],
    terms: ['Summer 2026'],
    category: 'Data Science, AI & Machine Learning',
    active: true,
    is_visible: true,
    date_posted: nowSec - 30 * DAY,
    date_updated: nowSec - 30 * DAY,
  },
  {
    id: 'q1',
    company_name: 'Jane Street',
    title: 'Quantitative Trading Intern',
    url: 'https://janestreet.com/jobs/q',
    locations: ['New York, NY'],
    terms: ['Summer 2026'],
    category: 'Quantitative Finance',
    active: true,
    is_visible: true,
    date_posted: nowSec - 10 * DAY,
    date_updated: nowSec - 10 * DAY,
  },
  {
    id: 'dl1',
    company_name: 'Nvidia',
    title: 'Deep Learning Intern',
    url: 'https://nvidia.com/jobs/dl',
    locations: ['Santa Clara, CA'],
    terms: ['Summer 2026'],
    category: 'Data Science, AI & Machine Learning',
    active: true,
    is_visible: true,
    date_posted: nowSec - 5 * DAY,
    date_updated: nowSec - 5 * DAY,
  },
  {
    id: 'cl1',
    company_name: 'ClosedCo',
    title: 'Software Intern',
    url: 'https://closedco.com/jobs/1',
    locations: ['Remote'],
    terms: ['Summer 2026'],
    category: 'Software Engineering',
    active: false,
    is_visible: true,
    date_posted: nowSec - 20 * DAY,
    date_updated: nowSec - 20 * DAY,
  },
];

let db: DB;
beforeEach(() => {
  db = resetDbForTests();
  ingestFeedEntries(db, 'simplify', FEED);
});

function apps(): { internship_id: string; status: string }[] {
  return db.select().from(schema.internshipApplication).all();
}

type SearchResult = { total: number; showing: number; board_last_synced: string; internships: string[] };

describe('search_internships', () => {
  test('one call scans the board: active rows, posted-desc, compact lines, sync state', async () => {
    const r = (await searchInternshipsTool.run({} as never)) as SearchResult;
    expect(r.total).toBe(4); // ClosedCo is active=false and stays out by default
    expect(r.internships).toHaveLength(4);
    expect(r.internships[0]).toContain('Stripe — Software Engineering Intern'); // newest first
    expect(r.internships[0]).toContain('(+1 more)'); // 3 locations → first 2 + count
    expect(r.internships[0]).toContain('https://stripe.com/jobs/swe');
    expect(r.board_last_synced).toStartWith('never'); // no sync ran in tests
  });

  test('query matches company OR title; company matches company only (both directions)', async () => {
    const byTitle = (await searchInternshipsTool.run({ query: 'machine learning' } as never)) as SearchResult;
    expect(byTitle.total).toBe(1);
    expect(byTitle.internships[0]).toContain('Machine Learning Intern');

    const byCompany = (await searchInternshipsTool.run({ company: 'stripe' } as never)) as SearchResult;
    expect(byCompany.total).toBe(2);

    // Sai says more than the board stores — reverse containment still hits.
    const loose = (await searchInternshipsTool.run({ company: 'jane street capital' } as never)) as SearchResult;
    expect(loose.total).toBe(1);
    expect(loose.internships[0]).toContain('Jane Street');
  });

  test('posted_within_days and limit; total always counts every match', async () => {
    const recent = (await searchInternshipsTool.run({ posted_within_days: 7 } as never)) as SearchResult;
    expect(recent.total).toBe(2); // Stripe SWE (2d) + Nvidia (5d)

    const capped = (await searchInternshipsTool.run({ limit: 1 } as never)) as SearchResult;
    expect(capped.total).toBe(4);
    expect(capped.showing).toBe(1);
    expect(capped.internships).toHaveLength(1);
  });

  test('urls ride along only when 5 or fewer rows are shown (1500-char cap)', async () => {
    const extra: FeedEntry[] = Array.from({ length: 4 }, (_, k) => ({
      id: `x${k}`,
      company_name: `ExtraCo${k}`,
      title: 'Software Intern',
      url: `https://extra.example/${k}`,
      locations: ['Remote'],
      terms: ['Summer 2026'],
      category: 'Software Engineering',
      active: true,
      is_visible: true,
      date_posted: nowSec - (20 + k) * DAY,
      date_updated: nowSec - (20 + k) * DAY,
    }));
    ingestFeedEntries(db, 'simplify', extra);

    const wide = (await searchInternshipsTool.run({} as never)) as SearchResult;
    expect(wide.showing).toBe(8);
    expect(wide.internships.some((l) => l.includes('https://'))).toBe(false);

    const narrow = (await searchInternshipsTool.run({ company: 'stripe' } as never)) as SearchResult;
    expect(narrow.showing).toBe(2);
    expect(narrow.internships.every((l) => l.includes('https://stripe.com/jobs/'))).toBe(true);
  });

  test('status filter is about HIS pipeline — closed listings included and marked', async () => {
    setInternshipStatus(db, 'simplify:cl1', 'applied');
    const r = (await searchInternshipsTool.run({ status: 'applied' } as never)) as SearchResult;
    expect(r.total).toBe(1);
    expect(r.internships[0]).toContain('ClosedCo');
    expect(r.internships[0]).toContain('CLOSED');
    expect(r.internships[0]).toContain('tracked: applied');
  });
});

describe('track_application', () => {
  test('dry resolves one clear match and writes nothing; the diff is the spec line', async () => {
    const dry = await trackApplicationTool.run({ company: 'jane street', status: 'interested' } as never, 'dry');
    expect(dry.conflicts).toEqual([]);
    expect(dry.diff.application_changes?.[0]).toBe(
      'Jane Street — Quantitative Trading Intern: (untracked) → interested',
    );
    expect(isActionable(dry.diff)).toBe(true);
    expect(apps()).toEqual([]); // dry wrote nothing
  });

  test('commit tracks it, stamps applied_at on applied, and stores the undo snapshot', async () => {
    const { diff, conflicts } = await trackApplicationTool.run(
      { company: 'nvidia', status: 'applied', notes: 'referred by Alex' } as never,
      'commit',
    );
    expect(conflicts).toEqual([]);
    const rows = apps();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.internship_id).toBe('simplify:dl1');
    expect(rows[0]!.status).toBe('applied');
    const full = db.select().from(schema.internshipApplication).get()!;
    expect(full.applied_at).not.toBeNull();
    expect(full.notes).toBe('referred by Alex');
    expect(diff.application_internship_id).toBe('simplify:dl1');
    expect(diff.application_before).toBeNull();
    expect((diff.application_after as { status: string }).status).toBe('applied');
  });

  test('several plausible listings → constraint listing candidates, nothing applied', async () => {
    const r = await trackApplicationTool.run({ company: 'stripe', status: 'interested' } as never, 'dry');
    expect(isActionable(r.diff)).toBe(false);
    expect(r.conflicts).toHaveLength(1);
    const msg = (r.conflicts[0] as { message: string }).message;
    expect(msg).toContain('Software Engineering Intern');
    expect(msg).toContain('Machine Learning Intern');
    expect(msg).toContain('title_hint');
  });

  test('title_hint picks between a company’s listings', async () => {
    await trackApplicationTool.run(
      { company: 'stripe', title_hint: 'machine learning', status: 'interested' } as never,
      'commit',
    );
    expect(apps()).toEqual([{ ...apps()[0]!, internship_id: 'simplify:ml1', status: 'interested' }]);
  });

  test('abbreviated hints ("ML", "SWE") resolve instead of dead-ending in ambiguity', async () => {
    const ml = await trackApplicationTool.run(
      { company: 'stripe', title_hint: 'ML', status: 'applied' } as never,
      'dry',
    );
    expect(ml.conflicts).toHaveLength(0);
    expect(ml.diff.application_changes?.[0]).toContain('Machine Learning Intern');

    const swe = await trackApplicationTool.run(
      { company: 'stripe', title_hint: 'SWE', status: 'applied' } as never,
      'dry',
    );
    expect(swe.conflicts).toHaveLength(0);
    expect(swe.diff.application_changes?.[0]).toContain('Software Engineering Intern');
  });

  test('ambiguity spanning companies names each candidate’s company', async () => {
    // "st" LIKE-matches Stripe AND Jane Street — the message must not pin
    // every candidate on one company.
    const r = await trackApplicationTool.run({ company: 'st', status: 'interested' } as never, 'dry');
    const msg = (r.conflicts[0] as { message: string }).message;
    expect(msg).toContain('Several listings match "st"');
    expect(msg).toContain('Stripe —');
    expect(msg).toContain('Jane Street —');
  });

  test('pipeline movement with no hint goes to the one already-tracked listing', async () => {
    setInternshipStatus(db, 'simplify:ml1', 'interested');
    const { diff } = await trackApplicationTool.run({ company: 'stripe', status: 'applied' } as never, 'commit');
    expect(diff.application_internship_id).toBe('simplify:ml1');
    expect(diff.application_changes?.[0]).toContain('(interested) → applied');
    expect(apps()).toEqual([{ ...apps()[0]!, internship_id: 'simplify:ml1', status: 'applied' }]);
  });

  test('unknown company and empty board are distinct refusals', async () => {
    const unknown = await trackApplicationTool.run({ company: 'hooli', status: 'applied' } as never, 'dry');
    expect((unknown.conflicts[0] as { message: string }).message).toContain('No internship at "hooli"');

    db = resetDbForTests(); // empty board
    const empty = await trackApplicationTool.run({ company: 'stripe', status: 'applied' } as never, 'dry');
    expect((empty.conflicts[0] as { message: string }).message).toContain('board is empty');
  });

  test('untrack only considers tracked listings, and deletes on commit', async () => {
    const none = await trackApplicationTool.run({ company: 'stripe', status: 'untrack' } as never, 'dry');
    expect((none.conflicts[0] as { message: string }).message).toContain('nothing to untrack');

    setInternshipStatus(db, 'simplify:ml1', 'interested');
    // Two Stripe listings, but only one is tracked — no ambiguity for untrack.
    const { diff } = await trackApplicationTool.run({ company: 'stripe', status: 'untrack' } as never, 'commit');
    expect(diff.application_changes?.[0]).toContain('(interested) → untracked');
    expect(apps()).toEqual([]);
  });

  test('same status again is a no-op refusal — unless notes make it a change', async () => {
    setInternshipStatus(db, 'simplify:q1', 'applied');
    const noop = await trackApplicationTool.run({ company: 'jane street', status: 'applied' } as never, 'dry');
    expect((noop.conflicts[0] as { message: string }).message).toContain('already marked applied');

    const withNote = await trackApplicationTool.run(
      { company: 'jane street', status: 'applied', notes: 'OA due Friday' } as never,
      'commit',
    );
    expect(withNote.conflicts).toEqual([]);
    expect(db.select().from(schema.internshipApplication).get()!.notes).toBe('OA due Friday');
  });

  test('undo restores the prior application state (untracked → gone again)', async () => {
    const { diff } = await trackApplicationTool.run({ company: 'nvidia', status: 'interested' } as never, 'commit');
    expect(apps()).toHaveLength(1);
    const p = createProposal(db, { user_message: 'track nvidia', tool_name: 'track_application', tool_args: {}, diff, conflicts: [] });
    db.update(schema.proposal).set({ status: 'approved' }).where(eq(schema.proposal.id, p.id)).run();
    const row = db.select().from(schema.proposal).where(eq(schema.proposal.id, p.id)).get()! as ProposalRow;
    expect(isUndoable(row)).toBe(true);
    expect(undoProposal(db, row).ok).toBe(true);
    expect(apps()).toEqual([]); // back to untracked
  });

  test('undo restores the prior status, and refuses when a newer change landed', async () => {
    setInternshipStatus(db, 'simplify:q1', 'interested');
    const { diff } = await trackApplicationTool.run({ company: 'jane street', status: 'applied' } as never, 'commit');
    const p = createProposal(db, { user_message: 'applied to js', tool_name: 'track_application', tool_args: {}, diff, conflicts: [] });
    db.update(schema.proposal).set({ status: 'approved' }).where(eq(schema.proposal.id, p.id)).run();
    const row = db.select().from(schema.proposal).where(eq(schema.proposal.id, p.id)).get()! as ProposalRow;

    // A newer change lands on top — this undo must refuse, not clobber it.
    setInternshipStatus(db, 'simplify:q1', 'oa');
    const refused = undoProposal(db, row);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('undo the newer change first');

    // Put it back where the proposal left it — now the undo goes through.
    setInternshipStatus(db, 'simplify:q1', 'applied');
    const after = diff.application_after as { updated_at: string; applied_at: string | null };
    db.update(schema.internshipApplication)
      .set({ updated_at: after.updated_at, applied_at: after.applied_at })
      .where(eq(schema.internshipApplication.internship_id, 'simplify:q1'))
      .run();
    expect(undoProposal(db, row).ok).toBe(true);
    expect(apps()).toEqual([{ ...apps()[0]!, internship_id: 'simplify:q1', status: 'interested' }]);
  });
});
