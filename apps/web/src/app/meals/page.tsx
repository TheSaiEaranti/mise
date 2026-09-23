'use client';

/**
 * Meals — everything the AI has imported from pasted recipes. No import UI
 * here on purpose: Sai pastes a recipe into chat and import_meals projects it
 * onto this screen. The ingredient lines under each meal ARE the shopping
 * list; suites (breakfast + lunch pairings) are what a cook block on the week
 * grid gets assigned.
 *
 * Suites can be made two ways — by telling the assistant ("make a suite of the
 * oats and the bowls") or by hand here (New suite → pick a breakfast, pick a
 * lunch). Either way a suite only POINTS at its meals: the individual meals
 * always stay listed below, and deleting a suite never deletes a meal.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import {
  createSuite,
  deleteMeal,
  deleteSuite,
  getMeals,
  type Meal,
  type SuiteWithNames,
} from '@/lib/api';
import { useApp } from '@/lib/store';
import { Button } from '@/components/ui/button';

/** The raw text of a meal's `Covers: …` details line, parenthetical
 *  attributions kept ("magnesium (chia/flax)"). Imported meals carry one;
 *  hand-pasted ones may not — null then, never a guess. */
function coversTextOf(meal: Meal | undefined): string | null {
  const line = meal?.details
    .split('\n')
    .find((l) => l.trim().toLowerCase().startsWith('covers:'));
  if (!line) return null;
  const text = line.slice(line.indexOf(':') + 1).trim();
  return text || null;
}

/** A meal's Covers line split into items. */
function coversOf(meal: Meal | undefined): string[] {
  const text = coversTextOf(meal);
  if (!text) return [];
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A meal's `Macros: ~Xg protein · ~Y kcal` details line, parsed. */
function macrosOf(meal: Meal | undefined): { protein: number; kcal: number } | null {
  const line = meal?.details
    .split('\n')
    .find((l) => l.trim().toLowerCase().startsWith('macros:'));
  const m = line?.match(/~?(\d+)\s*g\s*protein\s*·\s*~?([\d,]+)\s*kcal/i);
  if (!m) return null;
  return { protein: Number(m[1]), kcal: Number(m[2].replace(/,/g, '')) };
}

/** A suite's combined Covers summary — its two meals' lists, deduped. When
 *  only ONE member meal has a Covers line the label says which — "Covers
 *  (lunch)" — instead of implying the pair was assessed. */
function suiteCovers(
  suite: SuiteWithNames,
  mealsById: Map<string, Meal>,
): { label: string; text: string } | null {
  const b = coversOf(mealsById.get(suite.breakfast_meal_id));
  const l = coversOf(mealsById.get(suite.lunch_meal_id));
  if (b.length === 0 && l.length === 0) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...b, ...l]) {
    // Canonical nutrient key where one applies, so "vitamin C (blueberries)"
    // and a bare "C" collapse to one entry (first-seen attribution text wins).
    const key = nutrientKeyOf(item) ?? item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  const label =
    b.length > 0 && l.length > 0 ? 'Covers' : b.length > 0 ? 'Covers (breakfast)' : 'Covers (lunch)';
  return { label, text: out.join(', ') };
}

// ---------------------------------------------------------------------------
// Daily targets & coverage — Sai's sheet, verbatim, and how a suite meets it.
// Everything below the constants is derived at render from the meals' details
// lines. No schema, no API, no new deps.
// ---------------------------------------------------------------------------

/** His full daily target sheet — his numbers AND his parentheticals ("most
 *  important, aim daily for muscle"). It's his sheet, not a generic RDA table. */
const TARGET_GROUPS: { title: string; rows: string[] }[] = [
  {
    title: 'Macros (the ones to hit consistently)',
    rows: [
      'Protein — ~150g (most important, aim daily for muscle)',
      'Calories — ~2,200–2,400 (2,200 recomp/lean-face, 2,400 if gaining)',
      'Carbs — ~220–250g',
      'Fat — ~60–70g',
    ],
  },
  {
    title: 'Vitamins',
    rows: [
      'Vitamin A — 900 mcg',
      'Vitamin C — 90 mg',
      'Vitamin D — 600 IU (15 mcg)',
      'Vitamin E — 15 mg',
      'Vitamin K — 120 mcg',
      'Vitamin B12 — 2.4 mcg',
      'Folate — 400 mcg',
      'Thiamin (B1) — 1.2 mg',
      'Riboflavin (B2) — 1.3 mg',
      'Niacin (B3) — 16 mg',
      'B6 — 1.3 mg',
    ],
  },
  {
    title: 'Key minerals',
    rows: [
      'Iron — 8 mg',
      'Zinc — 11 mg',
      'Calcium — 1,000 mg',
      'Magnesium — 400 mg',
      'Potassium — 3,400 mg',
    ],
  },
];

