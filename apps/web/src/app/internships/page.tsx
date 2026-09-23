'use client';

/**
 * Internships — an SWE/ML internship board fed by the community aggregator
 * repos (SimplifyJobs, vanshb03), plus the application pipeline. Two views:
 * the Feed (filterable listings, 100 a page) and the Tracker (what you're
 * pursuing, grouped by status). The one mutating control on the whole screen
 * is the status pill; the assistant can drive the same state from chat, so
 * the page refetches on scheduleVersion like every other screen.
 *
 * Syncing checks the upstream repos' latest commit before downloading, so it
 * is cheap when nothing changed. The page kicks a sync automatically when the
 * board is empty or more than an hour stale; the Refresh button forces a real
 * re-download because a deliberate click means "get it all, now".
 *
 * Status changes are optimistic: the pill flips immediately, the server row
 * replaces it when the PUT lands, and an error puts everything back.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import {
  getInternshipTracker,
  listInternships,
  setInternshipApplication,
  syncInternships,
} from '@/lib/api';
import type { AppStatus, InternshipItem } from '@/lib/api';
import { useApp } from '@/lib/store';
import { Button } from '@/components/ui/button';
import { FilterBar, type FeedFilters } from '@/components/internships/filter-bar';
import { InternshipRow } from '@/components/internships/internship-row';
import { STATUS_ORDER } from '@/components/internships/status-pill';
import { TrackerView, type TrackerGroup } from '@/components/internships/tracker-view';
import { timeAgo } from '@/components/internships/format';

const PAGE = 100;
const STALE_MS = 60 * 60 * 1000; // auto-sync when the board is older than this

export default function InternshipsPage() {
  const { scheduleVersion } = useApp();

  const [view, setView] = useState<'feed' | 'tracker'>('feed');
  const [filters, setFilters] = useState<FeedFilters>({
    q: '',
    category: '',
    term: '',
    trackedOnly: false,
    includeClosed: false,
  });
  const [debouncedQ, setDebouncedQ] = useState('');

  const [items, setItems] = useState<InternshipItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<{ categories: string[]; terms: string[] }>({
    categories: [],
    terms: [],
  });
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [groups, setGroups] = useState<TrackerGroup[] | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // Refs so callbacks can snapshot without re-binding on every render.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const syncingRef = useRef(false);
  const autoSynced = useRef(false);
  // Bumped whenever the feed effect starts a page-0 refetch; loadMore captures
  // it before its await and discards responses from a superseded generation,
  // so a slow "load more" can't append rows from pre-sync/pre-filter truth.
  const fetchGen = useRef(0);

  // ~300ms debounce on the search box; everything else filters instantly.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(filters.q.trim()), 300);
    return () => clearTimeout(t);
  }, [filters.q]);

  const runSync = useCallback(async (force?: boolean) => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    setError(null);
    try {
      const report = await syncInternships(force);
      const failed = report.sources.filter((s) => s.error);
      if (failed.length > 0) {
        setError(`Sync hit trouble — ${failed.map((s) => `${s.source}: ${s.error}`).join('; ')}`);
      }
      setRefreshTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed.');
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, []);

  // The feed. Refetches on any filter change, after a sync, and whenever the
  // assistant applied something (scheduleVersion). Old rows stay on screen
  // while the next page of truth loads — the board never blanks.
  useEffect(() => {
    let alive = true;
    fetchGen.current += 1;
    void (async () => {
      try {
        const res = await listInternships({
          q: debouncedQ || undefined,
          category: filters.category || undefined,
          term: filters.term || undefined,
          trackedOnly: filters.trackedOnly || undefined,
          activeOnly: filters.includeClosed ? false : undefined,
          limit: PAGE,
          offset: 0,
        });
        if (!alive) return;
        setItems(res.items);
        setTotal(res.total);
        setFacets(res.facets);
        setLastSynced(res.lastSynced);
        setError(null);
        // First load only: kick a sync when the board is empty or stale, then
        // the refreshTick bump refetches with the fresh rows.
        if (!autoSynced.current) {
          autoSynced.current = true;
          const stale =
            res.lastSynced === null || Date.now() - Date.parse(res.lastSynced) > STALE_MS;
          if (stale) void runSync();
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [
    debouncedQ,
    filters.category,
    filters.term,
    filters.trackedOnly,
    filters.includeClosed,
    refreshTick,
    scheduleVersion,
    runSync,
  ]);

  const refreshTracker = useCallback(async () => {
    try {
      setGroups(await getInternshipTracker());
    } catch (e) {
      // Same visible channel the feed uses — a silent console.warn left the
      // tracker on its loading dot forever with nothing to act on.
      setError(e instanceof Error ? e.message : 'Could not load the tracker.');
    }
  }, []);

  useEffect(() => {
    if (view !== 'tracker') return;
    void refreshTracker();
  }, [view, refreshTick, scheduleVersion, refreshTracker]);

  /** Optimistic status change, shared by both views. On error only the
   *  touched row reverts — a whole-list snapshot restore would wipe pages a
   *  concurrent "Load more" appended and other rows' successful updates. */
  const changeStatus = useCallback(
    async (id: string, status: AppStatus | null) => {
      const find = (list: InternshipItem[] | null | undefined) => list?.find((it) => it.id === id);
      const prevApp =
        (find(itemsRef.current) ?? find(groupsRef.current?.flatMap((g) => g.items)))?.application ??
        null;
      const nowIso = new Date().toISOString();
      const patch = (it: InternshipItem): InternshipItem => {
        if (it.id !== id) return it;
        if (status === null) return { ...it, application: null };
        return {
          ...it,
          application: {
            internship_id: it.id,
            status,
            notes: it.application?.notes ?? null,
            applied_at:
              it.application?.applied_at ?? (status === 'applied' ? nowIso : null),
            updated_at: nowIso,
          },
        };
      };
      setItems((cur) => (cur === null ? cur : cur.map(patch)));
      setGroups((cur) => {
        if (cur === null) return cur;
        const all = cur.flatMap((g) => g.items).map(patch);
        return STATUS_ORDER.map((s) => ({
          status: s,
          items: all.filter((it) => it.application?.status === s),
        })).filter((g) => g.items.length > 0);
      });
      try {
        const updated = await setInternshipApplication(id, status);
        if (status === null && filters.trackedOnly) {
          // The row no longer matches the tracked-only filter — leaving it
          // would show an untracked row (and a stale count) in a tracked list.
          setItems((cur) => (cur === null ? cur : cur.filter((it) => it.id !== id)));
          setTotal((t) => Math.max(0, t - 1));
        } else {
          setItems((cur) => (cur === null ? cur : cur.map((it) => (it.id === id ? updated : it))));
        }
        // Regrouping and within-group order are the server's call.
        if (groupsRef.current !== null) void refreshTracker();
      } catch (e) {
        const unpatch = (it: InternshipItem): InternshipItem =>
          it.id === id ? { ...it, application: prevApp } : it;
        setItems((cur) => (cur === null ? cur : cur.map(unpatch)));
        // The optimistic regroup may have dropped the row from the tracker
        // entirely (untrack), so refetch it — the PUT failed, the server
        // still holds the pre-click truth.
        if (groupsRef.current !== null) void refreshTracker();
        setError(e instanceof Error ? e.message : 'Could not update that application.');
      }
    },
    [refreshTracker, filters.trackedOnly],
  );

  /** Notes persist on textarea blur — status stays whatever it already is. */
  const saveNotes = useCallback(
    async (id: string, notes: string | null) => {
      const find = (list: InternshipItem[] | null) => list?.find((it) => it.id === id);
      const current =
        find(itemsRef.current) ?? find(groupsRef.current?.flatMap((g) => g.items) ?? null);
      const app = current?.application;
      if (!app) return;
      try {
        const updated = await setInternshipApplication(id, app.status, notes);
        setItems((cur) => (cur === null ? cur : cur.map((it) => (it.id === id ? updated : it))));
        setGroups((cur) =>
          cur === null
            ? cur
            : cur.map((g) => ({
                ...g,
                items: g.items.map((it) => (it.id === id ? updated : it)),
              })),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not save the note.');
      }
    },
    [],
  );

  const loadMore = useCallback(async () => {
    const cur = itemsRef.current;
    if (cur === null || loadingMore) return;
    setLoadingMore(true);
    const gen = fetchGen.current;
    try {
      const res = await listInternships({
        q: debouncedQ || undefined,
        category: filters.category || undefined,
        term: filters.term || undefined,
        trackedOnly: filters.trackedOnly || undefined,
        activeOnly: filters.includeClosed ? false : undefined,
        limit: PAGE,
        offset: cur.length,
      });
      // A page-0 refetch (sync finished, filter changed, assistant applied
      // something) superseded this request — appending would duplicate rows
      // from a different dataset.
      if (gen !== fetchGen.current) return;
      setItems((prev) => (prev === null ? res.items : [...prev, ...res.items]));
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load more.');
    } finally {
      setLoadingMore(false);
    }
  }, [debouncedQ, filters.category, filters.term, filters.trackedOnly, filters.includeClosed, loadingMore]);

  const hasFilters =
    debouncedQ !== '' || filters.category !== '' || filters.term !== '' || filters.trackedOnly;

  return (
    <main className="max-w-2xl px-6 pb-16 pt-4 md:px-10">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="t-display">Internships</h1>
        <span className="flex items-baseline gap-3">
          <span className="t-label text-ink-soft">
            {syncing ? 'Syncing…' : lastSynced ? `Synced ${timeAgo(lastSynced)}` : 'Not synced yet'}
          </span>
          <Button variant="secondary" disabled={syncing} onClick={() => void runSync(true)}>
            Refresh
          </Button>
        </span>
      </header>

      <div className="mt-4 flex gap-2" role="group" aria-label="View">
        {(['feed', 'tracker'] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => setView(v)}
            style={{
              transition: 'background-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease)',
            }}
            className={clsx(
              't-label h-9 rounded-r border border-rule px-4',
              view === v ? 'bg-recessed text-ink-lock shadow-inset-pin' : 'bg-paper text-ink-soft',
            )}
          >
            {v === 'feed' ? 'Feed' : 'Tracker'}
          </button>
        ))}
      </div>

      {error && <p className="t-label mt-3 text-ink-soft">{error}</p>}

      {view === 'feed' ? (
        <>
          <FilterBar
            filters={filters}
            facets={facets}
            onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
          />

          {items === null && (
            <p className="t-label mise-dot mt-8 text-ink-soft" aria-hidden="true">
              ●
            </p>
          )}

          {items !== null && items.length === 0 && !hasFilters && (
            <div className="mt-8">
              <p className="t-label text-ink-soft">
                The board pulls SWE, ML, and quant internship listings from the community
                aggregator repos and keeps them current. Load it once; after that a sync only
                downloads when something upstream actually changed.
              </p>
              <Button
                variant="primary"
                className="mt-3"
                disabled={syncing}
                onClick={() => void runSync()}
              >
                {syncing ? 'Loading…' : 'Load internships'}
              </Button>
            </div>
          )}

          {items !== null && items.length === 0 && hasFilters && (
            <p className="t-label mt-8 text-ink-soft">Nothing matches those filters.</p>
          )}

          {items !== null && items.length > 0 && (
            <>
              <p className="t-time mt-4 text-ink-soft">
                {total} role{total === 1 ? '' : 's'}
              </p>
              <ul className="mt-1">
                {items.map((it) => (
                  <InternshipRow
                    key={it.id}
                    item={it}
                    onStatus={(id, s) => void changeStatus(id, s)}
                    onNotes={(id, n) => void saveNotes(id, n)}
                  />
                ))}
              </ul>
              {items.length < total && (
                <div className="mt-4 flex items-baseline gap-3">
                  <Button variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </Button>
                  <span className="t-time text-ink-soft">
                    {items.length} of {total}
                  </span>
                </div>
              )}
            </>
          )}
        </>
      ) : (
        <TrackerView groups={groups} onStatus={(id, s) => void changeStatus(id, s)} />
      )}
    </main>
  );
}
