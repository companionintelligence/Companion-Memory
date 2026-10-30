import { streamingFetch } from '@ci/common';

/**
 * The server's hint stream: `GET /api/live/changes`, server-sent events, one
 * topic name per frame meaning "something you can see under this changed, go
 * and re-read". One connection per app however many hooks listen, opened when
 * the first subscriber arrives and closed when the last one leaves.
 *
 * ═══ WHAT THIS REPLACES ═══
 *
 * Nothing. Until this, the calendar polled once an hour and the task rail
 * never did, so an edit on the phone reached the desktop on the next page
 * load. Polling stays, shorter, as the fallback for a stream that is down;
 * this is what makes the common case immediate.
 *
 * ═══ WHY `fetch`, NOT `EventSource` ═══
 *
 * `EventSource` cannot send a header, and the API authenticates with a bearer
 * token (or the device's API key on the phone). `streamingFetch` sends both,
 * and on the native shell routes around the patched fetch the same way the
 * chat stream does. The frames are parsed here; the format is small.
 *
 * ═══ RECONNECT RULES ═══
 *
 * A dropped stream comes back with backoff (1 s doubling to 30 s), at once on
 * return to a visible tab, and a 401/403 waits for a NEW token rather than
 * retrying with the one that was refused. The token rotates every few
 * minutes; an open stream is not reconnected for that, the new token is just
 * what the next connect uses.
 */
export type LiveChangeTopic = 'tasks' | 'calendar';

type Listener = () => void;

export const LIVE_CHANGES_PATH = '/api/live/changes';
export const DEBOUNCE_MS = 300;
const RECONNECT_FLOOR_MS = 1_000;
const RECONNECT_CEILING_MS = 30_000;
const UNAUTHORIZED_WAIT_MS = 60_000;

const subscribers = new Map<LiveChangeTopic, Set<Listener>>();
const debounces = new Map<LiveChangeTopic, ReturnType<typeof setTimeout>>();

let token: string | null = null;
let controller: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_FLOOR_MS;
let refusedToken: string | null = null;

function subscriberCount(): number {
  let count = 0;

  for (const set of subscribers.values()) {
    count += set.size;
  }

  return count;
}

function clearReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function emit(topic: LiveChangeTopic): void {
  if (debounces.has(topic)) {
    return;
  }

  debounces.set(
    topic,
    setTimeout(() => {
      debounces.delete(topic);

      for (const listener of subscribers.get(topic) ?? []) {
        try {
          listener();
        } catch {
          // One listener's failure is not the others' problem.
        }
      }
    }, DEBOUNCE_MS),
  );
}

/** One SSE frame: the lines between two blank lines. */
function handleFrame(frame: string): void {
  let event = 'message';
  const data: string[] = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trim());
    }
    // `retry:`, `id:` and comment lines (`: ping`) carry nothing for us.
  }

  if (event !== 'change' || data.length === 0) {
    return;
  }

  try {
    const parsed = JSON.parse(data.join('\n')) as { topic?: unknown };

    if (parsed.topic === 'tasks' || parsed.topic === 'calendar') {
      emit(parsed.topic);
    }
  } catch {
    // A frame we cannot read is a frame we ignore; the poll still runs.
  }
}

function scheduleReconnect(delay = reconnectDelay): void {
  clearReconnect();

  if (subscriberCount() === 0) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
  reconnectDelay = Math.min(delay * 2, RECONNECT_CEILING_MS);
}

async function connect(): Promise<void> {
  if (controller || !token || subscriberCount() === 0 || token === refusedToken) {
    return;
  }

  const own = new AbortController();
  controller = own;
  const usedToken = token;

  try {
    const response = await streamingFetch(LIVE_CHANGES_PATH, {
      headers: { Authorization: `Bearer ${usedToken}`, Accept: 'text/event-stream' },
      signal: own.signal,
    });

    if (response.status === 401 || response.status === 403) {
      // This token is no good; a retry with it would be refused the same way.
      // Wait for the next one, or a minute, whichever is first.
      refusedToken = usedToken;
      controller = null;
      scheduleReconnect(UNAUTHORIZED_WAIT_MS);

      return;
    }

    if (!response.ok || !response.body) {
      controller = null;
      scheduleReconnect();

      return;
    }

    reconnectDelay = RECONNECT_FLOOR_MS;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let boundary = buffer.indexOf('\n\n');

      while (boundary !== -1) {
        handleFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch {
    // Aborted by us, or the network went away. Both end up below.
  }

  if (controller !== own) {
    // Closed deliberately (last subscriber left, or a reset): stay closed.
    return;
  }

  controller = null;

  if (!own.signal.aborted) {
    scheduleReconnect();
  }
}

function disconnect(): void {
  clearReconnect();

  const current = controller;
  controller = null;
  current?.abort();
}

/**
 * The bearer token the next connect uses. A new token clears a 401 wait and
 * reconnects at once if subscribers are waiting; an open stream is left alone.
 */
export function setLiveChangesAuth(next: string | null): void {
  token = next;

  if (next && next !== refusedToken) {
    refusedToken = null;

    if (!controller && subscriberCount() > 0) {
      clearReconnect();
      void connect();
    }
  }

  if (!next) {
    disconnect();
  }
}

/** Hear every change on `topics`. Returns the unsubscribe. */
export function subscribeLiveChanges(topics: readonly LiveChangeTopic[], listener: Listener): () => void {
  for (const topic of topics) {
    let set = subscribers.get(topic);

    if (!set) {
      set = new Set();
      subscribers.set(topic, set);
    }

    set.add(listener);
  }

  void connect();

  return () => {
    for (const topic of topics) {
      const set = subscribers.get(topic);
      set?.delete(listener);

      if (set && set.size === 0) {
        subscribers.delete(topic);
      }
    }

    if (subscriberCount() === 0) {
      disconnect();
    }
  };
}

/** True while a stream is open or being opened. Diagnostics and tests. */
export function isLiveChangesConnected(): boolean {
  return controller !== null;
}

/** Back to a fresh module: tests only. */
export function resetLiveChangesForTests(): void {
  disconnect();
  subscribers.clear();

  for (const timer of debounces.values()) {
    clearTimeout(timer);
  }

  debounces.clear();
  token = null;
  refusedToken = null;
  reconnectDelay = RECONNECT_FLOOR_MS;
}

if (typeof document !== 'undefined') {
  // A backgrounded tab or a phone app brought back may hold a stream the
  // network quietly dropped. Skip whatever backoff is pending and try now;
  // `useRefetchOnReturn` covers whatever was missed while away.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !controller && subscriberCount() > 0) {
      clearReconnect();
      reconnectDelay = RECONNECT_FLOOR_MS;
      void connect();
    }
  });
}
