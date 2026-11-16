import { streamingFetch } from '@ci/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEBOUNCE_MS,
  isLiveChangesConnected,
  LIVE_CHANGES_PATH,
  resetLiveChangesForTests,
  setLiveChangesAuth,
  subscribeLiveChanges,
} from './liveChanges';

vi.mock('@ci/common', async (orig) => ({
  ...(await orig<typeof import('@ci/common')>()),
  streamingFetch: vi.fn(),
}));

const mockedFetch = vi.mocked(streamingFetch);

/** A response whose body is written to by the test, frame by frame. */
function openStream(status = 200) {
  let push: (chunk: string) => void = () => undefined;
  let close: () => void = () => undefined;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk) => controller.enqueue(encoder.encode(chunk));
      close = () => controller.close();
    },
  });
  const response = { ok: status >= 200 && status < 300, status, body } as unknown as Response;
  const opened = new Promise<void>((resolve) => {
    mockedFetch.mockImplementationOnce(async () => {
      resolve();

      return response;
    });
  });

  return { push: (chunk: string) => push(chunk), close: () => close(), opened };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The tab, or the phone app, comes back into view. */
function comeBack() {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockedFetch.mockReset();
});

afterEach(() => {
  resetLiveChangesForTests();
  vi.useRealTimers();
  // `comeBack` shadows jsdom's own getter; drop the override.
  delete (document as { visibilityState?: unknown }).visibilityState;
});

