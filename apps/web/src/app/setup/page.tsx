'use client';

/**
 * Onboarding wizard (SPEC §10 Phase 1) — one page, four steps revealed as a
 * single vertical flow. No routes, no progress bar: the page grows, and back
 * is scrolling up and changing the answer.
 *
 * I2 applies here too: "Create semester" writes the settings overlay, then
 * runs setup_semester DRY through POST /api/semester/proposal and renders the
 * diff for approval. Editing any answer after the proposal exists rejects it —
 * the diff you approve is always the diff you created.
 *
 * The meal-pattern defaults come from GET /api/settings effective values, not
 * from hardcoded answers (hardcoding lives in config/constraints.ts only).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DATE_RE, DEFAULT_TZ } from '@mise/core/time';
import {
  getProposal,
  getSemester,
  getSettings,
  postSemesterProposal,
  putSettings,
  type ProposalRow,
} from '@/lib/api';
import { useApp } from '@/lib/store';
import { Button } from '@/components/ui/button';
import { Field, Group, RadioRows, Stepper, ToggleRow, inputCls } from '@/components/setup/fields';
import { ClassEditor, ClassRow, type ClassInput } from '@/components/setup/class-list';
import { ImportSchedule } from '@/components/setup/import-schedule';
import { SetupReviewCard } from '@/components/setup/review-card';

type MealMode = 'batch' | 'cook' | 'out';
type MealName = 'breakfast' | 'lunch' | 'dinner';
const MEALS: MealName[] = ['breakfast', 'lunch', 'dinner'];
const MEAL_LABEL: Record<MealName, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };

interface Defaults {
  cadence_days: number;
  gym_target: number;
  meals: Record<MealName, MealMode>;
}

/** Parse the effective constraints the API reports. The ?? fallbacks mirror
 *  config/constraints.ts and only apply when the API was unreachable. */
function parseEffective(e: Record<string, unknown>): Defaults {
  const cook = (e['cook'] ?? {}) as { cadence_days?: number };
  const gym = (e['gym'] ?? {}) as { target_per_week?: number };
  const meals = (e['meals'] ?? {}) as Partial<Record<MealName, MealMode>>;
  return {
    cadence_days: cook.cadence_days ?? 2,
    gym_target: gym.target_per_week ?? 4,
    meals: {
      breakfast: meals.breakfast ?? 'batch',
      lunch: meals.lunch ?? 'cook',
      dinner: meals.dinner ?? 'out',
    },
  };
}

const CADENCE_OPTIONS = [
  { value: 1, label: 'Every day' },
  { value: 2, label: 'Every other day' },
  { value: 3, label: 'Twice a week' },
] as const;
type Cadence = (typeof CADENCE_OPTIONS)[number]['value'];

/** daily ⇒ each cook covers 1 lunch; every other day ⇒ 2; twice a week ⇒ 3. */
const COVERS: Record<Cadence, number> = { 1: 1, 2: 2, 3: 3 };

function cadenceFromDays(days: number): Cadence {
  return days <= 1 ? 1 : days === 2 ? 2 : 3;
}

const APPROVE_NOTICE: Record<string, string> = {
  needs_review: 'The schedule changed underneath this proposal — conflicts were re-checked. Review and approve again.',
  blocked: 'A blocking conflict appeared — this proposal cannot be applied.',
  expired: 'This proposal expired. Go back and create it again.',
};

