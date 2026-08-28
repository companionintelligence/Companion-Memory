import { useCallback, useEffect, useMemo, useState } from 'react';

import { fetchJson } from '@ci/common';

import { readJobsSnapshot, writeJobsSnapshot } from './jobsSnapshots';
import { useJobsAuth } from './useJobsAuth';

/** One row of `ci.pipeline_dead_letters`, as `GET /api/pipeline/dead-letters` reports it. */
export interface DeadLetter {
  readonly id: string;
  readonly queue: string;
  readonly eventName: string;
  readonly stage: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly userId: string | null;
  readonly payload: Record<string, unknown>;
  readonly error: string;
  readonly failedAt: string;
  readonly replayedAt: string | null;
}

export interface DeadLettersResponse {
  readonly deadLetters: readonly DeadLetter[];
}

export interface DeadLetterReplayFailure {
  readonly id: string;
  readonly eventName: string;
  readonly reason: string;
}

export interface DeadLetterReplayResponse {
  readonly requested: number | null;
  readonly claimed: number;
  readonly limit: number;
  readonly replayed: ReadonlyArray<{ readonly id: string; readonly jobIds: readonly string[] }>;
  readonly failed: readonly DeadLetterReplayFailure[];
  readonly skipped: readonly string[];

  /**
   * Named ids the server's batch ceiling never scanned. Unsettled, NOT settled —
   * rendering these as "already replayed" is the one reading under which an
   * operator would never retry them.
   */
  readonly notAttempted?: readonly string[];
}

/**
 * Dead letters that share an event name AND a failure.
 *
 * The table is not a list of 94 individual accidents — on the appliance this was
 * built against it was EIGHT causes, one of them repeated 36 times. Grouping is
 * what turns "94 failures" into "a bad model id, a bad image, and six others",
 * and it is the unit an operator actually acts on: you replay a cause, not a
 * uuid.
 */
export interface DeadLetterGroup {
  /** Stable key: event name + the first line of the error. */
  readonly key: string;
  readonly eventName: string;

  /** First line of the error. The stack is on {@link detail}. */
  readonly error: string;

  /** Full error text of the most recent letter in the group, stack included. */
  readonly detail: string;

  readonly count: number;
  readonly ids: readonly string[];

  /** Oldest and newest `failedAt` in the group, as epoch millis. */
  readonly firstFailedAt: number;
  readonly lastFailedAt: number;
}

/**
 * The first line of an error, which is the part that identifies the cause.
 *
 * Rows store the message AND the full stack — that fidelity is why the table is
 * worth having — but a stack in a table cell makes every row unreadable and, in
 * these rows, the stack embeds an absolute build path, so two occurrences of the
 * same bug from different worktrees would not even group together.
 */
export function errorHeadline(error: string): string {
  const [first = ''] = error.split('\n');

  return first.trim() || 'Unknown error';
}

/** A group under construction, before it is handed out as readonly. */
type MutableGroup = { -readonly [K in keyof DeadLetterGroup]: DeadLetterGroup[K] } & { ids: string[] };

/** Group by cause, most-recent group first. */
export function groupDeadLetters(letters: readonly DeadLetter[]): DeadLetterGroup[] {
  const groups = new Map<string, MutableGroup>();

  for (const letter of letters) {
    const error = errorHeadline(letter.error);
    const key = `${letter.eventName}\u0000${error}`;
    const failedAt = new Date(letter.failedAt).getTime();
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        key,
        eventName: letter.eventName,
        error,
        detail: letter.error,
        count: 1,
        ids: [letter.id],
        firstFailedAt: failedAt,
        lastFailedAt: failedAt,
      });

      continue;
    }

    existing.count += 1;
    existing.ids.push(letter.id);
    existing.firstFailedAt = Math.min(existing.firstFailedAt, failedAt);

    if (failedAt > existing.lastFailedAt) {
      existing.lastFailedAt = failedAt;
      existing.detail = letter.error;
    }
  }

  return [...groups.values()].sort((a, b) => b.lastFailedAt - a.lastFailedAt);
}

/** How many letters this page will pull. Matches the API's `MAX_DEAD_LETTER_PAGE`. */
export const DEAD_LETTER_PAGE = 200;

/**
 * The un-replayed dead letters, grouped by cause, plus the bulk replay.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * `ci.pipeline_dead_letters` had no reader anywhere in the product. The Jobs
 * page reads `pgboss.job`, which is a different table with a different lifetime:
 * pg-boss archives and eventually deletes its rows, while a dead letter is kept
 * forever precisely BECAUSE it holds the payload needed to re-run the work. So
 * the one table that can answer "what work was lost, and can I get it back?" was
 * write-only — 94 rows, zero replays, for the whole life of the appliance.
 *
 * Only un-replayed letters are fetched: this card is a work queue, and a replayed
 * letter is done. The API's `replayed=false` does that filtering in SQL.
 */
/** The replay queue's request, which is also its snapshot key. */
const DEAD_LETTERS_URL = `/api/pipeline/dead-letters?replayed=false&limit=${DEAD_LETTER_PAGE}`;

export function useDeadLetters(refreshIntervalMs = 30000) {
  const [restored] = useState(() => readJobsSnapshot<DeadLettersResponse>(DEAD_LETTERS_URL));

  const [data, setData] = useState<DeadLettersResponse | null>(restored?.value ?? null);
  const [loading, setLoading] = useState(restored == null);
  const [error, setError] = useState<string | null>(null);

  const { ready, headers } = useJobsAuth();

  const load = useCallback(async () => {
    if (!ready) {
      return;
    }

    try {
      const response = await fetchJson<DeadLettersResponse>(DEAD_LETTERS_URL, { headers });

      setData(response ?? null);
      setError(null);

      if (response) {
        writeJobsSnapshot(DEAD_LETTERS_URL, response);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ready, headers]);

  /**
   * Replay a named set of letters.
   *
   * Ids, never "everything": the endpoint refuses an empty selector, and the UI
   * agrees with it. A backlog is mostly one config error repeated, and replaying
   * that re-fails it and writes a fresh letter per attempt — so the operator has
   * to have looked at the cause and chosen it.
   *
   * Reloads on success, which is also what makes a double-click harmless in the
   * UI: the second submit claims nothing server-side (`replayed_at IS NULL`) and
   * the reload drops the rows that did replay out of the list.
   */
  const replay = useCallback(
    async (ids: readonly string[]): Promise<DeadLetterReplayResponse | null> => {
      if (!ready || ids.length === 0) {
        return null;
      }

      const response = await fetchJson<DeadLetterReplayResponse>('/api/pipeline/dead-letters/replay', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...ids] }),
      });

      await load();

      return response ?? null;
    },
    [ready, headers, load],
  );

  useEffect(() => {
    if (!ready) {
      return;
    }

    void load();

    if (refreshIntervalMs <= 0) {
      return;
    }

    const handle = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }

      void load();
    }, refreshIntervalMs);

    return () => window.clearInterval(handle);
  }, [ready, load, refreshIntervalMs]);

  const groups = useMemo(() => groupDeadLetters(data?.deadLetters ?? []), [data]);

  return { groups, total: data?.deadLetters.length ?? 0, loading, error, refresh: load, replay } as const;
}
