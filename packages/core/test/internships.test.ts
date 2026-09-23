/**
 * Internships — pure feed helpers (normalize/derive/filter/row-shape) and the
 * DB spine (ingest upsert, list filters, status tracking, tracker groups).
 * No network anywhere: ingestFeedEntries takes parsed entries directly.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { resetDbForTests, type DB } from '../src/db/client';
import {
  normalizeCategory,
  deriveTerm,
  isRelevantListing,
  feedEntryToRow,
  ingestFeedEntries,
  listInternships,
  getInternshipFacets,
  getInternshipLastSynced,
  setInternshipStatus,
  setInternshipNotes,
  getInternshipTracker,
  type FeedEntry,
} from '../src/internships';

const NOW = '2026-07-22T12:00:00.000Z';

/** Realistic simplify-shaped entries. Timestamps are unix SECONDS:
 *  1735689600 = 2025-01-01T00:00:00Z, 1735776000 = 2025-01-02T00:00:00Z. */
const SIMPLIFY: FeedEntry[] = [
  {
    id: 'a1b2c3',
    source: 'Simplify',
    company_name: 'Stripe',
    title: 'Software Engineering Intern',
    url: 'https://stripe.com/jobs/123',
    locations: ['San Francisco, CA', 'New York, NY'],
    terms: ['Summer 2026'],
    category: 'Software Engineering',
    sponsorship: 'Offers Sponsorship',
    active: true,
    is_visible: true,
    date_posted: 1735689600,
    date_updated: 1735776000,
  },
  {
    id: 'd4e5f6',
    source: 'Simplify',
    company_name: 'Jane Street',
    title: 'Quantitative Trading Intern',
    url: 'https://janestreet.com/jobs/456',
    locations: ['New York, NY'],
    terms: ['Summer 2026'],
    category: 'Quantitative Finance',
    sponsorship: 'Does Not Offer Sponsorship',
    active: false,
    is_visible: true,
    date_posted: 1735689600,
    date_updated: 1735689600,
  },
  {
    id: 'g7h8i9',
    source: 'Simplify',
    company_name: 'MegaCorp',
    title: 'Marketing Intern',
    url: 'https://megacorp.com/jobs/789',
    locations: ['Austin, TX'],
    terms: ['Summer 2026'],
    category: 'Other',
    active: true,
    is_visible: true,
    date_posted: 1735689600,
    date_updated: 1735689600,
  },
  {
    id: 'j1k2l3',
    source: 'Simplify',
    company_name: 'GhostCo',
    title: 'Software Engineering Intern',
    url: 'https://ghostco.com/jobs/1',
    locations: ['Remote'],
    terms: ['Summer 2026'],
    category: 'Software Engineering',
    active: true,
    is_visible: false,
    date_posted: 1735689600,
    date_updated: 1735689600,
  },
];

/** vanshb03-shaped: `season` instead of `terms`, no category. */
const VANSH: FeedEntry[] = [
  {
    id: 'v1',
    source: 'vanshb03',
    company_name: ' stripe ', // same company+title as simplify's, case/space differing
    title: 'Software Engineering Intern',
    url: 'https://stripe.com/jobs/other',
    locations: ['San Francisco, CA'],
    season: 'Summer',
    active: true,
    is_visible: true,
    date_posted: 1735689600,
    date_updated: 1735689600,
  },
  {
    id: 'v2',
    source: 'vanshb03',
    company_name: 'Anthropic',
    title: 'Machine Learning Intern',
    url: 'https://anthropic.com/jobs/1',
    locations: ['San Francisco, CA'],
    season: 'Summer',
    active: true,
    is_visible: true,
    date_posted: 1735776000,
    date_updated: 1735776000,
  },
];

describe('normalizeCategory', () => {
  test('maps near-duplicate feed labels', () => {
    expect(normalizeCategory('Software Engineering', 'x')).toBe('Software');
    expect(normalizeCategory('Data Science, AI & Machine Learning', 'x')).toBe('AI/ML/Data');
    expect(normalizeCategory('Hardware Engineering', 'x')).toBe('Hardware');
    expect(normalizeCategory('Product Management', 'x')).toBe('Product');
    expect(normalizeCategory('Quantitative Finance', 'x')).toBe('Quant');
  });

  test('unknown labels pass through', () => {
    expect(normalizeCategory('Other', 'x')).toBe('Other');
  });

  test('missing category derives from the title', () => {
    expect(normalizeCategory(undefined, 'Quantitative Trading Intern')).toBe('Quant');
    expect(normalizeCategory(undefined, 'Machine Learning Intern')).toBe('AI/ML/Data');
    expect(normalizeCategory(undefined, 'Data Engineer Intern')).toBe('AI/ML/Data');
    expect(normalizeCategory(undefined, 'AI Research Intern')).toBe('AI/ML/Data');
    expect(normalizeCategory(undefined, 'Embedded Firmware Intern')).toBe('Hardware');
    expect(normalizeCategory(undefined, 'FPGA Design Intern')).toBe('Hardware');
    expect(normalizeCategory(undefined, 'Product Manager Intern')).toBe('Product');
    expect(normalizeCategory(undefined, 'APM Intern')).toBe('Product');
    expect(normalizeCategory(undefined, 'Software Engineer Intern')).toBe('Software');
    expect(normalizeCategory(undefined, 'Backend Intern')).toBe('Software');
    // "ai" inside a word must not trigger AI/ML/Data.
    expect(normalizeCategory(undefined, 'Retail Systems Intern')).toBe('Software');
  });
});

