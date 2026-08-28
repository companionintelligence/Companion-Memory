import {
  createPlaybackState,
  playbackReducer,
  type PlaybackAction,
  type PlaybackRange,
  type PlaybackState,
} from './playbackMachine';

/**
 * The playback clock, and the reason it is not `useState`.
 *
 * The playhead moves on every animation frame. Holding it in React state would
 * re-render the map view — its toolbar, its timeline panel, its thousands of
 * clustered markers — sixty times a second, and the fly-through would stutter
 * exactly when it matters most (dense stretches, which are also the ones with
 * the most markers). So the cursor lives in a mutable store with two
 * subscription channels:
 *
 *  - **control** — status, speed, range, stop count. Changes only when the
 *    viewer acts, so React can subscribe to it directly (`useSyncExternalStore`)
 *    and re-render normally.
 *  - **frame** — the whole state, every tick. Only imperative consumers
 *    subscribe here: the Leaflet layer, which writes straight to a polyline and
 *    a marker, and one deliberately throttled bridge back into React for the
 *    scrubber thumb and the date read-out.
 *
 * The store owns the requestAnimationFrame loop, starts it when playback starts
 * and stops it the moment playback stops — an idle map does no per-frame work
 * at all.
 */

/**
 * Longest real interval one tick may claim.
 *
 * Backgrounded tabs stop receiving frames; without this, coming back to the tab
 * after lunch hands the reducer a 40-minute delta and the playhead jumps four
 * years in a single frame. Clamping means a hidden tab quietly pauses in
 * memory-time terms instead of fast-forwarding through the user's life.
 *
 * 250ms is a four-frames-a-second floor: generous enough that an ordinary
 * hitch (a page landing, a re-cluster) still advances honestly, tight enough
 * that a stall cannot smear a visible jump across the map. Under sustained
 * load playback slows rather than skips, which is the right trade for
 * something whose entire job is to be watched.
 */
const MAX_TICK_MS = 250;

export interface PlaybackStoreOptions {
  /**
   * Injected in tests so the clock can be stepped deterministically. The
   * callback is handed a timestamp exactly as `requestAnimationFrame` does —
   * the store never reads a clock of its own, so the frame source is the single
   * source of time and a test can make it whatever it needs.
   */
  requestFrame?: (callback: (time: number) => void) => number;
  cancelFrame?: (handle: number) => void;
}

/** The slice of state that changes only when someone acts on the transport. */
export interface PlaybackControlSnapshot {
  status: PlaybackState['status'];
  speed: PlaybackState['speed'];
  range: PlaybackRange;
  skipGaps: boolean;
  stopCount: number;
}

export interface PlaybackStore {
  dispatch(action: PlaybackAction): void;
  getState(): PlaybackState;
  getControlSnapshot(): PlaybackControlSnapshot;
  subscribeControl(listener: () => void): () => void;
  /** Called on every tick with the live state. Never allocate in the callback. */
  subscribeFrame(listener: (state: PlaybackState) => void): () => void;
  /** Stop the clock and drop every listener. */
  destroy(): void;
}

export function createPlaybackStore(range: PlaybackRange, options: PlaybackStoreOptions = {}): PlaybackStore {
  const requestFrame =
    options.requestFrame ??
    ((callback) =>
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(callback)
        : (setTimeout(() => callback(Date.now()), 16) as unknown as number));
  const cancelFrame =
    options.cancelFrame ??
    ((handle) => {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(handle);
      } else {
        clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
      }
    });
  let state = createPlaybackState(range);
  let control = snapshotOf(state);
  const controlListeners = new Set<() => void>();
  const frameListeners = new Set<(state: PlaybackState) => void>();

  let frameHandle: number | null = null;
  let lastFrameAt = 0;
  let destroyed = false;

  function snapshotOf(source: PlaybackState): PlaybackControlSnapshot {
    return {
      status: source.status,
      speed: source.speed,
      range: source.range,
      skipGaps: source.skipGaps,
      stopCount: source.stops.length,
    };
  }

  function controlChanged(a: PlaybackControlSnapshot, b: PlaybackControlSnapshot): boolean {
    return (
      a.status !== b.status ||
      a.speed !== b.speed ||
      a.range.start !== b.range.start ||
      a.range.end !== b.range.end ||
      a.skipGaps !== b.skipGaps ||
      a.stopCount !== b.stopCount
    );
  }

  function tick(time: number) {
    frameHandle = null;

    if (destroyed || state.status !== 'playing') {
      return;
    }

    // First frame after starting has no previous timestamp to subtract; treat
    // it as zero elapsed rather than as "since the page loaded".
    const elapsed = lastFrameAt === 0 ? 0 : Math.min(time - lastFrameAt, MAX_TICK_MS);
    lastFrameAt = time;

    apply({ type: 'tick', elapsedMs: elapsed });

    // apply() may have ended playback; only keep the loop alive if it did not.
    if (state.status === 'playing') {
      frameHandle = requestFrame(tick);
    }
  }

  function syncClock() {
    if (state.status === 'playing' && frameHandle == null && !destroyed) {
      lastFrameAt = 0;
      frameHandle = requestFrame(tick);
    }

    if (state.status !== 'playing' && frameHandle != null) {
      cancelFrame(frameHandle);
      frameHandle = null;
    }
  }

  function apply(action: PlaybackAction) {
    const previous = state;
    state = playbackReducer(state, action);

    if (state === previous) {
      // Even a no-op tick has to keep the loop scheduled; nothing else to do.
      return;
    }

    const nextControl = snapshotOf(state);

    if (controlChanged(control, nextControl)) {
      control = nextControl;
      controlListeners.forEach((listener) => listener());
    }

    if (state.cursor !== previous.cursor || state.status !== previous.status) {
      frameListeners.forEach((listener) => listener(state));
    }
  }

  return {
    dispatch(action: PlaybackAction) {
      if (destroyed) {
        return;
      }

      apply(action);
      syncClock();
    },

    getState: () => state,
    getControlSnapshot: () => control,

    subscribeControl(listener: () => void) {
      controlListeners.add(listener);

      return () => controlListeners.delete(listener);
    },

    subscribeFrame(listener: (state: PlaybackState) => void) {
      frameListeners.add(listener);

      return () => frameListeners.delete(listener);
    },

    destroy() {
      destroyed = true;

      if (frameHandle != null) {
        cancelFrame(frameHandle);
        frameHandle = null;
      }

      controlListeners.clear();
      frameListeners.clear();
    },
  };
}
