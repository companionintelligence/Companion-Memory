import { describe, expect, it } from 'vitest';

import {
  BASE_RATE,
  advanceCursor,
  advanceFor,
  createPlaybackState,
  formatSpeed,
  gapThresholdFor,
  isEmptyRange,
  normalizeSpeed,
  playbackProgress,
  playbackReducer,
  stopsRevealed,
  type PlaybackState,
} from './playbackMachine';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const START = Date.UTC(2024, 0, 1);
const END = START + 30 * DAY;

function initial(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return { ...createPlaybackState({ start: START, end: END }), ...overrides };
}

describe('playbackReducer — transport', () => {
  it('starts idle at the beginning of the range', () => {
    const state = initial();

    expect(state.status).toBe('idle');
    expect(state.cursor).toBe(START);
  });

  it('play moves to playing without moving the cursor', () => {
    const state = playbackReducer(initial(), { type: 'play' });

    expect(state.status).toBe('playing');
    expect(state.cursor).toBe(START);
  });

  it('pause stops the clock and keeps the cursor', () => {
    const playing = playbackReducer(initial({ cursor: START + DAY }), { type: 'play' });
    const paused = playbackReducer(playing, { type: 'pause' });

    expect(paused.status).toBe('paused');
    expect(paused.cursor).toBe(START + DAY);
  });

  it('toggle flips between playing and paused', () => {
    const playing = playbackReducer(initial(), { type: 'toggle' });
    const paused = playbackReducer(playing, { type: 'toggle' });
    const again = playbackReducer(paused, { type: 'toggle' });

    expect(playing.status).toBe('playing');
    expect(paused.status).toBe('paused');
    expect(again.status).toBe('playing');
  });

  it('refuses to play an empty range', () => {
    const state = playbackReducer(initial({ range: { start: START, end: START } }), { type: 'play' });

    expect(state.status).toBe('idle');
  });

  it('reset parks the playhead back at the start', () => {
    const played = playbackReducer(initial({ cursor: START + 5 * DAY, status: 'paused' }), {
      type: 'reset',
    });

    expect(played).toMatchObject({ status: 'idle', cursor: START });
  });
});

describe('playbackReducer — tick', () => {
  it('advances memory time in proportion to real time and speed', () => {
    const playing = playbackReducer(initial(), { type: 'play' });
    const ticked = playbackReducer(playing, { type: 'tick', elapsedMs: 1_000 });

    // One real second at speed 1 buys one hour of life.
    expect(ticked.cursor - START).toBe(HOUR);
    expect(advanceFor(1, 1_000)).toBe(BASE_RATE * 1_000);
  });

  it('scales with the speed multiplier', () => {
    const playing = playbackReducer(initial({ speed: 24 }), { type: 'play' });
    const ticked = playbackReducer(playing, { type: 'tick', elapsedMs: 1_000 });

    expect(ticked.cursor - START).toBe(DAY);
  });

  it('is a no-op while paused', () => {
    const paused = initial({ status: 'paused', cursor: START + DAY });
    const ticked = playbackReducer(paused, { type: 'tick', elapsedMs: 5_000 });

    expect(ticked).toBe(paused);
  });

  it('is a no-op while idle', () => {
    const idle = initial();

    expect(playbackReducer(idle, { type: 'tick', elapsedMs: 5_000 })).toBe(idle);
  });
});

describe('playbackReducer — seek', () => {
  it('clamps a seek below the range to the start', () => {
    const state = playbackReducer(initial({ status: 'paused' }), { type: 'seek', to: START - DAY });

    expect(state.cursor).toBe(START);
  });

  it('clamps a seek past the range to the end', () => {
    const state = playbackReducer(initial({ status: 'paused' }), { type: 'seek', to: END + DAY });

    expect(state.cursor).toBe(END);
  });

  it('keeps playing when the viewer scrubs mid-playback', () => {
    const playing = playbackReducer(initial(), { type: 'play' });
    const seeked = playbackReducer(playing, { type: 'seek', to: START + 2 * DAY });

    expect(seeked).toMatchObject({ status: 'playing', cursor: START + 2 * DAY });
  });

  it('arms — but does not start — playback when seeking from idle', () => {
    const state = playbackReducer(initial(), { type: 'seek', to: START + DAY });

    expect(state.status).toBe('paused');
  });

  it('lifts the ended state when seeking back into the range', () => {
    const ended = initial({ status: 'ended', cursor: END });
    const seeked = playbackReducer(ended, { type: 'seek', to: START + DAY });

    expect(seeked).toMatchObject({ status: 'paused', cursor: START + DAY });
  });
});

describe('playbackReducer — speed', () => {
  it('snaps an arbitrary speed onto the ladder', () => {
    expect(playbackReducer(initial(), { type: 'setSpeed', speed: 30 }).speed).toBe(24);
    expect(normalizeSpeed(0)).toBe(1);
    expect(normalizeSpeed(Number.NaN)).toBe(1);
    expect(normalizeSpeed(1_000)).toBe(168);
  });

  it('changing speed does not move the playhead or stop the clock', () => {
    const playing = playbackReducer(initial({ cursor: START + DAY }), { type: 'play' });
    const faster = playbackReducer(playing, { type: 'setSpeed', speed: 168 });

    expect(faster).toMatchObject({ status: 'playing', cursor: START + DAY, speed: 168 });
  });

  it('a speed change takes effect on the very next tick', () => {
    const playing = playbackReducer(initial(), { type: 'play' });
    const faster = playbackReducer(playing, { type: 'setSpeed', speed: 6 });
    const ticked = playbackReducer(faster, { type: 'tick', elapsedMs: 1_000 });

    expect(ticked.cursor - START).toBe(6 * HOUR);
  });
});

