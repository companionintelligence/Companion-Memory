import { describe, expect, it, vi } from 'vitest';

import { createPlaybackStore } from './PlaybackStore';

const HOUR = 3_600_000;
const START = Date.UTC(2024, 0, 1);
const END = START + 30 * 24 * HOUR;

/**
 * A hand-cranked frame source. The store's whole job is owning a
 * requestAnimationFrame loop, so the tests drive that loop directly rather than
 * waiting on real frames.
 */
function harness() {
  let pending: ((time: number) => void) | null = null;
  let clock = 0;
  const cancelled: number[] = [];

  const store = createPlaybackStore(
    { start: START, end: END },
    {
      requestFrame: (callback) => {
        pending = callback;

        return 1;
      },
      cancelFrame: (handle) => {
        cancelled.push(handle);
        pending = null;
      },
    },
  );

  return {
    store,
    cancelled,
    get scheduled() {
      return pending != null;
    },
    /** Deliver one frame `ms` after the previous one. */
    frame(ms: number) {
      clock += ms;
      const callback = pending;
      pending = null;
      callback?.(clock);
    },
  };
}

describe('createPlaybackStore', () => {
  it('runs no frame loop until playback starts', () => {
    const { store, scheduled } = harness();

    expect(scheduled).toBe(false);
    expect(store.getState().status).toBe('idle');
  });

  it('schedules frames while playing and advances memory time', () => {
    const h = harness();

    h.store.dispatch({ type: 'play' });
    expect(h.scheduled).toBe(true);

    // The first frame has no previous timestamp, so it claims zero elapsed.
    h.frame(16);
    expect(h.store.getState().cursor).toBe(START);

    // A 100ms frame at speed 1 buys six minutes of life.
    h.frame(100);
    expect(h.store.getState().cursor - START).toBe(6 * 60_000);
  });

  it('cancels the loop on pause and resumes it on play', () => {
    const h = harness();

    h.store.dispatch({ type: 'play' });
    h.store.dispatch({ type: 'pause' });

    expect(h.scheduled).toBe(false);
    expect(h.cancelled).toEqual([1]);

    h.store.dispatch({ type: 'play' });
    expect(h.scheduled).toBe(true);
  });

  it('clamps a long gap between frames so a backgrounded tab does not fast-forward a life', () => {
    const h = harness();

    h.store.dispatch({ type: 'play' });
    h.frame(16);

    // Forty minutes away from the tab. Unclamped that is 40,000 hours of life.
    h.frame(40 * 60 * 1_000);

    // Clamped to one 250ms tick: 15 minutes of life, not 40,000 hours.
    expect(h.store.getState().cursor - START).toBe(15 * 60_000);
  });

  it('stops scheduling once the range ends', () => {
    const h = harness();

    h.store.dispatch({ type: 'seek', to: END - 60_000 });
    h.store.dispatch({ type: 'play' });
    h.frame(16);
    h.frame(250);

    expect(h.store.getState().status).toBe('ended');
    expect(h.scheduled).toBe(false);
  });

  it('notifies control listeners only when transport state changes, not every frame', () => {
    const h = harness();
    const onControl = vi.fn();

    h.store.subscribeControl(onControl);

    h.store.dispatch({ type: 'play' });
    expect(onControl).toHaveBeenCalledTimes(1);

    h.frame(16);
    h.frame(1_000);
    h.frame(1_000);

    // Three frames moved the playhead; none of them are transport changes.
    expect(onControl).toHaveBeenCalledTimes(1);

    h.store.dispatch({ type: 'setSpeed', speed: 24 });
    expect(onControl).toHaveBeenCalledTimes(2);
  });

  it('notifies frame listeners on every tick that moves the playhead', () => {
    const h = harness();
    const onFrame = vi.fn();

    h.store.subscribeFrame(onFrame);

    h.store.dispatch({ type: 'play' });
    h.frame(16);
    h.frame(16);
    h.frame(16);

    // play (status change) + the two ticks that actually moved it.
    expect(onFrame).toHaveBeenCalledTimes(3);
  });

  it('drops the loop and every listener on destroy', () => {
    const h = harness();
    const onFrame = vi.fn();

    h.store.dispatch({ type: 'play' });
    h.store.subscribeFrame(onFrame);
    h.store.destroy();

    expect(h.scheduled).toBe(false);

    h.store.dispatch({ type: 'seek', to: START + HOUR });

    expect(onFrame).not.toHaveBeenCalled();
    expect(h.store.getState().cursor).toBe(START);
  });
});
