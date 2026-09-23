'use client';

/**
 * The feed's filter bar: search (the page debounces it), category and term
 * selects fed by the API's facets, and two toggle chips. Native <select>s on
 * purpose — the design bans building a <Menu>, and the browser control is not
 * one. Chips use the meals-page language: recessed when on, paper when off.
 *
 * Controlled entirely by the parent — this component holds no state, it just
 * reports patches.
 */
import { clsx } from 'clsx';

export interface FeedFilters {
  q: string;
  category: string;
  term: string;
  trackedOnly: boolean;
  includeClosed: boolean;
}

export interface Facets {
  categories: string[];
  terms: string[];
}

function ToggleChip({ on, label, onToggle }: { on: boolean; label: string; onToggle(): void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      style={{ transition: 'background-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease)' }}
      className={clsx(
        't-label h-9 shrink-0 rounded-r border border-rule px-3',
        on ? 'bg-recessed text-ink-lock shadow-inset-pin' : 'bg-paper text-ink-soft',
      )}
    >
      {label}
    </button>
  );
}

export function FilterBar({
  filters,
  facets,
  onChange,
}: {
  filters: FeedFilters;
  facets: Facets;
  onChange(patch: Partial<FeedFilters>): void;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <input
        type="search"
        value={filters.q}
        placeholder="Search company or title"
        aria-label="Search internships"
        onChange={(e) => onChange({ q: e.target.value })}
        className="t-label h-9 w-full min-w-0 rounded-r border border-rule bg-paper px-3 text-ink placeholder:text-ink-soft sm:w-56"
      />
      <select
        value={filters.category}
        aria-label="Category"
        onChange={(e) => onChange({ category: e.target.value })}
        className="t-label h-9 max-w-40 rounded-r border border-rule bg-paper px-2 text-ink"
      >
        <option value="">All categories</option>
        {/* Keep a stale selection visible instead of a blank control. */}
        {filters.category && !facets.categories.includes(filters.category) && (
          <option value={filters.category}>{filters.category}</option>
        )}
        {facets.categories.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <select
        value={filters.term}
        aria-label="Term"
        onChange={(e) => onChange({ term: e.target.value })}
        className="t-label h-9 max-w-40 rounded-r border border-rule bg-paper px-2 text-ink"
      >
        <option value="">All terms</option>
        {filters.term && !facets.terms.includes(filters.term) && (
          <option value={filters.term}>{filters.term}</option>
        )}
        {facets.terms.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <ToggleChip
        on={filters.trackedOnly}
        label="Tracked only"
        onToggle={() => onChange({ trackedOnly: !filters.trackedOnly })}
      />
      <ToggleChip
        on={filters.includeClosed}
        label="Include closed"
        onToggle={() => onChange({ includeClosed: !filters.includeClosed })}
      />
    </div>
  );
}

export default FilterBar;
