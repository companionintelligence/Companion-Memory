import { useEffect, useMemo, useRef, useState } from 'react';

import { fetchJson, GlobalUID } from '@ci/common';

import { useSessionAuth } from '@/hooks/useSessionAuth';
import { DEVICE_DATE_TIME_FORMATTER, type DateTimeFormatter } from '@/lib/dateTimeFormat';

import type { Thread } from './types';

/** How many threads a compact list (the rail submenu) will ever show. */
export const RECENT_THREAD_LIMIT = 10;

/** Skip a refetch if the list we already have is younger than this. */
const STALE_MS = 30_000;

/** How a thread's times read wherever threads are listed: "Oct 23, 2:09 PM". */
export const THREAD_TIME: Readonly<Intl.DateTimeFormatOptions> = Object.freeze({
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** One of a thread's ISO timestamps as a Date, or null when it is missing or unreadable. */
export function threadInstant(iso: string | undefined): Date | null {
  const date = iso ? new Date(iso) : null;

  return date && !Number.isNaN(date.getTime()) ? date : null;
}

/**
 * When a UUIDv7 was minted, or null for any other id. Its first 48 bits are the Unix time in
 * milliseconds.
 *
 * Every thread id is one: the server mints them (`ThreadService.create`) and so does Chat, which
 * names a new thread before it sends the first message. That is what lets a list that has no
 * `createdAt` for a thread (the explorer's search results, the device's records) still name it for
 * when it started.
 */
export function uuidV7Time(id: string): Date | null {
  const hex = id.replace(/-/g, '');

  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== '7') {
    return null;
  }

  return new Date(Number.parseInt(hex.slice(0, 12), 16));
}

/**
 * The raw thread uuid behind a GraphQL global id (`base64("thread:<uuid>")`), or the id as it
 * came when it is not one.
 */
export function threadIdOf(globalId: string): string {
  try {
    const { type, id } = GlobalUID.decode(globalId);

    return type === 'thread' ? id : globalId;
  } catch {
    return globalId;
  }
}

/**
 * When a thread started: its `createdAt`, or the time its UUIDv7 id was minted when there is no
 * readable `createdAt`, or null. The label and the sidebar tile both read it, so an untitled chat's
 * tile shows the day its label names.
 */
export function threadStarted(thread: { id?: string; createdAt?: string | null }): Date | null {
  return threadInstant(thread.createdAt ?? undefined) ?? (thread.id ? uuidV7Time(thread.id) : null);
}

/**
 * What to call a thread.
 *
 * Shared so the drawer submenu, the desktop sidebar, the phone's chat list and the explorer cannot
 * drift into different names for the same conversation. The explorer used to call an untitled one
 * "Untitled chat" in its list and "Thread" in its drawer while Chat called it "Chat · Oct 27, 3:43
 * PM".
 *
 * A thread's title is written by a background job after the first reply and can
 * arrive late, so an untitled thread is the normal state for a while. Its id
 * says nothing — chats started within about a minute of each other share the
 * same first eight characters, because a UUIDv7 opens with a timestamp — so it
 * is named for when it started, which at least tells two of them apart. Without
 * a `createdAt` that time is read from the id. The id remains the last resort.
 */
export function threadLabel(
  thread: { id: string; name?: string | null; createdAt?: string | null },
  fmt: DateTimeFormatter = DEVICE_DATE_TIME_FORMATTER,
): string {
  const name = thread.name?.trim();

  if (name) {
    return name;
  }

  const started = threadStarted(thread);

  if (started) {
    return `Chat · ${fmt.dateTime(started, THREAD_TIME)}`;
  }

  return `Thread ${thread.id.slice(0, 8)}`;
}

/**
 * {@link threadLabel} for a thread known by its GraphQL global id, which is how the explorer's
 * rows, tiles, drawer and search results carry it.
 */
export function threadNodeLabel(
  node: { id: string; name?: string | null },
  fmt: DateTimeFormatter = DEVICE_DATE_TIME_FORMATTER,
): string {
  return threadLabel({ id: threadIdOf(node.id), name: node.name }, fmt);
}

interface Options {
  /**
   * Fetch only while this is true.
   *
   * The rail renders on every page, so an eager thread list would be a request
   * per navigation for a menu nobody opened. This one fires when the submenu is
   * actually expanded, and not again until the answer goes stale.
   */
  enabled: boolean;
  limit?: number;
}

interface RecentThreads {
  threads: Thread[];
  loading: boolean;
  error: unknown;
}

/**
 * The newest threads, for picking one — not for managing them.
 *
 * {@link useThreadListService} is the Chat page's full-fat version: it deletes,
 * polls while a generation runs, and owns the sidebar's state. This is the
 * read-only slice the navigation needs, capped, and idle until asked.
 */
export function useRecentThreads({ enabled, limit = RECENT_THREAD_LIMIT }: Options): RecentThreads {
  const { ready, headers } = useSessionAuth();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fetchedAt = useRef(0);

  // Hovering the rail flickers `enabled` on and off; a session change means a
  // different user's threads, so that one always refetches. Native has no JWT —
  // `ready` flipping true after the keystore restore is the signal.
  useEffect(() => {
    fetchedAt.current = 0;
  }, [ready]);

  useEffect(() => {
    if (!enabled || !ready || Date.now() - fetchedAt.current < STALE_MS) {
      return;
    }

    let cancelled = false;
    fetchedAt.current = Date.now();
    setLoading(true);
    setError(null);

    fetchJson<Thread[]>('/api/threads', {
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
    })
      .then((data) => {
        if (!cancelled) {
          setThreads(data ?? []);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          // Let the next open try again rather than sitting on a failure.
          fetchedAt.current = 0;
          setError(err);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, ready, headers]);

  // The API orders by `updatedAt` descending, so the head of the list is the
  // most recent — no client-side sort, just a cap.
  const recent = useMemo(() => threads.slice(0, limit), [threads, limit]);

  return { threads: recent, loading, error };
}