describe('playbackReducer — end of range', () => {
  it('stops exactly at the end rather than running past it', () => {
    const playing = playbackReducer(initial({ cursor: END - HOUR }), { type: 'play' });
    const ticked = playbackReducer(playing, { type: 'tick', elapsedMs: 10_000 });

    expect(ticked).toMatchObject({ status: 'ended', cursor: END });
  });

  it('further ticks after the end change nothing', () => {
    const ended = initial({ status: 'ended', cursor: END });

    expect(playbackReducer(ended, { type: 'tick', elapsedMs: 10_000 })).toBe(ended);
  });

  it('play at the end replays from the start', () => {
    const ended = initial({ status: 'ended', cursor: END });
    const replay = playbackReducer(ended, { type: 'play' });

    expect(replay).toMatchObject({ status: 'playing', cursor: START });
  });
});

describe('playbackReducer — range changes', () => {
  it('keeps the playhead when it still falls inside the new range', () => {
    const state = initial({ cursor: START + 3 * DAY, status: 'paused' });
    const next = playbackReducer(state, {
      type: 'setRange',
      range: { start: START + DAY, end: START + 10 * DAY },
    });

    expect(next.cursor).toBe(START + 3 * DAY);
  });

  it('rewinds to the new start when the playhead falls outside', () => {
    const state = initial({ cursor: START + 3 * DAY, status: 'ended' });
    const next = playbackReducer(state, {
      type: 'setRange',
      range: { start: START + 10 * DAY, end: START + 20 * DAY },
    });

    expect(next).toMatchObject({ cursor: START + 10 * DAY, status: 'paused' });
  });
});

describe('gap skipping', () => {
  it('jumps the playhead across dead air to the next fix', () => {
    // One fix on day 0, the next ten days later — at 1h/s that is 240 seconds
    // of empty map.
    const state = initial({
      status: 'playing',
      cursor: START,
      stops: [START, START + 10 * DAY],
    });

    const ticked = playbackReducer(state, { type: 'tick', elapsedMs: 16 });

    expect(ticked.cursor).toBe(START + 10 * DAY);
  });

  it('leaves dense stretches alone so playback runs at the chosen speed', () => {
    const stops = [START, START + 60_000, START + 120_000];
    const state = initial({ status: 'playing', cursor: START, stops });

    const ticked = playbackReducer(state, { type: 'tick', elapsedMs: 1_000 });

    // The whole minute-apart run is inside one tick's reach, so nothing snaps.
    expect(ticked.cursor).toBe(START + HOUR);
  });

  it('does not skip when the viewer has turned skipping off', () => {
    const state = initial({
      status: 'playing',
      cursor: START,
      stops: [START, START + 10 * DAY],
      skipGaps: false,
    });

    const ticked = playbackReducer(state, { type: 'tick', elapsedMs: 1_000 });

    expect(ticked.cursor).toBe(START + HOUR);
  });

  it('runs straight to the end once no fixes remain', () => {
    const state = initial({ status: 'playing', cursor: START + DAY, stops: [START] });

    expect(playbackReducer(state, { type: 'tick', elapsedMs: 16 })).toMatchObject({
      status: 'ended',
      cursor: END,
    });
  });

  it('scales the skip threshold with speed, so a gap that matters at 1h/s does not at 7d/s', () => {
    const stops = [START, START + 6 * HOUR];

    expect(gapThresholdFor(1)).toBeLessThan(6 * HOUR);
    expect(gapThresholdFor(168)).toBeGreaterThan(6 * HOUR);

    expect(advanceCursor(initial({ speed: 1, stops, cursor: START }), 16)).toBe(START + 6 * HOUR);
    expect(advanceCursor(initial({ speed: 168, stops, cursor: START }), 16)).toBeLessThan(START + 6 * HOUR);
  });
});

describe('selectors', () => {
  it('stopsRevealed counts the fixes at or before the playhead', () => {
    const stops = [10, 20, 30, 40];

    expect(stopsRevealed(stops, 5)).toBe(0);
    expect(stopsRevealed(stops, 10)).toBe(1);
    expect(stopsRevealed(stops, 25)).toBe(2);
    expect(stopsRevealed(stops, 100)).toBe(4);
    expect(stopsRevealed([], 100)).toBe(0);
  });

  it('playbackProgress is 0 at the start, 1 at the end, and 0 for an empty range', () => {
    expect(playbackProgress(initial())).toBe(0);
    expect(playbackProgress(initial({ cursor: END }))).toBe(1);
    expect(playbackProgress(initial({ range: { start: START, end: START } }))).toBe(0);
  });

  it('isEmptyRange rejects inverted, zero-width and unresolved ranges', () => {
    expect(isEmptyRange({ start: START, end: END })).toBe(false);
    expect(isEmptyRange({ start: END, end: START })).toBe(true);
    expect(isEmptyRange({ start: START, end: START })).toBe(true);
    expect(isEmptyRange({ start: Number.NaN, end: END })).toBe(true);
  });

  it('formatSpeed names each rung of the ladder', () => {
    expect(formatSpeed(1)).toBe('1h/s');
    expect(formatSpeed(6)).toBe('6h/s');
    expect(formatSpeed(24)).toBe('1d/s');
    expect(formatSpeed(168)).toBe('1w/s');
  });
});
