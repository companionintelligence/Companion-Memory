/**
 * The playback state machine — "play back my life" as a pure reducer.
 *
 * Everything time-related about the fly-through lives here and nowhere else:
 * React only dispatches into it and reads the result. That split is deliberate.
 * The clock ticks at animation-frame rate, so anything it touches gets executed
 * sixty times a second on a device that is simultaneously projecting thousands
 * of Leaflet points; a reducer that is pure, allocation-light and independently
 * testable is the only version of this we can reason about. It also means the
 * awkward parts — what "play" means at the end of the range, what a seek does
 * to a running clock, how dead air is skipped — are unit-testable without a
 * browser, a map, or a network.
 *
 * Two vocabularies meet in here and must not be confused:
 *
 *  - **real time** — wall-clock milliseconds the viewer actually spends.
 *  - **memory time** — epoch milliseconds along the user's own history.
 *
 * `tick` is handed real elapsed milliseconds and converts; every other field on
 * the state is memory time.
 */

/** Memory-milliseconds travelled per real millisecond at speed 1. */
export const BASE_RATE = 3_600;

/**
 * Speed multipliers over {@link BASE_RATE}, i.e. 1 real second buys 1 hour, 6
 * hours, 1 day or 1 week of memory.
 *
 * The ladder is coarse on purpose. A life is 13 years long and the substrate is
 * sparse (582 days carry a fix, out of ~4,800 calendar days), so the useful
 * range spans two and a half orders of magnitude — a continuous slider would
 * spend most of its travel on speeds nobody wants.
 */
export const SPEEDS = [1, 6, 24, 168] as const;

export type PlaybackSpeed = (typeof SPEEDS)[number];

/**
 * Real seconds of empty map the viewer will sit through before the playhead
 * skips ahead to the next fix.
 *
 * Expressed in REAL time, not memory time, which is what makes it self-tuning:
 * at 1h/s a six-hour gap is six seconds of nothing and gets skipped, while at
 * 7d/s the same gap costs 50ms and is left alone. A fixed memory-time threshold
 * would have to be re-picked for every speed.
 */
const MAX_DEAD_AIR_MS = 1_500;

export type PlaybackStatus = 'idle' | 'playing' | 'paused' | 'ended';

export interface PlaybackRange {
  /** Epoch ms, inclusive. */
  start: number;
  /** Epoch ms, inclusive. */
  end: number;
}

export interface PlaybackState {
  status: PlaybackStatus;
  /** Playhead in memory time. Always inside {@link PlaybackState.range}. */
  cursor: number;
  speed: PlaybackSpeed;
  range: PlaybackRange;
  /**
   * Ascending epoch-ms of every moment the playhead can meaningfully stop at —
   * position fixes and located memories, merged. Used for gap skipping and for
   * deciding how much of the trace has been revealed.
   */
  stops: readonly number[];
  /** Whether dead air is skipped. Off, playback grinds through empty months. */
  skipGaps: boolean;
}

export type PlaybackAction =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'toggle' }
  | { type: 'seek'; to: number }
  | { type: 'setSpeed'; speed: number }
  | { type: 'setRange'; range: PlaybackRange }
  | { type: 'setStops'; stops: readonly number[] }
  | { type: 'setSkipGaps'; skipGaps: boolean }
  | { type: 'reset' }
  /** One clock tick. `elapsedMs` is REAL time since the previous tick. */
  | { type: 'tick'; elapsedMs: number };

export function createPlaybackState(range: PlaybackRange): PlaybackState {
  return {
    status: 'idle',
    cursor: range.start,
    speed: 1,
    range,
    stops: [],
    skipGaps: true,
  };
}

/** A range you cannot play: zero-width, inverted, or not yet resolved. */
export function isEmptyRange(range: PlaybackRange): boolean {
  return !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start;
}

function clampToRange(value: number, range: PlaybackRange): number {
  return Math.min(Math.max(value, range.start), range.end);
}

/** Nearest allowed speed, so a stale URL or a future preset can't wedge the clock. */
export function normalizeSpeed(speed: number): PlaybackSpeed {
  if (!Number.isFinite(speed) || speed <= 0) {
    return 1;
  }

  return SPEEDS.reduce<PlaybackSpeed>(
    (best, candidate) => (Math.abs(candidate - speed) < Math.abs(best - speed) ? candidate : best),
    SPEEDS[0],
  );
}

/** Memory-ms the playhead covers in `elapsedRealMs` of watching at `speed`. */
export function advanceFor(speed: number, elapsedRealMs: number): number {
  return Math.max(elapsedRealMs, 0) * speed * BASE_RATE;
}

/**
 * Memory-time gap wide enough to skip at this speed. See {@link MAX_DEAD_AIR_MS}.
 */
export function gapThresholdFor(speed: number): number {
  return advanceFor(speed, MAX_DEAD_AIR_MS);
}

/**
 * Index of the first stop strictly after `time` — i.e. how many stops have been
 * revealed at `time`, and where the next one lives. Binary search because this
 * runs on every frame against a list that can hold every fix in a 63k-row
 * history.
 */
