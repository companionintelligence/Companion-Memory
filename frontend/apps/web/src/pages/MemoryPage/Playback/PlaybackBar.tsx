import { useCallback, useMemo, type KeyboardEvent } from 'react';

import { Button, Tooltip, cn } from '@ci/shadcn';
import { AlertTriangle, FastForward, Pause, Play, RotateCcw, Square } from '@ci/shadcn/icons';
import L from 'leaflet';

import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import type { DateTimeFormatter } from '@/lib/dateTimeFormat';

import { SPEEDS, formatSpeed, isEmptyRange, type PlaybackRange } from './playbackMachine';
import { usePlayback, usePlaybackControls, usePlaybackCursor } from './usePlayback';

import './playback.css';

/**
 * The transport for "play back my life".
 *
 * Deliberately NOT a second date filter. The range it scrubs is the explorer's
 * own `?from`/`?to` — set from the toolbar's date control or by dragging the
 * activity heatmap — so narrowing the film and narrowing the search are the
 * same gesture, and a shared URL replays exactly the stretch it searched. The
 * bar reads that range; it never writes it.
 *
 * The scrubber works in thousandths of the range rather than in epoch
 * milliseconds. A range input whose min and max are 2013 and 2026 in
 * milliseconds spans 4×10^11 steps; browsers quantise that, so the thumb would
 * snap to values the playhead never sits on and dragging would feel notched.
 * A thousand steps over thirteen years is ~4.8 days a step, which is the right
 * grain for a drag — the transport and the keyboard cover finer movement.
 */

/** Scrubber resolution. 1,000 steps over a 13-year range is about 4.8 days a step. */
const SCRUB_STEPS = 1_000;