/** The parts of his plan that aren't meal rows in the DB — dinner and the
 *  supplement stack, verbatim from his sheet. Plan constants, always shown. */
const STANDING_LINES = [
  { name: 'eggs + veg dinner', covers: 'B12, more protein, choline' },
  { name: 'supplements', covers: 'D3 (covers the 600 IU easily), omega-3, B12 backup' },
] as const;

const PROTEIN_TARGET_G = 150;
/** Midpoint of his 2,200–2,400 band — the "~" on the combo line owns the spread. */
const KCAL_TARGET_MID = 2300;

/** The tail of the combo line, clamped at zero — an unusually heavy pairing
 *  reads "target already met" instead of leaving a negative remainder. */
function comboLeaves(combo: { protein: number; kcal: number }): string {
  const protein = Math.max(0, PROTEIN_TARGET_G - combo.protein);
  const kcal = Math.max(0, KCAL_TARGET_MID - combo.kcal);
  if (protein === 0 && kcal === 0) return 'protein and calorie targets already met';
  if (protein === 0) return `protein target already met — leaves ~${kcal} kcal for dinner + snacks`;
  if (kcal === 0) return `calorie target already met — leaves ~${protein}g protein for dinner + snacks`;
  return `leaves ~${protein}g protein and ~${kcal} kcal for dinner + snacks`;
}

/** The gap check's vocabulary: each target micronutrient with the keywords a
 *  Covers line may use for it (case-insensitive; folate=B9; D3 counts as D).
 *  Macros are scored by the combo arithmetic line, not here. Omega-3 isn't on
 *  his target sheet — and the supplements line always names it — so it can
 *  never surface as a gap. */
const TARGET_NUTRIENTS: { label: string; keys: string[] }[] = [
  { label: 'vitamin A', keys: ['vitamin a', 'a'] },
  { label: 'vitamin C', keys: ['vitamin c', 'c'] },
  { label: 'vitamin D', keys: ['vitamin d', 'd', 'd3'] },
  { label: 'vitamin E', keys: ['vitamin e', 'e'] },
  { label: 'vitamin K', keys: ['vitamin k', 'k'] },
  { label: 'B12', keys: ['b12', 'vitamin b12'] },
  { label: 'folate', keys: ['folate', 'b9', 'folic acid'] },
  { label: 'thiamin (B1)', keys: ['b1', 'thiamin', 'thiamine'] },
  { label: 'riboflavin (B2)', keys: ['b2', 'riboflavin'] },
  { label: 'niacin (B3)', keys: ['b3', 'niacin'] },
  { label: 'B6', keys: ['b6', 'vitamin b6'] },
  { label: 'iron', keys: ['iron'] },
  { label: 'zinc', keys: ['zinc'] },
  { label: 'calcium', keys: ['calcium'] },
  { label: 'magnesium', keys: ['magnesium'] },
  { label: 'potassium', keys: ['potassium'] },
];

/** A Covers text as normalized tokens: comma items, "K and folate" compounds
 *  unpacked, parenthetical attributions dropped for matching purposes. */
function coverageTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .split(/,|\band\b/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Whether a normalized Covers token names this nutrient key. Single-letter
 *  keys ("C", "K") must be the whole token so prose can't false-positive;
 *  longer keys may sit inside one ("B12 backup" still covers B12). */
function tokenNamesKey(token: string, key: string): boolean {
  return key.length === 1 ? token === key : token === key || new RegExp(`\\b${key}\\b`).test(token);
}

/** Targets that NONE of the given Covers texts name. */
function coverageGaps(coversTexts: string[]): string[] {
  const tokens = coversTexts.flatMap(coverageTokens);
  return TARGET_NUTRIENTS.filter(
    ({ keys }) => !tokens.some((t) => keys.some((k) => tokenNamesKey(t, k))),
  ).map((n) => n.label);
}

/** The single target nutrient a Covers item names, if exactly one — the suite
 *  rows' dedup key, so "vitamin C (blueberries)" and a bare "C" collapse
 *  together. Compound items ("K and folate") keep their literal text key. */
function nutrientKeyOf(item: string): string | null {
  const tokens = coverageTokens(item);
  const hits = TARGET_NUTRIENTS.filter(({ keys }) =>
    tokens.some((t) => keys.some((k) => tokenNamesKey(t, k))),
  );
  return hits.length === 1 ? hits[0].label : null;
}

/** Collapsible-section open state, kept in sessionStorage so navigating away
 *  and back doesn't reset it. First visit uses `firstVisit`; storage is read
 *  after mount so the server render always matches. */
function usePersistedOpen(key: string, firstVisit: boolean) {
  const [open, setOpen] = useState(firstVisit);
  useEffect(() => {
    const saved = sessionStorage.getItem(key);
    if (saved !== null) setOpen(saved === '1');
  }, [key]);
  const toggle = useCallback(() => {
    setOpen((o) => {
      sessionStorage.setItem(key, o ? '0' : '1');
      return !o;
    });
  }, [key]);
  return [open, toggle] as const;
}

function TypeBadge({ type }: { type: Meal['meal_type'] }) {
  return <span className="t-micro text-ink-soft">{type === 'breakfast' ? 'Breakfast' : 'Lunch'}</span>;
}

function MealCard({ meal, onDelete }: { meal: Meal; onDelete(id: string): void }) {
  return (
    <li className="border-b border-rule py-4">
      <div className="flex items-baseline justify-between gap-4">
        <span className="t-label text-ink">{meal.name}</span>
        <span className="flex items-center gap-3">
          <TypeBadge type={meal.meal_type} />
          <button
            type="button"
            aria-label={`Delete ${meal.name}`}
            onClick={() => onDelete(meal.id)}
            className="t-micro text-ink-soft hover:text-ink"
            style={{ transition: 'color var(--fast) var(--ease)' }}
          >
            Delete
          </button>
        </span>
      </div>
      <ul className="mt-2 space-y-0.5">
        {meal.ingredients.map((line, i) => (
          <li key={i} className="t-label text-ink-soft">
            {line}
          </li>
        ))}
      </ul>
      {meal.details && <p className="t-label mt-2 whitespace-pre-wrap text-ink-soft">{meal.details}</p>}
    </li>
  );
}

/** Disclosure chevron for the collapsible meal sections — right when closed,
 *  down when open. Same stroke language as the week arrows on the home page. */
function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {open ? <path d="M3 6l5 5 5-5" /> : <path d="M6 3l5 5-5 5" />}
    </svg>
  );
}

/** The headline panel: his daily target sheet, then how a chosen suite's two
 *  meals cover it — each meal's Covers line, the standing dinner/supplement
 *  lines, the combo-macros arithmetic, and what's still light. */
