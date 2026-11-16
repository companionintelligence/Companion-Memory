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
 * what the next connect uses. The browser coming back online also reconnects
 * at once.
 *
 * The phone app has no bearer: it signs in with the device's API key, which
 * never rotates. A refused key is tried again after the same minute's wait,
 * and a different key (signing in again) connects at once, replacing a
 * stream the old key opened.
 *
 * Nothing that changed while the stream was down was announced, so the first
 * stream that opens after a drop announces every topic with listeners once.
 * They re-read and are current again without waiting for their next poll.
 */
export type LiveChangeTopic = 'tasks' | 'calendar';

/**
 * What the credential given to `setLiveChangesAuth` is: the web session's
 * bearer token, sent as `Authorization: Bearer`, or the phone's API key, sent
 * as `x-api-key`.
 */
export type LiveChangesAuthKind = 'bearer' | 'apiKey';

type Listener = () => void;

export const LIVE_CHANGES_PATH = '/api/live/changes';
export const DEBOUNCE_MS = 300;
const RECONNECT_FLOOR_MS = 1_000;
const RECONNECT_CEILING_MS = 30_000;
const UNAUTHORIZED_WAIT_MS = 60_000;

const subscribers = new Map<LiveChangeTopic, Set<Listener>>();
const debounces = new Map<LiveChangeTopic, ReturnType<typeof setTimeout>>();

let token: string | null = null;
let tokenKind: LiveChangesAuthKind = 'bearer';
let controller: AbortController | null = null;
/** The credential the open stream was opened with. */
let streamToken: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_FLOOR_MS;
let refusedToken: string | null = null;
/** When `refusedToken` may be tried again: never for a bearer, after a wait for a key. */
let refusedUntil = 0;
/** A stream subscribers wanted was down, so changes may have gone unannounced. */
let missedChanges = false;

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
  if (controller || !token || subscriberCount() === 0) {
    return;
  }

  if (token === refusedToken) {
    // `performance.now()`, not the wall clock: a clock set back would put the
    // retry off by the size of the jump.
    const wait = refusedUntil - performance.now();

    if (wait > 0) {
      // A refused key's retry stays booked whatever cleared the timer (the
      // last subscriber leaving, a return to the app). A bearer waits forever.
      if (Number.isFinite(wait) && !reconnectTimer) {
        scheduleReconnect(Math.max(wait, RECONNECT_FLOOR_MS));
      }

      return;
    }

    refusedToken = null;
    // The minute's wait doubled the backoff to its ceiling; this is a fresh try.
    reconnectDelay = RECONNECT_FLOOR_MS;
  }

  const own = new AbortController();
  controller = own;
  const usedToken = token;
  const usedKind = tokenKind;
  streamToken = usedToken;

  try {
    // The key is sent as given rather than left to `streamingFetch`, which reads
    // its own copy: the key recorded as open or refused is then the one sent.
    // No buffered fallback on the phone: this response never ends.
    const response = await streamingFetch(LIVE_CHANGES_PATH, {
      headers: {
        Accept: 'text/event-stream',
        ...(usedKind === 'apiKey' ? { 'x-api-key': usedToken } : { Authorization: `Bearer ${usedToken}` }),
      },
      signal: own.signal,
      bufferedFallback: false,
    });

    if (response.status === 401 || response.status === 403) {
      // This token is no good; a retry with it would be refused the same way.
      // A bearer waits for the next one, which comes when it rotates. A key has
      // no next one coming, so after a minute the same key is tried again.
      refusedToken = usedToken;
      refusedUntil = usedKind === 'apiKey' ? performance.now() + UNAUTHORIZED_WAIT_MS : Infinity;
      controller = null;
      missedChanges = true;
      scheduleReconnect(UNAUTHORIZED_WAIT_MS);

      return;
    }

    if (!response.ok || !response.body) {
      controller = null;
      missedChanges = true;
      scheduleReconnect();

      return;
    }

    reconnectDelay = RECONNECT_FLOOR_MS;

    if (missedChanges) {
      missedChanges = false;

      for (const topic of subscribers.keys()) {
        emit(topic);
      }
    }

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
    missedChanges = true;
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
 * The credential the next connect uses: the bearer token, or with `'apiKey'`
 * the phone's API key. A new one clears a 401 wait and reconnects at once if
 * subscribers are waiting. An open stream is left alone when a bearer merely
 * rotates, and replaced when the key changes, since a new key is a new sign-in.
 */
export function setLiveChangesAuth(next: string | null, kind: LiveChangesAuthKind = 'bearer'): void {
  token = next;
  tokenKind = kind;

  if (next && kind === 'apiKey' && controller && streamToken !== next) {
    missedChanges = true;
    disconnect();
  }

  if (next && next !== refusedToken) {
    refusedToken = null;

    if (!controller && subscriberCount() > 0) {
      clearReconnect();
      void connect();
    }
  }

  if (!next) {
    // The listeners stay mounted through a lapsed session (a JWT that expired
    // while the laptop slept), so whatever changes before a token comes back
    // goes unannounced like any other drop.
    if (controller && subscriberCount() > 0) {
      missedChanges = true;
    }

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
      // Nobody is listening any more; whoever subscribes next reads fresh on mount.
      missedChanges = false;
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
  tokenKind = 'bearer';
  streamToken = null;
  refusedToken = null;
  refusedUntil = 0;
  reconnectDelay = RECONNECT_FLOOR_MS;
  missedChanges = false;
}

/** Skip whatever backoff is pending and try now. */
function reconnectNow(): void {
  if (!controller && subscriberCount() > 0) {
    clearReconnect();
    reconnectDelay = RECONNECT_FLOOR_MS;
    void connect();
  }
}

/**
 * Back online. A stream that dropped is waiting out a backoff of up to 30 s.
 * One that is still held went through the offline spell and may be dead
 * without having noticed (not every browser fails an open fetch when the
 * network goes), so it is replaced rather than trusted.
 */
function onOnline(): void {
  if (controller && subscriberCount() > 0) {
    const held = controller;
    controller = null;
    missedChanges = true;
    held.abort();
  }

  reconnectNow();
}

if (typeof document !== 'undefined') {
  // A backgrounded tab or a phone app brought back may have lost its stream
  // while away. Try now; the catch-up on connect covers whatever was missed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      reconnectNow();
    }
  });
  window.addEventListener('online', onOnline);
}