export default function SetupPage() {
  const router = useRouter();
  const { approve, reject } = useApp();

  const [gate, setGate] = useState<'checking' | 'open' | 'exists'>('checking');
  const [revealed, setRevealed] = useState(1);

  // Step 1 — semester
  const [name, setName] = useState('Fall 2026');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Step 2 — classes
  const [classes, setClasses] = useState<ClassInput[]>([]);

  // Step 3 — the meal-pattern question, seeded from effective settings
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [cadence, setCadence] = useState<Cadence | null>(null);
  const [mealsOut, setMealsOut] = useState<Record<MealName, boolean> | null>(null);
  const [gymPerWeek, setGymPerWeek] = useState<number | null>(null);

  // Step 4 — review & approve
  const [proposal, setProposal] = useState<ProposalRow | null>(null);
  const [createdSnap, setCreatedSnap] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    getSemester()
      .then((res) => setGate(res.semester ? 'exists' : 'open'))
      .catch((e) => {
        console.warn('[setup] semester check failed', e);
        setGate('open');
      });
  }, []);

  const seed = useCallback((d: Defaults) => {
    setDefaults(d);
    setCadence((prev) => prev ?? cadenceFromDays(d.cadence_days));
    setGymPerWeek((prev) => prev ?? Math.min(7, Math.max(0, d.gym_target)));
    setMealsOut(
      (prev) =>
        prev ?? {
          breakfast: d.meals.breakfast === 'out',
          lunch: d.meals.lunch === 'out',
          dinner: d.meals.dinner === 'out',
        },
    );
  }, []);

  useEffect(() => {
    getSettings()
      .then((res) => seed(parseEffective(res.effective)))
      .catch((e) => {
        console.warn('[setup] settings fetch failed', e);
        seed(parseEffective({}));
      });
  }, [seed]);

  const snapshot = useMemo(
    () => JSON.stringify({ name, startDate, endDate, classes, cadence, mealsOut, gymPerWeek }),
    [name, startDate, endDate, classes, cadence, mealsOut, gymPerWeek],
  );

  // I2 hygiene: any edit after the proposal exists rejects it.
  useEffect(() => {
    if (!proposal || snapshot === createdSnap) return;
    const staleId = proposal.id;
    setProposal(null);
    setCreatedSnap(null);
    setNotice(null);
    reject(staleId).catch((e) => console.warn('[setup] stale proposal reject failed', e));
  }, [snapshot, createdSnap, proposal, reject]);

  const step1Valid =
    name.trim().length > 0 && DATE_RE.test(startDate) && DATE_RE.test(endDate) && startDate < endDate;
  const step2Valid = classes.length > 0;
  const step3Valid = cadence !== null && mealsOut !== null && gymPerWeek !== null;

  /** What turning a meal's "out" toggle OFF means: the effective default, or
   *  cooked when the default itself is eating out. */
  const offMode = useCallback(
    (m: MealName): MealMode => {
      const def = defaults?.meals[m] ?? 'cook';
      return def === 'out' ? 'cook' : def;
    },
    [defaults],
  );

  const handleCreate = async () => {
    if (busy || !step1Valid || classes.length === 0) return;
    if (cadence === null || mealsOut === null || gymPerWeek === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const modeFor = (m: MealName): MealMode => (mealsOut[m] ? 'out' : offMode(m));
    try {
      await putSettings({
        cook_cadence_days: cadence,
        covers_next_lunches: COVERS[cadence],
        gym_target_per_week: gymPerWeek,
        meals: {
          breakfast: modeFor('breakfast'),
          lunch: modeFor('lunch'),
          dinner: modeFor('dinner'),
        },
        onboarded: true,
      });
      const res = await postSemesterProposal({
        name: name.trim(),
        start_date: startDate,
        end_date: endDate,
        timezone: DEFAULT_TZ,
        classes,
      });
      setProposal(res.proposal);
      setCreatedSnap(snapshot);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the semester proposal.');
    } finally {
      setBusy(false);
    }
  };

  const handleApprove = async () => {
    if (!proposal || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { status } = await approve(proposal.id);
      if (status === 'applied') {
        router.push('/');
        return;
      }
      // The row was re-derived server-side; show the fresh conflicts.
      const fresh = await getProposal(proposal.id).catch(() => null);
      if (fresh) setProposal(fresh.proposal);
      setNotice(APPROVE_NOTICE[status] ?? 'Could not apply the proposal.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approve failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleBack = () => {
    if (!proposal) return;
    const id = proposal.id;
    setProposal(null);
    setCreatedSnap(null);
    setNotice(null);
    setError(null);
    reject(id).catch((e) => console.warn('[setup] reject failed', e));
  };

  if (gate === 'checking') {
    return <main className="px-6 pt-10 md:px-10" />;
  }

  if (gate === 'exists') {
    return (
      <main className="mx-auto w-full max-w-xl px-6 pt-16 md:px-10">
        <p className="t-body text-ink-soft">Semester already set up.</p>
        <Link
          href="/"
          className="t-label mt-4 -ml-4 inline-flex h-11 items-center rounded-r px-4 text-ink hover:bg-recessed"
        >
          Go to the week
        </Link>
      </main>
    );
  }

  const cadenceLabel = CADENCE_OPTIONS.find((o) => o.value === cadence)?.label ?? '';
  const outMeals = MEALS.filter((m) => mealsOut?.[m]);

  return (
    <main className="mx-auto w-full max-w-xl px-6 pb-16 pt-10 md:px-10">
      <h1 className="t-display text-ink">Set up your semester</h1>

      {/* Step 1 — semester */}
      <section className="mt-10">
        <div className="flex flex-col gap-3">
          <Field label="Name">
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Fall 2026"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts">
              <input
                type="date"
                className={`${inputCls} font-num`}
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </Field>
            <Field label="Ends">
              <input
                type="date"
                className={`${inputCls} font-num`}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </Field>
          </div>
          <Group label="Timezone">
            <p className="t-label flex h-11 items-center text-ink">{DEFAULT_TZ}</p>
          </Group>
        </div>
        {revealed === 1 && (
          <Button className="mt-6" disabled={!step1Valid} onClick={() => setRevealed(2)}>
            Continue
          </Button>
        )}
      </section>

      {/* Step 2 — classes */}
      {revealed >= 2 && (
        <section className="mt-16">
          <h2 className="t-body text-ink">Classes</h2>
          <p className="t-label mt-1 text-ink-soft">Or import them from a photo of your schedule.</p>
          {/* Wizard mode: the classes come back up here and flow through the
              setup_semester review. No semester exists yet, so an add_classes
              proposal would only come back `no_semester`. */}
          <ImportSchedule onParsed={(cs) => setClasses((prev) => [...prev, ...cs])} />
          <div className="mt-6">
            {classes.length === 0 ? (
              <p className="t-label text-ink-soft">No classes yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {classes.map((c, i) => (
                  <ClassRow
                    key={`${c.title}-${i}`}
                    cls={c}
                    onRemove={() => setClasses((cs) => cs.filter((_, j) => j !== i))}
                  />
                ))}
              </div>
            )}
          </div>
          <ClassEditor onAdd={(c) => setClasses((cs) => [...cs, c])} />
          {revealed === 2 && (
            <Button className="mt-6" disabled={!step2Valid} onClick={() => setRevealed(3)}>
              Continue
            </Button>
          )}
        </section>
      )}

      {/* Step 3 — the meal-pattern question */}
      {revealed >= 3 && (
        <section className="mt-16">
          {cadence === null || mealsOut === null || gymPerWeek === null ? (
            <p className="t-label text-ink-soft">Loading your defaults…</p>
          ) : (
            <div className="flex flex-col gap-6">
              <div>
                <p className="t-body mb-2 text-ink">How often do you cook lunch?</p>
                <RadioRows
                  label="How often do you cook lunch?"
                  options={CADENCE_OPTIONS}
                  value={cadence}
                  onChange={setCadence}
                />
              </div>
              <div>
                <p className="t-body mb-2 text-ink">Which meals are eaten out?</p>
                <div className="flex flex-col gap-2">
                  {MEALS.map((m) => (
                    <ToggleRow
                      key={m}
                      label={MEAL_LABEL[m]}
                      right={mealsOut[m] ? 'out' : offMode(m)}
                      pressed={mealsOut[m]}
                      onToggle={() => setMealsOut((prev) => (prev ? { ...prev, [m]: !prev[m] } : prev))}
                    />
                  ))}
                </div>
              </div>
              <div>
                <p className="t-body mb-2 text-ink">Gym sessions per week?</p>
                <Stepper label="gym sessions per week" value={gymPerWeek} min={0} max={7} onChange={setGymPerWeek} />
              </div>
            </div>
          )}
          {revealed === 3 && (
            <Button className="mt-6" disabled={!step3Valid} onClick={() => setRevealed(4)}>
              Continue
            </Button>
          )}
        </section>
      )}

      {/* Step 4 — review & approve */}
      {revealed >= 4 && (
        <section className="mt-16">
          <h2 className="t-body text-ink">Review</h2>
          <p className="t-body mt-4 text-ink">
            {name.trim()}{' '}
            <span className="t-time text-ink-soft">
              {startDate} – {endDate}
            </span>
          </p>
          <p className="t-label mt-1 text-ink-soft">
            <span className="t-time">{classes.length}</span> {classes.length === 1 ? 'class' : 'classes'}
            {' · '}cook lunch {cadenceLabel.toLowerCase()}
            {' · '}
            <span className="t-time">{gymPerWeek ?? 0}</span> gym sessions
            {' · '}out: {outMeals.length > 0 ? outMeals.join(', ') : 'none'}
          </p>

          {error && <p className="t-label mt-4 text-ink-soft">{error}</p>}

          {proposal ? (
            <div className="mt-6">
              <SetupReviewCard
                proposal={proposal}
                busy={busy}
                notice={notice}
                onApprove={handleApprove}
                onBack={handleBack}
              />
            </div>
          ) : (
            <Button
              className="mt-6"
              disabled={busy || !step1Valid || !step2Valid || !step3Valid}
              onClick={handleCreate}
            >
              Create semester
            </Button>
          )}
        </section>
      )}
    </main>
  );
}