function CoveragePanel({
  suites,
  mealsById,
}: {
  suites: SuiteWithNames[];
  mealsById: Map<string, Meal>;
}) {
  const [open, toggle] = usePersistedOpen('mise.meals.open.daily-targets', true);
  const [suiteId, setSuiteId] = useState<string | null>(null);
  // Falls back to the first suite when nothing is chosen — or when the chosen
  // suite was deleted underneath the dropdown.
  const suite = suites.find((s) => s.id === suiteId) ?? suites[0];
  const breakfast = suite ? mealsById.get(suite.breakfast_meal_id) : undefined;
  const lunch = suite ? mealsById.get(suite.lunch_meal_id) : undefined;

  const bCovers = coversTextOf(breakfast);
  const lCovers = coversTextOf(lunch);
  const bMacros = macrosOf(breakfast);
  const lMacros = macrosOf(lunch);
  // Both meals must carry a Macros line — a half-summed combo would lie.
  const combo =
    bMacros && lMacros
      ? { protein: bMacros.protein + lMacros.protein, kcal: bMacros.kcal + lMacros.kcal }
      : null;
  const gaps = useMemo(
    () => coverageGaps([bCovers ?? '', lCovers ?? '', ...STANDING_LINES.map((s) => s.covers)]),
    [bCovers, lCovers],
  );

  return (
    <section className="mt-8">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        style={{ transition: 'color var(--fast) var(--ease)' }}
        className={clsx(
          'flex w-full items-center justify-between gap-4 pb-2 text-ink-soft hover:text-ink',
          !open && 'border-b border-rule',
        )}
      >
        <span className="t-micro">Daily targets</span>
        <DisclosureChevron open={open} />
      </button>
      {open && (
        <div className="border-t border-rule pt-4">
          <div className="grid gap-x-6 gap-y-5 sm:grid-cols-3">
            {TARGET_GROUPS.map((g) => (
              <div key={g.title}>
                <h3 className="t-micro text-ink-soft">{g.title}</h3>
                <ul className="mt-1.5 space-y-0.5">
                  {g.rows.map((row) => (
                    <li key={row} className="t-label text-ink">
                      {row}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {suite && (
            <div className="mt-6">
              <h3 className="t-micro text-ink-soft">How your combinations cover them</h3>
              <select
                value={suite.id}
                aria-label="Suite"
                onChange={(e) => setSuiteId(e.target.value || null)}
                className="t-label mt-1 h-11 w-full min-w-0 rounded-r border border-rule bg-paper px-2 text-ink"
              >
                {suites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <ul className="mt-3 space-y-1">
                <li className="t-label text-ink">
                  {breakfast?.name ?? suite.breakfast_name} → {bCovers ?? '—'}
                </li>
                <li className="t-label text-ink">
                  {lunch?.name ?? suite.lunch_name} → {lCovers ?? '—'}
                </li>
                {STANDING_LINES.map((line) => (
                  <li key={line.name} className="t-label text-ink-soft">
                    {line.name} → {line.covers}
                  </li>
                ))}
              </ul>
              {combo && (
                <p className="t-label mt-3 text-ink">
                  this combo: ~{combo.protein}g protein · ~{combo.kcal} kcal — {comboLeaves(combo)}
                </p>
              )}
              {gaps.length > 0 && (
                <p className="t-micro mt-2 text-ink-soft">
                  Light today: {gaps.join(', ')} — pick a combo covering them tomorrow
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** A collapsible list section ("Breakfasts · 7"). Closed by default — with
 *  sixteen meals the flat lists drowned the page. Suites stays open above:
 *  suites are what the week grid assigns, the meal lists are reference. */
function MealSection({
  title,
  meals,
  onDelete,
}: {
  title: string;
  meals: Meal[];
  onDelete(id: string): void;
}) {
  const [open, toggle] = usePersistedOpen(`mise.meals.open.${title}`, false);
  return (
    <section className="mt-10">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        style={{ transition: 'color var(--fast) var(--ease)' }}
        className={clsx(
          'flex w-full items-center justify-between gap-4 pb-2 text-ink-soft hover:text-ink',
          !open && 'border-b border-rule',
        )}
      >
        <span className="t-micro">
          {title} · {meals.length}
        </span>
        <DisclosureChevron open={open} />
      </button>
      {open && (
        <ul className="border-t border-rule">
          {meals.map((m) => (
            <MealCard key={m.id} meal={m} onDelete={onDelete} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Native <select> over a meal list — the browser control, not a built <Menu>,
 *  same precedent as the internships filter bar. */
function MealSelect({
  label,
  value,
  meals,
  onChange,
}: {
  label: string;
  value: string | null;
  meals: Meal[];
  onChange(id: string | null): void;
}) {
  return (
    <select
      value={value ?? ''}
      aria-label={label}
      onChange={(e) => onChange(e.target.value || null)}
      className="t-label mt-1 h-11 w-full min-w-0 rounded-r border border-rule bg-paper px-2 text-ink"
    >
      <option value="">Choose a {label.toLowerCase()}…</option>
      {meals.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </select>
  );
}

function NewSuiteForm({
  breakfasts,
  lunches,
  onCreated,
  onClose,
}: {
  breakfasts: Meal[];
  lunches: Meal[];
  onCreated(): void;
  onClose(): void;
}) {
  const [breakfastId, setBreakfastId] = useState<string | null>(null);
  const [lunchId, setLunchId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A meal deleted while the form is open would leave its id selected but
  // dangling — reset to null so Create can't submit a dead id.
  useEffect(() => {
    if (breakfastId && !breakfasts.some((m) => m.id === breakfastId)) setBreakfastId(null);
  }, [breakfastId, breakfasts]);
  useEffect(() => {
    if (lunchId && !lunches.some((m) => m.id === lunchId)) setLunchId(null);
  }, [lunchId, lunches]);

  const b = breakfasts.find((m) => m.id === breakfastId);
  const l = lunches.find((m) => m.id === lunchId);
  const placeholder = b && l ? `${b.name} + ${l.name}` : 'Name (optional)';

  const create = useCallback(async () => {
    if (!breakfastId || !lunchId || saving) return;
    setSaving(true);
    setError(null);
    try {
      await createSuite({ breakfast_meal_id: breakfastId, lunch_meal_id: lunchId, name: name.trim() || undefined });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the suite.');
      setSaving(false);
    }
  }, [breakfastId, lunchId, name, saving, onCreated]);

  return (
    <div className="mt-3 rounded-r border border-rule bg-paper p-4">
      <p className="t-micro text-ink-soft">Breakfast</p>
      <MealSelect label="Breakfast" value={breakfastId} meals={breakfasts} onChange={setBreakfastId} />
      <p className="t-micro mt-3 text-ink-soft">Lunch</p>
      <MealSelect label="Lunch" value={lunchId} meals={lunches} onChange={setLunchId} />
      <div className="mt-3 flex items-center gap-2">
        <input
          value={name}
          maxLength={80}
          placeholder={placeholder}
          aria-label="Suite name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
          }}
          className="t-label h-11 w-full min-w-0 rounded-r border border-rule bg-paper px-3 text-ink placeholder:text-ink-soft"
        />
        <Button variant="primary" disabled={!breakfastId || !lunchId || saving} onClick={() => void create()}>
          {saving ? 'Creating…' : 'Create'}
        </Button>
        <Button variant="ghost" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
      </div>
      {error && <p className="t-label pt-2 text-ink-soft">{error}</p>}
      <p className="t-micro pt-2 text-ink-soft">The meals stay listed below — a suite is just a pairing.</p>
    </div>
  );
}

export default function MealsPage() {
  const { scheduleVersion, bumpSchedule } = useApp();
  const [meals, setMeals] = useState<Meal[] | null>(null);
  const [suites, setSuites] = useState<SuiteWithNames[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [suiteFormOpen, setSuiteFormOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await getMeals();
        if (alive) {
          setMeals(res.meals);
          setSuites(res.suites);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [scheduleVersion]);

  // Both deletes route failures into the page's error line (a double-delete
  // 404s) — the refetch on success clears it again.
  const removeMeal = useCallback(
    async (id: string) => {
      try {
        await deleteMeal(id);
        bumpSchedule(); // suites/assignments may have cascaded — refetch everything
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [bumpSchedule],
  );

  const removeSuite = useCallback(
    async (id: string) => {
      try {
        await deleteSuite(id);
        bumpSchedule();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [bumpSchedule],
  );

  const breakfasts = (meals ?? []).filter((m) => m.meal_type === 'breakfast');
  const lunches = (meals ?? []).filter((m) => m.meal_type === 'lunch');
  const mealsById = new Map((meals ?? []).map((m) => [m.id, m]));
  const canPair = breakfasts.length > 0 && lunches.length > 0;

  return (
    <main className="max-w-xl px-6 pb-16 pt-4 md:px-10">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4">
        <h1 className="t-display">Meals</h1>
      </header>

      {error && <p className="t-label mt-4 text-ink-soft">{error}</p>}

      {meals !== null && meals.length === 0 && (
        <p className="t-label mt-8 text-ink-soft">
          No meals yet. Paste a recipe to the assistant — it lands here with its ingredients, ready
          for shopping.
        </p>
      )}

      {meals !== null && <CoveragePanel suites={suites} mealsById={mealsById} />}

      {(suites.length > 0 || canPair) && (
        <section className="mt-8">
          <div className="flex items-center justify-between gap-4">
            <h2 className="t-micro text-ink-soft">Suites</h2>
            {canPair && (
              <Button
                variant={suiteFormOpen ? 'ghost' : 'secondary'}
                onClick={() => setSuiteFormOpen((o) => !o)}
              >
                {suiteFormOpen ? 'Close' : 'New suite'}
              </Button>
            )}
          </div>

          {suiteFormOpen && (
            <NewSuiteForm
              breakfasts={breakfasts}
              lunches={lunches}
              onCreated={() => {
                setSuiteFormOpen(false);
                bumpSchedule();
              }}
              onClose={() => setSuiteFormOpen(false)}
            />
          )}

          {suites.length === 0 && !suiteFormOpen && (
            <p className="t-label mt-2 text-ink-soft">
              No suites yet — pair a breakfast with a lunch here, or ask the assistant.
            </p>
          )}
          <ul>
            {suites.map((s) => {
              const covers = suiteCovers(s, mealsById);
              return (
                <li key={s.id} className="border-b border-rule py-3">
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="t-label text-ink">{s.name}</span>
                    <span className="flex items-center gap-3">
                      <span className="t-micro text-ink-soft">
                        {s.breakfast_name} + {s.lunch_name}
                      </span>
                      <button
                        type="button"
                        aria-label={`Delete suite ${s.name}`}
                        onClick={() => void removeSuite(s.id)}
                        className="t-micro text-ink-soft hover:text-ink"
                        style={{ transition: 'color var(--fast) var(--ease)' }}
                      >
                        Delete
                      </button>
                    </span>
                  </div>
                  {covers && (
                    <p className="t-micro mt-1 text-ink-soft">
                      {covers.label}: {covers.text}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {breakfasts.length > 0 && (
        <MealSection title="Breakfasts" meals={breakfasts} onDelete={(id) => void removeMeal(id)} />
      )}

      {lunches.length > 0 && (
        <MealSection title="Lunches" meals={lunches} onDelete={(id) => void removeMeal(id)} />
      )}
    </main>
  );
}
