import { MockedProvider } from '@apollo/client/testing';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PositionTrackSource } from './positionTrack';
import {
  PlaybackProvider,
  usePlayback,
  usePlayheadPin,
  useRevealedPins,
  type PlaybackPin,
} from './usePlayback';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date(2024, 0, 1).getTime();

const PINS: PlaybackPin[] = [0, 1, 2, 3].map((index) => ({
  id: `pin-${index}`,
  coords: { lat: 37 + index, lng: -122 },
  sortTime: T0 + index * DAY,
}));

const SOURCE: PositionTrackSource = {
  fetchPage: async () => ({ points: [], nextCursor: null }),
  fetchExtent: async () => ({ start: T0, end: T0 + 3 * DAY, count: 4 }),
};

/**
 * The two halves of the synchronised cursor read through one hook, so a test
 * can assert that the same playhead drives the map's reveal and the timeline's
 * highlight.
 */
function useSyncHarness() {
  const { store } = usePlayback();

  return { store, revealed: useRevealedPins(PINS), playhead: usePlayheadPin(PINS) };
}

function renderSync() {
  return renderHook(useSyncHarness, {
    // usePlaybackController now calls useApolloClient() unconditionally (to
    // build the default GraphQL track source when no `source` is given) —
    // every test here passes its own SOURCE and never touches the client,
    // but the hook still needs *a* client in context to render at all.
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={['/memory?view=map']}>
        <MockedProvider mocks={[]}>
          <PlaybackProvider args={[{ pins: PINS, source: SOURCE }]}>{children}</PlaybackProvider>
        </MockedProvider>
      </MemoryRouter>
    ),
  });
}

describe('playback ↔ map/timeline synchronisation', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  it('shows every pin while the transport is untouched', async () => {
    const { result } = renderSync();

    await waitFor(() => expect(result.current.store.getControlSnapshot().stopCount).toBe(4));

    expect(result.current.revealed).toHaveLength(4);
    expect(result.current.playhead).toBeNull();
  });

  it('reveals only the pins the playhead has passed once playback starts', async () => {
    const { result } = renderSync();

    await waitFor(() => expect(result.current.store.getControlSnapshot().stopCount).toBe(4));

    act(() => result.current.store.dispatch({ type: 'seek', to: T0 + 1.5 * DAY }));

    await waitFor(() => expect(result.current.revealed).toHaveLength(2));
    expect(result.current.revealed.map((pin) => pin.id)).toEqual(['pin-0', 'pin-1']);
  });

  it('points the timeline at the memory the playhead has just reached', async () => {
    const { result } = renderSync();

    await waitFor(() => expect(result.current.store.getControlSnapshot().stopCount).toBe(4));

    act(() => result.current.store.dispatch({ type: 'seek', to: T0 + 2 * DAY }));
    await waitFor(() => expect(result.current.playhead?.id).toBe('pin-2'));

    act(() => result.current.store.dispatch({ type: 'seek', to: T0 + 3 * DAY }));
    await waitFor(() => expect(result.current.playhead?.id).toBe('pin-3'));
  });

  it('the map reveal and the timeline highlight always agree', async () => {
    const { result } = renderSync();

    await waitFor(() => expect(result.current.store.getControlSnapshot().stopCount).toBe(4));

    for (const index of [0, 1, 2, 3]) {
      act(() => result.current.store.dispatch({ type: 'seek', to: T0 + index * DAY }));

      await waitFor(() => expect(result.current.revealed).toHaveLength(index + 1));
      // The highlighted row is the last revealed pin — one cursor, two surfaces.
      expect(result.current.playhead?.id).toBe(result.current.revealed[index].id);
    }
  });

  it('keeps the revealed array identity between reveals, so the map does not re-cluster', async () => {
    const { result } = renderSync();

    await waitFor(() => expect(result.current.store.getControlSnapshot().stopCount).toBe(4));

    act(() => result.current.store.dispatch({ type: 'seek', to: T0 + DAY }));
    await waitFor(() => expect(result.current.revealed).toHaveLength(2));

    const first = result.current.revealed;

    // A seek that moves the playhead but crosses no pin must not produce a new
    // array — that identity is what keeps the clustering pass from re-running.
    act(() => result.current.store.dispatch({ type: 'seek', to: T0 + 1.9 * DAY }));

    expect(result.current.revealed).toBe(first);
  });

  it('goes back to showing everything when playback is reset', async () => {
    const { result } = renderSync();

    await waitFor(() => expect(result.current.store.getControlSnapshot().stopCount).toBe(4));

    act(() => result.current.store.dispatch({ type: 'seek', to: T0 }));
    await waitFor(() => expect(result.current.revealed).toHaveLength(1));

    act(() => result.current.store.dispatch({ type: 'reset' }));

    await waitFor(() => expect(result.current.revealed).toHaveLength(4));
    expect(result.current.playhead).toBeNull();
  });
});