describe('liveChanges', () => {
  it('opens one stream with the bearer token once the first subscriber arrives', async () => {
    const stream = openStream();
    setLiveChangesAuth('tok');
    expect(isLiveChangesConnected()).toBe(false);

    subscribeLiveChanges(['tasks'], () => undefined);
    subscribeLiveChanges(['calendar'], () => undefined);
    await stream.opened;

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledWith(
      LIVE_CHANGES_PATH,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
    );
    expect(isLiveChangesConnected()).toBe(true);
  });

  it('does not connect without a token, and connects as soon as one arrives', async () => {
    subscribeLiveChanges(['tasks'], () => undefined);
    await flush();
    expect(mockedFetch).not.toHaveBeenCalled();

    const stream = openStream();
    setLiveChangesAuth('tok');
    await stream.opened;

    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('delivers a change frame to the listeners of its topic, debounced', async () => {
    const stream = openStream();
    setLiveChangesAuth('tok');
    const tasks = vi.fn();
    const calendar = vi.fn();
    subscribeLiveChanges(['tasks'], tasks);
    subscribeLiveChanges(['calendar'], calendar);
    await stream.opened;

    stream.push('retry: 3000\n: connected\n\n');
    stream.push('event: change\ndata: {"topic":"tasks"}\n\n');
    stream.push('event: change\ndata: {"topic":"tasks"}\n\nevent: change\ndata: {"topic":"ta');
    stream.push('sks"}\n\n: ping\n\n');
    await flush();
    expect(tasks).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(tasks).toHaveBeenCalledTimes(1);
    expect(calendar).not.toHaveBeenCalled();
  });

  it('closes the stream when the last subscriber leaves', async () => {
    const stream = openStream();
    setLiveChangesAuth('tok');
    const off1 = subscribeLiveChanges(['tasks'], () => undefined);
    const off2 = subscribeLiveChanges(['tasks'], () => undefined);
    await stream.opened;

    off1();
    expect(isLiveChangesConnected()).toBe(true);
    off2();
    expect(isLiveChangesConnected()).toBe(false);
  });

  it('reconnects with backoff after the server closes the stream', async () => {
    const first = openStream();
    setLiveChangesAuth('tok');
    subscribeLiveChanges(['tasks'], () => undefined);
    await first.opened;

    const second = openStream();
    first.close();
    await flush();
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await second.opened;
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('announces every topic once when a dropped stream comes back but not on the first connect', async () => {
    const first = openStream();
    setLiveChangesAuth('tok');
    const tasks = vi.fn();
    const calendar = vi.fn();
    subscribeLiveChanges(['tasks'], tasks);
    subscribeLiveChanges(['calendar'], calendar);
    await first.opened;
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(tasks).not.toHaveBeenCalled();
    expect(calendar).not.toHaveBeenCalled();

    // Whatever changed while the stream was down was never announced.
    const second = openStream();
    first.close();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await second.opened;
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(tasks).toHaveBeenCalledTimes(1);
    expect(calendar).toHaveBeenCalledTimes(1);

    // An open stream announces only what the server sends.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tasks).toHaveBeenCalledTimes(1);
  });

  it('announces nothing to subscribers who arrive after everyone had left', async () => {
    const first = openStream();
    setLiveChangesAuth('tok');
    const off = subscribeLiveChanges(['tasks'], () => undefined);
    await first.opened;
    first.close();
    await flush();
    off();

    const second = openStream();
    const tasks = vi.fn();
    subscribeLiveChanges(['tasks'], tasks);
    await second.opened;
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(tasks).not.toHaveBeenCalled();
  });

  it('reconnects at once when the browser comes back online', async () => {
    const first = openStream();
    setLiveChangesAuth('tok');
    subscribeLiveChanges(['tasks'], () => undefined);
    await first.opened;

    const second = openStream();
    first.close();
    await flush();
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    // Well inside the 1 s backoff.
    window.dispatchEvent(new Event('online'));
    await flush();

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    await second.opened;
  });

  it('replaces a stream still held when the browser comes back online and catches up', async () => {
    const first = openStream();
    setLiveChangesAuth('tok');
    const tasks = vi.fn();
    subscribeLiveChanges(['tasks'], tasks);
    await first.opened;

    // The offline spell never failed the open fetch.
    const second = openStream();
    window.dispatchEvent(new Event('online'));
    await second.opened;
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(tasks).toHaveBeenCalledTimes(1);
  });

  it('catches up after a lapsed session while listeners stayed mounted', async () => {
    const first = openStream();
    setLiveChangesAuth('tok-1');
    const tasks = vi.fn();
    subscribeLiveChanges(['tasks'], tasks);
    await first.opened;

    setLiveChangesAuth(null);
    expect(isLiveChangesConnected()).toBe(false);

    const second = openStream();
    setLiveChangesAuth('tok-2');
    await second.opened;
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(tasks).toHaveBeenCalledTimes(1);
  });

  it('does not retry a refused token, and connects when a new one is set', async () => {
    const refused = openStream(401);
    setLiveChangesAuth('stale');
    subscribeLiveChanges(['tasks'], () => undefined);
    await refused.opened;
    await flush();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    const fresh = openStream();
    setLiveChangesAuth('fresh');
    await fresh.opened;
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(mockedFetch).toHaveBeenLastCalledWith(
      LIVE_CHANGES_PATH,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer fresh' }) }),
    );
  });

  it('leaves an open stream alone when the token merely rotates', async () => {
    const stream = openStream();
    setLiveChangesAuth('tok-1');
    subscribeLiveChanges(['tasks'], () => undefined);
    await stream.opened;

    setLiveChangesAuth('tok-2');
    await flush();

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(isLiveChangesConnected()).toBe(true);
  });

  it('still does not retry a refused bearer once the minute is over', async () => {
    const refused = openStream(401);
    setLiveChangesAuth('stale');
    subscribeLiveChanges(['tasks'], () => undefined);
    await refused.opened;
    await flush();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    comeBack();
    await flush();

    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});

// The phone app signs in with the device's API key, not a bearer.
describe('liveChanges with the phone API key', () => {
  it('connects with the key as x-api-key and no Authorization header', async () => {
    const stream = openStream();
    setLiveChangesAuth('device-key', 'apiKey');
    subscribeLiveChanges(['tasks'], () => undefined);
    await stream.opened;

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const headers = mockedFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers).toEqual({ Accept: 'text/event-stream', 'x-api-key': 'device-key' });
    expect(isLiveChangesConnected()).toBe(true);
  });

  // The buffered native request resolves only when the body ends. This one never
  // does: the stream would hang open for good, with no way to abort it.
  it('asks for no buffered fallback on the phone', async () => {
    const stream = openStream();
    setLiveChangesAuth('device-key', 'apiKey');
    subscribeLiveChanges(['tasks'], () => undefined);
    await stream.opened;

    expect(mockedFetch).toHaveBeenCalledWith(
      LIVE_CHANGES_PATH,
      expect.objectContaining({ bufferedFallback: false }),
    );
  });

  it('retries a refused key after a minute even when the wall clock is set back', async () => {
    const refused = openStream(401);
    setLiveChangesAuth('device-key', 'apiKey');
    subscribeLiveChanges(['tasks'], () => undefined);
    await refused.opened;
    await flush();

    vi.setSystemTime(Date.now() - 60 * 60_000);

    const retry = openStream();
    await vi.advanceTimersByTimeAsync(60_000);
    await retry.opened;

    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('delivers change frames like the bearer stream', async () => {
    const stream = openStream();
    setLiveChangesAuth('device-key', 'apiKey');
    const calendar = vi.fn();
    subscribeLiveChanges(['calendar'], calendar);
    await stream.opened;

    stream.push('event: change\ndata: {"topic":"calendar"}\n\n');
    await flush();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(calendar).toHaveBeenCalledTimes(1);
  });

  it('tries a refused key again after the wait and catches up when it is let in', async () => {
    const refused = openStream(401);
    setLiveChangesAuth('device-key', 'apiKey');
    const tasks = vi.fn();
    subscribeLiveChanges(['tasks'], tasks);
    await refused.opened;
    await flush();

    // Nothing early: not on a timer, not on a return to the app.
    await vi.advanceTimersByTimeAsync(30_000);
    comeBack();
    await flush();
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    const retry = openStream();
    await vi.advanceTimersByTimeAsync(30_000);
    await retry.opened;
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(isLiveChangesConnected()).toBe(true);
    expect(tasks).toHaveBeenCalledTimes(1);
  });

  it('keeps trying a refused key every minute', async () => {
    const first = openStream(403);
    setLiveChangesAuth('device-key', 'apiKey');
    subscribeLiveChanges(['tasks'], () => undefined);
    await first.opened;
    await flush();

    const second = openStream(401);
    await vi.advanceTimersByTimeAsync(60_000);
    await second.opened;
    await flush();

    const third = openStream();
    await vi.advanceTimersByTimeAsync(60_000);
    await third.opened;

    expect(mockedFetch).toHaveBeenCalledTimes(3);
  });

  it('keeps the retry of a refused key when everyone leaves and comes back', async () => {
    const refused = openStream(401);
    setLiveChangesAuth('device-key', 'apiKey');
    const off = subscribeLiveChanges(['tasks'], () => undefined);
    await refused.opened;
    await flush();

    // Leaving cancels the timer; coming back inside the wait must not retry
    // early, nor lose the retry.
    off();
    await vi.advanceTimersByTimeAsync(10_000);
    subscribeLiveChanges(['tasks'], () => undefined);
    await flush();
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    const retry = openStream();
    await vi.advanceTimersByTimeAsync(50_000);
    await retry.opened;

    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('connects at once with a new key after the old one was refused', async () => {
    const refused = openStream(401);
    setLiveChangesAuth('old-key', 'apiKey');
    subscribeLiveChanges(['tasks'], () => undefined);
    await refused.opened;
    await flush();

    const fresh = openStream();
    setLiveChangesAuth('new-key', 'apiKey');
    await fresh.opened;

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(isLiveChangesConnected()).toBe(true);
  });

  it('replaces the open stream when the key changes and catches up', async () => {
    const first = openStream();
    setLiveChangesAuth('old-key', 'apiKey');
    const tasks = vi.fn();
    subscribeLiveChanges(['tasks'], tasks);
    await first.opened;
    const firstSignal = mockedFetch.mock.calls[0]?.[1]?.signal;

    // The same key again (a re-render) leaves it alone.
    setLiveChangesAuth('old-key', 'apiKey');
    await flush();
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    const second = openStream();
    setLiveChangesAuth('new-key', 'apiKey');
    await second.opened;
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(firstSignal?.aborted).toBe(true);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(isLiveChangesConnected()).toBe(true);
    expect(tasks).toHaveBeenCalledTimes(1);
  });

  it('closes on sign-out like the bearer stream', async () => {
    const stream = openStream();
    setLiveChangesAuth('device-key', 'apiKey');
    subscribeLiveChanges(['tasks'], () => undefined);
    await stream.opened;

    setLiveChangesAuth(null);

    expect(isLiveChangesConnected()).toBe(false);
  });

  it('books the retry again when a refused key comes back after a lapse', async () => {
    const refused = openStream(401);
    setLiveChangesAuth('device-key', 'apiKey');
    subscribeLiveChanges(['tasks'], () => undefined);
    await refused.opened;
    await flush();

    // Signed out for a moment: the retry timer goes with the stream.
    setLiveChangesAuth(null);
    setLiveChangesAuth('device-key', 'apiKey');
    await flush();
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    const retry = openStream();
    await vi.advanceTimersByTimeAsync(60_000);
    await retry.opened;

    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('replaces a stream the key opened when a bearer takes over', async () => {
    const first = openStream();
    setLiveChangesAuth('device-key', 'apiKey');
    subscribeLiveChanges(['tasks'], () => undefined);
    await first.opened;
    const firstSignal = mockedFetch.mock.calls[0]?.[1]?.signal;

    const second = openStream();
    setLiveChangesAuth('jwt-1');
    await second.opened;

    expect(firstSignal?.aborted).toBe(true);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    const headers = mockedFetch.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(headers).toEqual({ Accept: 'text/event-stream', Authorization: 'Bearer jwt-1' });
  });

  it('leaves the new stream alone when the old key answers after it was replaced', async () => {
    // A fetch that does not stop on abort and answers later with a refusal.
    let answerOld: (response: Response) => void = () => undefined;
    mockedFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          answerOld = resolve;
        }),
    );
    setLiveChangesAuth('old-key', 'apiKey');
    subscribeLiveChanges(['tasks'], () => undefined);
    await flush();

    const fresh = openStream();
    setLiveChangesAuth('new-key', 'apiKey');
    await fresh.opened;

    answerOld({ ok: false, status: 401, body: null } as unknown as Response);
    await flush();

    expect(isLiveChangesConnected()).toBe(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});