describe('deriveTerm', () => {
  test('maps vanshb03 seasons to the repo cycle terms', () => {
    expect(deriveTerm('Summer')).toBe('Summer 2027');
    expect(deriveTerm('Spring')).toBe('Spring 2027');
    expect(deriveTerm('Fall')).toBe('Fall 2026');
    expect(deriveTerm('Winter')).toBe('Winter 2026');
    expect(deriveTerm('summer')).toBe('Summer 2027'); // case-insensitive
    expect(deriveTerm('Summer 2028')).toBe('Summer 2028'); // unknown passes through
  });
});

describe('isRelevantListing', () => {
  test('keeps technical roles, incl. inactive ones', () => {
    expect(isRelevantListing(SIMPLIFY[0]!)).toBe(true);
    expect(isRelevantListing(SIMPLIFY[1]!)).toBe(true); // inactive stays stored
    expect(isRelevantListing({ ...SIMPLIFY[0]!, title: 'Sales Engineer Intern' })).toBe(true);
    // Live false-positives in the simplify feed the regex must NOT hit:
    expect(isRelevantListing({ ...SIMPLIFY[0]!, title: 'Salesforce Software Engineering Intern' })).toBe(true);
    expect(isRelevantListing({ ...SIMPLIFY[0]!, title: 'Telecommunications Intern-Engineering' })).toBe(true);
  });

  test('drops hidden and clearly-non-technical roles', () => {
    expect(isRelevantListing(SIMPLIFY[3]!)).toBe(false); // is_visible false
    expect(isRelevantListing(SIMPLIFY[2]!)).toBe(false); // Marketing
    expect(isRelevantListing({ ...SIMPLIFY[0]!, title: 'Sales Intern' })).toBe(false);
    expect(isRelevantListing({ ...SIMPLIFY[0]!, title: 'HR Intern' })).toBe(false);
    expect(isRelevantListing({ ...SIMPLIFY[0]!, title: 'Social Media Intern' })).toBe(false);
    expect(isRelevantListing({ ...SIMPLIFY[0]!, title: 'Recruiting Coordinator Intern' })).toBe(false);
  });
});

describe('feedEntryToRow', () => {
  test('simplify entry: unix SECONDS become ISO 8601 UTC, fields carried over', () => {
    const row = feedEntryToRow(SIMPLIFY[0]!, 'simplify', NOW);
    expect(row.id).toBe('simplify:a1b2c3');
    expect(row.source).toBe('simplify');
    expect(row.company).toBe('Stripe');
    expect(row.title).toBe('Software Engineering Intern');
    expect(row.date_posted).toBe('2025-01-01T00:00:00.000Z');
    expect(row.date_updated).toBe('2025-01-02T00:00:00.000Z');
    expect(row.first_seen).toBe(NOW);
    expect(row.locations).toEqual(['San Francisco, CA', 'New York, NY']);
    expect(row.terms).toEqual(['Summer 2026']);
    expect(row.category).toBe('Software');
    expect(row.sponsorship).toBe('Offers Sponsorship');
    expect(row.active).toBe(true);
  });

  test('missing feed id falls back to the url', () => {
    const row = feedEntryToRow({ ...SIMPLIFY[0]!, id: undefined }, 'simplify', NOW);
    expect(row.id).toBe('simplify:https://stripe.com/jobs/123');
  });

  test('vanshb03 entry: season becomes a term, category derived from title', () => {
    const row = feedEntryToRow(VANSH[1]!, 'vanshb03', NOW);
    expect(row.id).toBe('vanshb03:v2');
    expect(row.terms).toEqual(['Summer 2027']);
    expect(row.category).toBe('AI/ML/Data');
    expect(row.sponsorship).toBeNull();
  });

  test('missing date_updated falls back to date_posted', () => {
    const row = feedEntryToRow({ ...SIMPLIFY[0]!, date_updated: undefined }, 'simplify', NOW);
    expect(row.date_updated).toBe('2025-01-01T00:00:00.000Z');
  });
});

