/**
 * Near-duplicate detection for scan-proposed tasks.
 *
 * Inbox and memory scans hash the exact title. The model then rephrases the
 * same job ("Register for 'Network On Zoom'" vs "Register for Network On Zoom")
 * and we mint another card. This is the shared "same work?" test used before
 * create and when reconciling stale proposals.
 */

import { TASK_STATUSES } from '../taskStatus';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'for',
  'from',
  'in',
  'into',
  'my',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
  'your',
]);

/**
 * Statuses that mean "we already looked at this work" — including declined.
 *
 * That is every status there is, so it is the vocabulary itself rather than a
 * copy of it. Written out as a literal it silently lost `delegated` when #2558
 * added it, which let a scan re-propose a duplicate of the very task an agent
 * was already working on.
 */
export const SCAN_DEDUP_STATUSES = TASK_STATUSES;

export const SCAN_DEDUP_LIMIT = 300;

export function normalizeTaskTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/['\u2018\u2019\u201c\u201d`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function significantTokens(title: string): string[] {
  return normalizeTaskTitle(title)
    .split(' ')
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

export function titlesAreSimilar(left: string, right: string): boolean {
  const a = normalizeTaskTitle(left);
  const b = normalizeTaskTitle(right);

  if (!a || !b) {
    return false;
  }

  if (a === b) {
    return true;
  }

  // Truncated / expanded wording of the same phrase.
  if (a.length >= 12 && b.length >= 12 && (a.includes(b) || b.includes(a))) {
    return true;
  }

  const tokensA = new Set(significantTokens(left));
  const tokensB = new Set(significantTokens(right));

  if (tokensA.size === 0 || tokensB.size === 0) {
    return false;
  }

  let shared = 0;

  for (const token of tokensA) {
    if (tokensB.has(token)) {
      shared += 1;
    }
  }

  const smaller = Math.min(tokensA.size, tokensB.size);
  const union = tokensA.size + tokensB.size - shared;

  if (smaller >= 2 && shared === smaller) {
    return true;
  }

  return shared >= 2 && shared / union >= 0.7;
}

export function findSimilarTitle<T extends { title: string }>(
  title: string,
  tasks: readonly T[],
): T | undefined {
  return tasks.find((task) => titlesAreSimilar(task.title, title));
}

/**
 * Proposed cards that restate an older proposed/open/done task. Keep the
 * earliest; the rest are the scan-loop duplicates the user is looking at.
 */
export function newerDuplicateIds(
  tasks: readonly { id: string; title: string; status: string; createdAt?: Date | string }[],
): string[] {
  const ranked = [...tasks].sort((left, right) => {
    const a = createdMs(left.createdAt);
    const b = createdMs(right.createdAt);

    return a - b;
  });
  const keepers: { title: string }[] = [];
  const drop: string[] = [];

  for (const task of ranked) {
    if (findSimilarTitle(task.title, keepers)) {
      if (task.status === 'proposed') {
        drop.push(task.id);
      }

      continue;
    }

    keepers.push(task);
  }

  return drop;
}

function createdMs(value: Date | string | undefined): number {
  if (value == null) {
    return 0;
  }

  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();

  return Number.isNaN(ms) ? 0 : ms;
}

export function claimedSourceIds(
  tasks: readonly { metadata?: Record<string, unknown> | null }[],
  key: string,
): Set<string> {
  const ids = new Set<string>();

  for (const task of tasks) {
    const value = task.metadata?.[key];

    if (typeof value === 'string' && value.trim()) {
      ids.add(value.trim());
    }
  }

  return ids;
}

/** Prompt block so the model can return an empty list instead of inventing work. */
export function formatAlreadyTracked(titles: readonly string[], limit = 80): string {
  const unique: string[] = [];

  for (const title of titles) {
    const trimmed = title.trim();

    if (!trimmed) {
      continue;
    }

    if (unique.some((seen) => titlesAreSimilar(seen, trimmed))) {
      continue;
    }

    unique.push(trimmed);

    if (unique.length >= limit) {
      break;
    }
  }

  if (unique.length === 0) {
    return '';
  }

  return [
    'Already tracked (do not re-propose these or near-duplicates):',
    ...unique.map((title) => `- ${title}`),
    '',
    'If every remaining action is already tracked, return {"items":[]}.',
    'Do not invent extra tasks to fill the list. An empty list is better than a duplicate.',
  ].join('\n');
}