export function PlaybackBar({ className }: { className?: string } = {}) {
  const { store, loading, error, retry, hasTrack, ready } = usePlayback();
  const { status, speed, range, skipGaps, stopCount } = usePlaybackControls();
  const cursor = usePlaybackCursor();
  const fmt = useDateTimeFormat();

  // Leaflet would otherwise treat a drag on the scrubber as a map pan and a
  // wheel over the bar as a zoom.
  const setContainerRef = useCallback((element: HTMLDivElement | null) => {
    if (element) {
      L.DomEvent.disableClickPropagation(element);
      L.DomEvent.disableScrollPropagation(element);
    }
  }, []);

  // `stopCount` alone is a circular gate: `stops` only gains position-fix
  // times once the transport has already been used once (see `armed` in
  // usePlayback.tsx), so BEFORE that, stopCount is just the count of dated
  // pins in range — and live data shows only 32 of 582 days with a real GPS
  // trace have two or more located events. `hasTrack` is resolved from the
  // extent read independently of arming, so it is the alternative path: a day
  // with a real position trace but few or no located events still gets a
  // working playback control.
  const playable = !isEmptyRange(range) && (stopCount > 1 || hasTrack);

  const scrubValue = useMemo(() => {
    if (isEmptyRange(range)) {
      return 0;
    }

    return Math.round(((cursor - range.start) / (range.end - range.start)) * SCRUB_STEPS);
  }, [cursor, range]);

  const onScrub = useCallback(
    (value: number) => {
      store.dispatch({ type: 'seek', to: timeAt(range, value / SCRUB_STEPS) });
    },
    [store, range],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // Only the bar's own keys, and only when the focus is genuinely inside it
      // — the Radix slider thumb already owns arrow keys for fine seeking.
      if (event.key !== ' ' && event.key !== 'k') {
        return;
      }

      // Space is ALSO how a focused <button> activates itself — Speed, Skip
      // empty stretches, Stop and Retry all live in here. Hijacking it
      // unconditionally (WCAG 2.1.1) meant pressing Space on any of those
      // toggled playback instead of pressing the button underneath the
      // viewer's focus. Letting the native activation through does not lose
      // the shortcut for the transport button itself: it is a <button> too,
      // so Space still reaches it via its own onClick.
      if (event.key === ' ' && event.target instanceof HTMLElement && event.target.closest('button')) {
        return;
      }

      event.preventDefault();
      store.dispatch({ type: 'toggle' });
    },
    [store],
  );

  if (!ready || !playable) {
    return null;
  }

  const ended = status === 'ended';
  const playing = status === 'playing';

  return (
    <div
      ref={setContainerRef}
      onKeyDown={onKeyDown}
      role="group"
      aria-label="Playback"
      className={cn(
        'pointer-events-auto absolute inset-x-3 z-400 rounded-lg border border-border bg-card/95 px-3 py-2 shadow-lg backdrop-blur',
        'bottom-[calc(0.75rem+var(--safe-area-bottom))]',
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <Tooltip.Provider>
          <Tooltip delayDuration={600}>
            <Tooltip.Content side="top">{ended ? 'Replay' : playing ? 'Pause' : 'Play'}</Tooltip.Content>
            <Tooltip.Trigger asChild>
              <Button
                type="button"
                size="icon"
                variant={playing ? 'default' : 'outline'}
                aria-label={ended ? 'Replay' : playing ? 'Pause playback' : 'Play back my life'}
                onClick={() => store.dispatch({ type: 'toggle' })}
              >
                {ended ? <RotateCcw /> : playing ? <Pause /> : <Play />}
              </Button>
            </Tooltip.Trigger>
          </Tooltip>

          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {/* A native range input rather than the Radix Slider used elsewhere,
                for two reasons specific to this control. It is re-rendered five
                times a second for the whole length of a playback, so the
                cheapest possible element wins; and the accessible name and
                `aria-valuetext` belong on the thumb, which is the element the
                native input already is (Radix's thumb is a separate node our
                wrapper does not forward labels to, leaving the scrubber
                unnamed). */}
            <input
              type="range"
              className="memory-playback-scrub"
              value={scrubValue}
              min={0}
              max={SCRUB_STEPS}
              step={1}
              onChange={(event) => onScrub(Number(event.target.value))}
              aria-label="Playback position"
              aria-valuetext={formatMoment(cursor, fmt)}
            />

            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums">{formatMoment(range.start, fmt)}</span>
              <span
                // Live region, but polite and only announced at the resolution
                // usePlaybackCursor samples at — a per-frame aria-live would be
                // unusable with a screen reader.
                aria-live="polite"
                className="truncate font-medium text-foreground tabular-nums"
              >
                {formatMoment(cursor, fmt)}
              </span>
              <span className="tabular-nums">{formatMoment(range.end, fmt)}</span>
            </div>
          </div>

          <Tooltip delayDuration={600}>
            <Tooltip.Content side="top">Playback speed</Tooltip.Content>
            <Tooltip.Trigger asChild>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-16 tabular-nums"
                aria-label={`Playback speed: ${formatSpeed(speed)}`}
                onClick={() => store.dispatch({ type: 'setSpeed', speed: nextSpeed(speed) })}
              >
                {formatSpeed(speed)}
              </Button>
            </Tooltip.Trigger>
          </Tooltip>

          <Tooltip delayDuration={600}>
            <Tooltip.Content side="top">
              {skipGaps ? 'Skipping days with nothing recorded' : 'Playing every empty hour'}
            </Tooltip.Content>
            <Tooltip.Trigger asChild>
              <Button
                type="button"
                size="icon"
                variant={skipGaps ? 'default' : 'outline'}
                aria-label="Skip empty stretches"
                aria-pressed={skipGaps}
                onClick={() => store.dispatch({ type: 'setSkipGaps', skipGaps: !skipGaps })}
              >
                <FastForward />
              </Button>
            </Tooltip.Trigger>
          </Tooltip>

          {/* The way out. Without it a viewer who pressed play once would be
              left on a map that only ever shows the pins the playhead has
              passed — every other control moves the playhead, none of them
              hands the map back. Stop returns the view to `idle`, which is
              where every pin is on the map and the camera is the viewer's
              again. */}
          {status !== 'idle' && (
            <Tooltip delayDuration={600}>
              <Tooltip.Content side="top">Stop and show every pin again</Tooltip.Content>
              <Tooltip.Trigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  aria-label="Stop playback"
                  onClick={() => store.dispatch({ type: 'reset' })}
                >
                  <Square />
                </Button>
              </Tooltip.Trigger>
            </Tooltip>
          )}
        </Tooltip.Provider>
      </div>

      {/* One line of provenance, because a fly-through over 121 located photos
          and one over 63,044 GPS fixes look similar and mean very different
          things. */}
      {(error || !hasTrack || loading) && (
        <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          {error ? (
            <>
              <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
              <span className="truncate">{error}</span>
              <Button type="button" size="sm" variant="ghost" className="h-6 px-2" onClick={retry}>
                Retry
              </Button>
            </>
          ) : loading ? (
            <span>Loading your location history…</span>
          ) : (
            <span>No location trace in this range — playing your located memories only.</span>
          )}
        </div>
      )}
    </div>
  );
}

function nextSpeed(speed: number): number {
  const index = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);

  return SPEEDS[(index + 1) % SPEEDS.length];
}

function timeAt(range: PlaybackRange, fraction: number): number {
  return range.start + (range.end - range.start) * fraction;
}

/**
 * The playhead as a date. Matches the map cluster popup's format so the two
 * read as the same clock.
 */
function formatMoment(time: number, fmt: DateTimeFormatter): string {
  if (!Number.isFinite(time)) {
    return '—';
  }

  return fmt.dateTime(
    time,
    {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    },
    'en-US',
  );
}