export function stopsRevealed(stops: readonly number[], time: number): number {
  let low = 0;
  let high = stops.length;

  while (low < high) {
    const mid = (low + high) >>> 1;

    if (stops[mid] <= time) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

/**
 * Advance the playhead one tick, skipping dead air.
 *
 * Exported for the reducer's own tests: the skip rule is the one piece of this
 * file whose behaviour is worth pinning independently of the status machine.
 */
export function advanceCursor(state: PlaybackState, elapsedMs: number): number {
  const next = state.cursor + advanceFor(state.speed, elapsedMs);

  if (!state.skipGaps || state.stops.length === 0) {
    return next;
  }

  const nextIndex = stopsRevealed(state.stops, state.cursor);

  // Nothing left to see in this range: run straight to the end rather than
  // crawling through however many empty years remain.
  if (nextIndex >= state.stops.length) {
    return state.range.end;
  }

  const nextStop = state.stops[nextIndex];

  // Only skip when the tick did NOT already reach the next stop — otherwise a
  // slow speed over a dense stretch would snap forward on every frame and
  // playback would run at the density of the data instead of at the chosen speed.
  if (nextStop > next && nextStop - state.cursor >= gapThresholdFor(state.speed)) {
    return nextStop;
  }

  return next;
}

export function playbackReducer(state: PlaybackState, action: PlaybackAction): PlaybackState {
  switch (action.type) {
    case 'play': {
      // Nothing to play. Staying 'idle' (rather than flipping to 'playing' and
      // immediately ending) keeps the transport button honest while the range
      // is still resolving.
      if (isEmptyRange(state.range)) {
        return state;
      }

      // Pressing play at the end is a replay request, not a no-op — the button
      // has already turned back into ▶ by then.
      if (state.status === 'ended' || state.cursor >= state.range.end) {
        return { ...state, status: 'playing', cursor: state.range.start };
      }

      return state.status === 'playing' ? state : { ...state, status: 'playing' };
    }

    case 'pause':
      return state.status === 'playing' ? { ...state, status: 'paused' } : state;

    case 'toggle':
      return playbackReducer(state, { type: state.status === 'playing' ? 'pause' : 'play' });

    case 'seek': {
      const cursor = clampToRange(action.to, state.range);

      // Scrubbing while it runs keeps it running — the viewer is steering, not
      // stopping. From any other status the seek arms the playhead and leaves
      // it parked, including from 'ended': seeking back into the range is how
      // you undo the end, and it must not silently start playing.
      return {
        ...state,
        cursor,
        status: state.status === 'playing' ? 'playing' : 'paused',
      };
    }

    case 'setSpeed': {
      const speed = normalizeSpeed(action.speed);

      return speed === state.speed ? state : { ...state, speed };
    }

    case 'setRange': {
      const { range } = action;

      if (range.start === state.range.start && range.end === state.range.end) {
        return state;
      }

      // A new range is a new film. Keeping the playhead where it was only makes
      // sense while it still falls inside; otherwise it goes back to the top,
      // and an 'ended' run is no longer ended because there is more to see.
      const withinRange = state.cursor >= range.start && state.cursor <= range.end;
      const cursor = withinRange ? state.cursor : range.start;
      const status = state.status === 'ended' && !withinRange ? 'paused' : state.status;

      return { ...state, range, cursor, status };
    }

    case 'setStops':
      return state.stops === action.stops ? state : { ...state, stops: action.stops };

    case 'setSkipGaps':
      return state.skipGaps === action.skipGaps ? state : { ...state, skipGaps: action.skipGaps };

    case 'reset':
      return { ...state, status: 'idle', cursor: state.range.start };

    case 'tick': {
      // The clock is allowed to keep firing while paused (it does not, but a
      // stale frame in flight can land after a pause); ignoring it here is what
      // makes pause exact rather than approximately exact.
      if (state.status !== 'playing') {
        return state;
      }

      const next = advanceCursor(state, action.elapsedMs);

      if (next >= state.range.end) {
        return { ...state, cursor: state.range.end, status: 'ended' };
      }

      return next === state.cursor ? state : { ...state, cursor: next };
    }

    default:
      return state;
  }
}

/** Fraction of the range the playhead has covered, 0–1 (0 for an empty range). */
export function playbackProgress(state: PlaybackState): number {
  if (isEmptyRange(state.range)) {
    return 0;
  }

  return (state.cursor - state.range.start) / (state.range.end - state.range.start);
}

/** "1h/s" … "7d/s" — the unit the speed ladder actually means. */
export function formatSpeed(speed: number): string {
  const hoursPerSecond = speed;

  if (hoursPerSecond < 24) {
    return `${hoursPerSecond}h/s`;
  }

  const daysPerSecond = hoursPerSecond / 24;

  return daysPerSecond < 7 ? `${daysPerSecond}d/s` : `${daysPerSecond / 7}w/s`;
}