let db: DB;
beforeEach(() => {
  db = resetDbForTests();
});

describe('ingestFeedEntries', () => {
  test('inserts relevant entries, drops hidden + non-technical ones', () => {
    const r = ingestFeedEntries(db, 'simplify', SIMPLIFY, NOW);
    expect(r).toEqual({ fetched: 4, inserted: 2, updated: 0 });
    const { items, total } = listInternships(db, { activeOnly: false });
    expect(total).toBe(2);
    expect(items.map((i) => i.company).sort()).toEqual(['Jane Street', 'Stripe']);
  });

  test('re-ingest updates mutable fields, preserves first_seen', () => {
    ingestFeedEntries(db, 'simplify', SIMPLIFY, NOW);
    const later = '2026-07-23T12:00:00.000Z';
    const changed: FeedEntry = { ...SIMPLIFY[0]!, active: false, date_updated: 1736000000 };
    const r = ingestFeedEntries(db, 'simplify', [changed], later);
    expect(r).toEqual({ fetched: 1, inserted: 0, updated: 1 });
    const row = listInternships(db, { activeOnly: false, q: 'Stripe' }).items[0]!;
    expect(row.active).toBe(false);
    expect(row.first_seen).toBe(NOW); // not `later`
    expect(row.date_updated).toBe(new Date(1736000000 * 1000).toISOString());
  });

  test('cross-source dedup skips a vanshb03 entry simplify already lists', () => {
    ingestFeedEntries(db, 'simplify', SIMPLIFY, NOW);
    const r = ingestFeedEntries(db, 'vanshb03', VANSH, NOW);
    // " stripe " / same title is a dup of simplify's Stripe row; Anthropic is new.
    expect(r).toEqual({ fetched: 2, inserted: 1, updated: 0 });
    const { items } = listInternships(db, { q: 'stripe', activeOnly: false });
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('simplify');
  });

  test('dedup is directional: the primary inserts even when vanshb03 fetched first, retiring the duplicate', () => {
    ingestFeedEntries(db, 'vanshb03', VANSH, NOW);
    const r = ingestFeedEntries(db, 'simplify', SIMPLIFY, NOW);
    expect(r.inserted).toBe(2); // Stripe is NOT blocked by vansh's copy
    const stripe = listInternships(db, { q: 'stripe', activeOnly: false }).items;
    expect(stripe).toHaveLength(2);
    const activeBySource = Object.fromEntries(stripe.map((i) => [i.source, i.active]));
    expect(activeBySource).toEqual({ simplify: true, vanshb03: false });
    // The board (active view) shows exactly the primary's row.
    expect(listInternships(db, { q: 'stripe' }).items.map((i) => i.source)).toEqual(['simplify']);
  });

  test('a known row the feed has since hidden is deactivated, not left open forever', () => {
    ingestFeedEntries(db, 'simplify', SIMPLIFY, NOW);
    const later = '2026-07-23T12:00:00.000Z';
    const hidden: FeedEntry = { ...SIMPLIFY[0]!, is_visible: false, date_updated: 1736000000 };
    const r = ingestFeedEntries(db, 'simplify', [hidden], later);
    expect(r).toEqual({ fetched: 1, inserted: 0, updated: 1 });
    const row = listInternships(db, { activeOnly: false, q: 'Stripe' }).items[0]!;
    expect(row.active).toBe(false);
    expect(listInternships(db, { q: 'Stripe' }).total).toBe(0);
  });

  test('malformed feed junk is dropped without crashing', () => {
    const junk = [{ id: 'x' } as FeedEntry, null as unknown as FeedEntry, SIMPLIFY[0]!];
    const r = ingestFeedEntries(db, 'simplify', junk, NOW);
    expect(r).toEqual({ fetched: 3, inserted: 1, updated: 0 });
  });
});

