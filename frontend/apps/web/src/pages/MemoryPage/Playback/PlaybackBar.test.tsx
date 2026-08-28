import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { PlaybackBar } from './PlaybackBar';
import type { PositionTrackPage, PositionTrackSource, TrackPoint } from './positionTrack';
import { PlaybackProvider, type PlaybackPin } from './usePlayback';

const DAY = 24 * 60 * 60 * 1000;
// LOCAL midnight, not UTC: the bar formats in the viewer's timezone, so a UTC
// fixture would assert a different calendar day depending on where CI runs.
const T0 = new Date(2024, 0, 1).getTime();

function pin(index: number): PlaybackPin {
  return { id: `pin-${index}`, coords: { lat: 37 + index * 0.01, lng: -122 }, sortTime: T0 + index * DAY };
}

function fixture(count: number): TrackPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    t: T0 + index * DAY,
    lat: 37 + index * 0.01,
    lng: -122,
    name: null,
  }));
}

function fakeSource(points: TrackPoint[]): PositionTrackSource {
  return {
    fetchPage: vi.fn(async (): Promise<PositionTrackPage> => ({ points, nextCursor: null })),
    fetchExtent: vi.fn(async () =>
      points.length > 0
        ? { start: points[0].t, end: points[points.length - 1].t, count: points.length }
        : null,
    ),
  };
}

function renderBar({
  points = fixture(5),
  pins = [pin(0), pin(4)],
  route = '/memory?view=map',
}: { points?: TrackPoint[]; pins?: PlaybackPin[]; route?: string } = {}) {
  const source = fakeSource(points);

  renderWithProviders(
    <PlaybackProvider args={[{ pins, source }]}>
      <PlaybackBar />
    </PlaybackProvider>,
    { route },
  );

  return source;
}

/** Resolve the extent read the bar gates on, so "still absent" means something. */
async function settleExtent(source: PositionTrackSource) {
  await waitFor(() => expect(source.fetchExtent).toHaveBeenCalled());
  await act(async () => {});
}

async function transport(): Promise<HTMLElement> {
  return waitFor(() => screen.getByRole('button', { name: /play back my life|pause playback|replay/i }));
}

