'use client';

/**
 * The pipeline: tracked applications grouped by status in interested → …
 * → ghosted order, with counts. Empty statuses are omitted (the core layer
 * already drops them). Rows stay lean — company, title, a one-line notes
 * preview, when it last moved, and the same status pill the feed uses, so
 * moving a role along the pipeline works identically from either view.
 */
import type { AppStatus, InternshipItem } from '@/lib/api';
import { StatusPill, STATUS_LABEL } from './status-pill';
import { timeAgo } from './format';

export interface TrackerGroup {
  status: AppStatus;
  items: InternshipItem[];
}

export function TrackerView({
  groups,
  onStatus,
}: {
  groups: TrackerGroup[] | null;
  onStatus(id: string, status: AppStatus | null): void;
}) {
  if (groups === null) {
    return (
      <p className="t-label mise-dot mt-8 text-ink-soft" aria-hidden="true">
        ●
      </p>
    );
  }

  if (groups.length === 0) {
    return (
      <p className="t-label mt-8 text-ink-soft">
        Nothing tracked yet — hit Track on a role in the feed and it lands here.
      </p>
    );
  }

  return (
    <div>
      {groups.map((g) => (
        <section key={g.status} className="mt-8">
          <h2 className="t-micro text-ink-soft">
            {STATUS_LABEL[g.status]} · {g.items.length}
          </h2>
          <ul className="mt-1">
            {g.items.map((it) => {
              const notes = (it.application?.notes ?? '').split('\n')[0]?.trim();
              return (
                <li key={it.id} className="flex items-center gap-3 border-b border-rule py-3">
                  <div className="min-w-0 flex-1">
                    <p className="t-body truncate font-semibold text-ink">
                      {it.company}
                      {it.application?.applied_at && (
                        <span className="t-micro pl-2 text-ink" title="Applied" aria-label="Applied">
                          ✓
                        </span>
                      )}
                    </p>
                    <p className="t-label truncate text-ink-soft">{it.title}</p>
                    {notes && <p className="t-label truncate text-ink-soft">{notes}</p>}
                  </div>
                  {it.application && (
                    <span className="t-time shrink-0 text-ink-soft">
                      {timeAgo(it.application.updated_at)}
                    </span>
                  )}
                  <StatusPill
                    status={it.application?.status ?? null}
                    onChange={(s) => onStatus(it.id, s)}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default TrackerView;
