import { useCallback, useMemo } from 'react';

import { useLocation, useSearchParams } from 'react-router-dom';

import { categoryFromPath } from './jobsSections';
import { DEFAULT_JOB_FILTERS, type JobFilters } from './useJobsList';

/**
 * The job filters, with the URL as the source of truth.
 *
 * ── Why this is not `useState` ─────────────────────────────────────────────
 *
 * It was, and that made every view on this page unreachable except by
 * re-performing it. A reload dropped you back to "everything, page 1"; back and
 * forward stepped over the page rather than through it; and there was no way to
 * hand anyone "the failing model jobs" except a screenshot and directions. For a
 * page whose entire job is narrowing 19,000 rows down to the handful that
 * matter, that is the difference between a tool and a demo.
 *
 * Putting the state in the query string buys all of it in one move — reload,
 * history, bookmarks, sharing — and makes saved views a matter of storing a
 * string rather than a schema.
 *
 * ── What is deliberately NOT in the URL ────────────────────────────────────
 *
 * `limit`. It is a device decision (20 on a phone, 50 on desktop), not a user
 * one, and a phone-sized link opened on a desktop should not stay phone-sized.
 * It stays local and is re-derived on every render.
 *
 * ── Only non-defaults are written ──────────────────────────────────────────
 *
 * A URL that carries every filter at its default value is unreadable and makes
 * "am I filtered?" impossible to answer at a glance. `/jobs` means no filters;
 * anything in the query string is something you chose.
 */
export interface JobFilterState {
  readonly filters: JobFilters;
  /** Merge a partial change. Replaces history rather than pushing, by default. */
  readonly setFilters: (next: Partial<JobFilters>, options?: { push?: boolean }) => void;
  /** True when anything is narrowing the table right now. */
  readonly isFiltered: boolean;
  /** Drop every filter, keeping the route. */
  readonly clear: () => void;
}

/** Query keys, and the order they are written in — stable so URLs compare equal. */
const KEYS = ['state', 'category', 'type', 'queue', 'search', 'hours', 'offset'] as const;

function readNumber(raw: string | null, fallback: number): number {
  if (raw == null) {
    return fallback;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function useJobFilters(limit: number): JobFilterState {
  const [params, setParams] = useSearchParams();
  const { pathname } = useLocation();

  // `/jobs/category/:category` names the category in the PATH, so the path wins
  // there. Everywhere else the query string owns it. Without this precedence a
  // deep-link would fight the query string on the first render and one of them
  // would silently lose.
  const routeCategory = categoryFromPath(pathname);

  const filters = useMemo<JobFilters>(
    () => ({
      state: params.get('state') ?? DEFAULT_JOB_FILTERS.state,
      category: routeCategory ?? params.get('category') ?? DEFAULT_JOB_FILTERS.category,
      type: params.get('type') ?? DEFAULT_JOB_FILTERS.type,
      queue: params.get('queue') ?? DEFAULT_JOB_FILTERS.queue,
      search: params.get('search') ?? DEFAULT_JOB_FILTERS.search,
      offset: readNumber(params.get('offset'), 0),
      limit,
    }),
    [params, routeCategory, limit],
  );

  const setFilters = useCallback(
    (next: Partial<JobFilters>, options: { push?: boolean } = {}) => {
      setParams(
        (current) => {
          const merged = { ...filters, ...next };
          const updated = new URLSearchParams(current);

          for (const key of KEYS) {
            if (key === 'hours' || key === 'offset') {
              continue;
            }

            const value = merged[key];

            if (typeof value === 'string' && value.trim().length > 0) {
              updated.set(key, value);
            } else {
              updated.delete(key);
            }
          }

          // Offset is the one number worth carrying — "page 3 of the failures"
          // is a place. Zero is the default and stays out.
          if (merged.offset > 0) {
            updated.set('offset', String(merged.offset));
          } else {
            updated.delete('offset');
          }

          return updated;
        },
        // Replace, not push: narrowing a table is one act of looking, not a
        // sequence of places. Pushing would make Back walk chip-by-chip out of
        // a filter set instead of leaving the page.
        { replace: options.push !== true },
      );
    },
    [filters, setParams],
  );

  const clear = useCallback(() => {
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);

        for (const key of KEYS) {
          updated.delete(key);
        }

        return updated;
      },
      { replace: true },
    );
  }, [setParams]);

  const isFiltered = Boolean(
    filters.state || filters.category || filters.type || filters.queue || filters.search,
  );

  return { filters, setFilters, isFiltered, clear };
}

/**
 * The history window, also in the URL — and shared with the table.
 *
 * Separate from {@link useJobFilters} because it is not a row filter today: the
 * charts read it and the list does not. It lives in the same query string so a
 * shared link carries the range someone was looking at, which is most of the
 * point of sharing a chart at all.
 */
export function useHistoryWindow(defaultHours = 24): readonly [number, (hours: number) => void] {
  const [params, setParams] = useSearchParams();
  const hours = readNumber(params.get('hours'), defaultHours) || defaultHours;

  const setHours = useCallback(
    (next: number) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);

          if (next === defaultHours) {
            updated.delete('hours');
          } else {
            updated.set('hours', String(next));
          }

          return updated;
        },
        { replace: true },
      );
    },
    [setParams, defaultHours],
  );

  return [hours, setHours] as const;
}
