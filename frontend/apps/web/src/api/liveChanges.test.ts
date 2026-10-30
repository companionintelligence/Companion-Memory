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

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockedFetch.mockReset();
});

afterEach(() => {
  resetLiveChangesForTests();
  vi.useRealTimers();
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
});