describe('listInternships', () => {
  beforeEach(() => {
    ingestFeedEntries(db, 'simplify', SIMPLIFY, NOW);
    ingestFeedEntries(db, 'vanshb03', VANSH, NOW);
  });

  test('defaults to active-only, sorted by date_posted desc', () => {
    const { items, total } = listInternships(db);
    expect(total).toBe(2); // Jane Street is inactive
    expect(items.map((i) => i.company)).toEqual(['Anthropic', 'Stripe']);
    expect(items[0]!.application).toBeNull();
  });

  test('activeOnly false includes closed listings', () => {
    expect(listInternships(db, { activeOnly: false }).total).toBe(3);
  });

  test('q matches company OR title, case-insensitively', () => {
    expect(listInternships(db, { q: 'stripe' }).items.map((i) => i.company)).toEqual(['Stripe']);
    expect(listInternships(db, { q: 'machine learning' }).items.map((i) => i.company)).toEqual(['Anthropic']);
  });

  test('LIKE metacharacters in q match literally, not as wildcards', () => {
    expect(listInternships(db, { q: 'S_ripe' }).total).toBe(0);
    expect(listInternships(db, { q: '%' }).total).toBe(0);
    expect(listInternships(db, { q: 'stripe' }).total).toBe(1);
  });

  test('category and term filters', () => {
    expect(listInternships(db, { category: 'AI/ML/Data' }).items.map((i) => i.company)).toEqual(['Anthropic']);
    expect(listInternships(db, { term: 'Summer 2027' }).items.map((i) => i.company)).toEqual(['Anthropic']);
    expect(listInternships(db, { term: 'Summer 2026' }).items.map((i) => i.company)).toEqual(['Stripe']);
  });

  test('limit/offset paginate while total counts everything', () => {
    const page1 = listInternships(db, { limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.total).toBe(2);
    const page2 = listInternships(db, { limit: 1, offset: 1 });
    expect(page2.items[0]!.company).not.toBe(page1.items[0]!.company);
  });

  test('trackedOnly and status filter through the LEFT JOIN', () => {
    const stripe = listInternships(db, { q: 'Stripe' }).items[0]!;
    setInternshipStatus(db, stripe.id, 'applied');
    expect(listInternships(db, { trackedOnly: true }).items.map((i) => i.company)).toEqual(['Stripe']);
    expect(listInternships(db, { status: 'applied' }).items.map((i) => i.company)).toEqual(['Stripe']);
    expect(listInternships(db, { status: 'offer' }).total).toBe(0);
    const tracked = listInternships(db, { q: 'Stripe' }).items[0]!;
    expect(tracked.application?.status).toBe('applied');
  });

  test('facets cover active rows only', () => {
    expect(getInternshipFacets(db)).toEqual({
      categories: ['AI/ML/Data', 'Software'], // Quant is on the inactive row
      terms: ['Summer 2026', 'Summer 2027'],
    });
  });
});

describe('setInternshipStatus / tracker', () => {
  let stripeId: string;
  let anthropicId: string;
  beforeEach(() => {
    ingestFeedEntries(db, 'simplify', SIMPLIFY, NOW);
    ingestFeedEntries(db, 'vanshb03', VANSH, NOW);
    stripeId = listInternships(db, { q: 'Stripe' }).items[0]!.id;
    anthropicId = listInternships(db, { q: 'Anthropic' }).items[0]!.id;
  });

  test('track, first-applied stamps applied_at, later moves keep it', () => {
    const interested = setInternshipStatus(db, stripeId, 'interested');
    expect(interested?.application?.status).toBe('interested');
    expect(interested?.application?.applied_at).toBeNull();
    const applied = setInternshipStatus(db, stripeId, 'applied');
    const appliedAt = applied?.application?.applied_at;
    expect(appliedAt).toBeTruthy();
    const oa = setInternshipStatus(db, stripeId, 'oa');
    expect(oa?.application?.applied_at).toBe(appliedAt!);
  });

  test('notes: undefined preserves, string sets, null clears', () => {
    setInternshipStatus(db, stripeId, 'interested', 'referral from Alex');
    expect(setInternshipStatus(db, stripeId, 'applied')?.application?.notes).toBe('referral from Alex');
    expect(setInternshipStatus(db, stripeId, 'applied', null)?.application?.notes).toBeNull();
    expect(setInternshipNotes(db, stripeId, 'OA due Friday')?.application?.notes).toBe('OA due Friday');
    expect(setInternshipNotes(db, anthropicId, 'x')).toBeNull(); // not tracked
  });

  test('null status untracks; unknown internship returns null', () => {
    setInternshipStatus(db, stripeId, 'interested');
    const untracked = setInternshipStatus(db, stripeId, null);
    expect(untracked?.application).toBeNull();
    expect(listInternships(db, { trackedOnly: true }).total).toBe(0);
    expect(setInternshipStatus(db, 'nope:1', 'applied')).toBeNull();
  });

  test('tracker groups in pipeline order, empty groups omitted', () => {
    expect(getInternshipTracker(db)).toEqual([]);
    setInternshipStatus(db, anthropicId, 'offer');
    setInternshipStatus(db, stripeId, 'interested');
    const groups = getInternshipTracker(db);
    expect(groups.map((g) => g.status)).toEqual(['interested', 'offer']);
    expect(groups[0]!.items[0]!.company).toBe('Stripe');
    expect(groups[1]!.items[0]!.application?.status).toBe('offer');
  });
});

describe('sync bookkeeping', () => {
  test('lastSynced is null before any sync', () => {
    expect(getInternshipLastSynced(db)).toBeNull();
  });
});