describe('PlaybackBar', () => {
  beforeEach(() => {
    // The store drives itself off requestAnimationFrame; these tests act on the
    // transport, not on elapsed time, so a frame that never fires is fine.
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  it('renders nothing until the track extent has resolved', () => {
    renderBar();

    expect(screen.queryByRole('group', { name: 'Playback' })).toBeNull();
  });

  it('renders nothing when the range holds fewer than two stops', async () => {
    // A single dated pin with NO explicit filter would zero-width the range on
    // its own (pinExtent.start === pinExtent.end) and trip isEmptyRange for an
    // unrelated reason, passing this test even with the stop-count rule
    // deleted entirely. An explicit ?from/?to wider than the one pin keeps the
    // range genuinely non-empty, so "renders nothing" here can only be the
    // stopCount>1 clause — confirmed by deleting that clause locally and
    // watching this test fail while the isEmptyRange-only version would not.
    const from = new Date(T0).toISOString();
    const to = new Date(T0 + 3 * DAY).toISOString();
    const source = renderBar({
      points: [],
      pins: [pin(0)],
      route: `/memory?view=map&from=${from}&to=${to}`,
    });

    await settleExtent(source);

    expect(screen.queryByRole('group', { name: 'Playback' })).toBeNull();
  });

  it('shows the transport once there is something to play', async () => {
    renderBar();

    expect(await transport()).toHaveAccessibleName('Play back my life');
  });

  it('toggles between play and pause', async () => {
    renderBar();

    const button = await transport();

    fireEvent.click(button);
    expect(await transport()).toHaveAccessibleName('Pause playback');

    fireEvent.click(screen.getByRole('button', { name: 'Pause playback' }));
    expect(await transport()).toHaveAccessibleName('Play back my life');
  });

  it('offers no Stop until something has been played, then uses it to hand the map back', async () => {
    renderBar();
    await transport();

    expect(screen.queryByRole('button', { name: 'Stop playback' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Play back my life' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop playback' }));

    // Back to idle: the transport reads Play again and the Stop is gone, which
    // is what puts every pin back on the map (see useRevealedPins).
    expect(await transport()).toHaveAccessibleName('Play back my life');
    expect(screen.queryByRole('button', { name: 'Stop playback' })).toBeNull();
  });

  it('cycles the speed ladder', async () => {
    renderBar();
    await transport();

    const speed = screen.getByRole('button', { name: /Playback speed/ });

    expect(speed).toHaveTextContent('1h/s');

    fireEvent.click(speed);
    expect(screen.getByRole('button', { name: /Playback speed/ })).toHaveTextContent('6h/s');

    fireEvent.click(screen.getByRole('button', { name: /Playback speed/ }));
    expect(screen.getByRole('button', { name: /Playback speed/ })).toHaveTextContent('1d/s');
  });

  it('toggles gap skipping', async () => {
    renderBar();
    await transport();

    const skip = screen.getByRole('button', { name: 'Skip empty stretches' });

    expect(skip).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(skip);
    expect(screen.getByRole('button', { name: 'Skip empty stretches' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('does not let Space on a focused button hijack play/pause (WCAG 2.1.1)', async () => {
    renderBar();
    await transport();

    const skip = screen.getByRole('button', { name: 'Skip empty stretches' });

    skip.focus();
    // A real browser also fires 'click' when Space releases on a focused
    // button — jsdom does not synthesize that for us, so this only has to
    // prove our own handler stayed out of the way rather than pre-empting it.
    fireEvent.keyDown(skip, { key: ' ' });

    // Still 'Play back my life': the space bar shortcut must not have toggled
    // playback out from under the focused button.
    expect(await transport()).toHaveAccessibleName('Play back my life');
  });

  it('seeks with the keyboard and moves the read-out', async () => {
    renderBar();
    await transport();

    const scrubber = screen.getByRole('slider', { name: 'Playback position' }) as HTMLInputElement;

    expect(scrubber.value).toBe('0');

    // A scrub is a seek: the read-out has to follow the thumb, and playback
    // must not start just because the viewer dragged.
    fireEvent.change(scrubber, { target: { value: '500' } });

    await waitFor(() => {
      expect((screen.getByRole('slider', { name: 'Playback position' }) as HTMLInputElement).value).toBe(
        '500',
      );
    });
    expect(await transport()).toHaveAccessibleName('Play back my life');
    expect(screen.getByText(/Jan 3, 2024/)).toBeInTheDocument();
  });

  it('spans the position track when no date filter is applied', async () => {
    renderBar({ points: fixture(5) });
    await transport();

    // Five daily fixes from 2024-01-01: the bar's own end label is the last one.
    // Asserted against the whole bar because the playhead read-out sits on the
    // range start until something moves it, so the opening date appears twice.
    const bar = screen.getByRole('group', { name: 'Playback' });

    expect(bar).toHaveTextContent(/Jan 1, 2024/);
    expect(bar).toHaveTextContent(/Jan 5, 2024/);
  });

  it("reuses the explorer's ?from/?to filter as the playback range", async () => {
    const from = new Date(T0 + DAY).toISOString();
    const to = new Date(T0 + 3 * DAY).toISOString();

    renderBar({ route: `/memory?view=map&from=${from}&to=${to}` });
    await transport();

    const bar = screen.getByRole('group', { name: 'Playback' });

    expect(bar).toHaveTextContent(/Jan 2, 2024/);
    expect(bar).toHaveTextContent(/Jan 4, 2024/);
    // The filter, not the track, bounds the film: Jan 5 is loaded but unplayed.
    expect(bar).not.toHaveTextContent(/Jan 5, 2024/);
  });

  it('says so when it is playing located memories with no location trace', async () => {
    renderBar({ points: [], pins: [pin(0), pin(1), pin(2)] });
    await transport();

    expect(await screen.findByText(/No location trace in this range/)).toBeInTheDocument();
  });

  it('clears the home-indicator inset so the transport is not flush with the screen bottom', async () => {
    renderBar();
    await transport();

    expect(screen.getByRole('group', { name: 'Playback' })).toHaveClass(
      'bottom-[calc(0.75rem+var(--safe-area-bottom))]',
    );
  });
});
